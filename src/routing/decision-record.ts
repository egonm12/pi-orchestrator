// Ticket 25: the decision record (stories 28, 32 and 34).
//
// One append-only JSON line per routing decision, one file per UTC day,
// `<folder>/<YYYY-MM-DD>.jsonl`. The folder is injected; the harness default
// is `src/state/routing` (git-ignored runtime state, like ticket 08's
// refresh state). Verdicts attached later (./verdicts.ts) are further lines in
// the same day files, so the folder holds every routing fact and nothing else.
//
// The writer copies each field it records by name from the values it is
// given: ticket 23's classification, ticket 22's resolved tier map, ticket
// 24's router decision, and the delegation facts (delegation id, mode, task text,
// agent role, the model the worker ran on, and the hand-picked model in
// shadow mode). Nothing else an input object carries (a parsed settings file,
// a token) can reach the file.
//
// Free text (task text, the classifier's `why` and reasons, hop details,
// route messages, removal and drop reasons, skipped-rung details) passes one
// function, `recordSafeCopy`, on every write path: credential-shaped
// substrings become `[redacted]` (best effort, see `CREDENTIAL_PATTERNS`),
// then task text is cut to its first 200 characters and every other free-text
// field to 500. The limits are checked again on read.
//
// Every record is validated on write and on read: a missing or unknown field,
// at the top level or inside the classification, tier map or route, fails
// with the field named. The auto provider (../router/auto-provider.ts) writes
// one decision record per worker's first request.
//
// This module imports no other harness module at run time except the tier
// list, so the report CLI that reads records loads nothing else.

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RISK_TIERS, type ClassificationSignal, type RiskTier } from "./classifier.ts";
import type { HopOutcome, TierClassification } from "./tier-classifier.ts";
import type { ResolvedTierMap, TierMapDrop, TierRung } from "./tier-map.ts";
import type { LadderSkippedRung } from "./effort-ladder.ts";
import { LADDER_SKIP_REASONS } from "./skip-reasons.ts";
import type { RemovedRung, TierRouteDecision } from "./tier-router.ts";

export const DECISION_RECORD_SCHEMA_VERSION = "decision-record/3";
/** Only for reading old records, including the explicit records no longer written. */
export const LEGACY_DECISION_RECORD_SCHEMA_VERSION = "decision-record/2";

/** Records hold at most this many characters of task text (story 34). */
export const TASK_TEXT_PREFIX_LIMIT = 200;

/** Every other free-text field holds at most this many characters. */
export const FREE_TEXT_LIMIT = 500;

export const REDACTED = "[redacted]";

/**
 * Credential-shaped text, replaced by `[redacted]` in every free-text field
 * before it is cut to its limit and written (story 34). Best effort: a
 * pattern list, not a secret scanner. It catches `Authorization:` headers,
 * `Bearer` tokens, `sk-` and `sk-ant-` style API keys, and `<name>=<value>` or
 * `<name>: <value>` where the name ends in key, token, secret, password or
 * passwd (`api_key`, `ACCESS_TOKEN`, `apikey`). A credential in any other
 * shape is written as it is, within the field's limit. The key/value pattern
 * starts at the key word, not at the start of the name, so a long unbroken
 * `a-b-c` run costs linear time rather than quadratic; the name before the key
 * word is left as it is either way. The closing quote of a quoted value is
 * optional, so a value that is never closed, or closes past the redaction
 * window, is redacted to the end of the window.
 */
const CREDENTIAL_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/\bAuthorization\s*:\s*(?:(?:Bearer|Basic|Token)\s+)?[^\s,;]+/gi, `Authorization: ${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
  [/((?:key|token|secret|password|passwd)["']?\s*[:=]\s*)(?:"[^"]*"?|'[^']*'?|[^\s,;"'}]+)/gi, `$1${REDACTED}`],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{8,}/g, REDACTED],
];

/** How far past a field's limit redaction still reads, so a credential that
 *  starts inside the limit is matched whole while redaction cost stays bounded
 *  however long the input is. */
const REDACTION_WINDOW_MARGIN = 1_000;

/** Credential-shaped substrings replaced, then cut to `limit` characters.
 *  Only the first `limit + REDACTION_WINDOW_MARGIN` characters are read. When
 *  the window cuts a word that starts at or past `limit`, that partial word is
 *  dropped first, so a cut key too short to match (`sk-proj`) cannot slide
 *  into the kept text once a long value before it shrinks to `[redacted]`. A
 *  word that starts inside the limit is kept, as it belongs in the output. */
export function recordSafeText(text: string, limit: number = FREE_TEXT_LIMIT): string {
  let safe = text.slice(0, limit + REDACTION_WINDOW_MARGIN);
  if (text.length > safe.length) {
    let cutWordStart = safe.length;
    while (cutWordStart > 0 && /\S/.test(safe[cutWordStart - 1]!)) cutWordStart -= 1;
    if (cutWordStart >= limit) safe = safe.slice(0, cutWordStart);
  }
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) safe = safe.replace(pattern, replacement);
  return safe.slice(0, limit);
}

/** Every free-text field of every record type and its limit, as a path of
 *  keys with `[]` for each array item. Nothing else in a record is prose: the
 *  rest are enums, ids, rung names, times and numbers. */
const FREE_TEXT_FIELDS: readonly (readonly [path: readonly string[], limit: number])[] = [
  [["taskTextPrefix"], TASK_TEXT_PREFIX_LIMIT],
  [["classification", "why"], FREE_TEXT_LIMIT],
  [["classification", "risk", "reasons", "[]"], FREE_TEXT_LIMIT],
  [["classification", "floorSignals", "[]", "matched"], FREE_TEXT_LIMIT],
  [["classification", "hops", "[]", "detail"], FREE_TEXT_LIMIT],
  [["tierMap", "drops", "[]", "reason"], FREE_TEXT_LIMIT],
  [["route", "message"], FREE_TEXT_LIMIT],
  [["route", "allowanceApplied"], FREE_TEXT_LIMIT],
  [["route", "removed", "[]", "detail"], FREE_TEXT_LIMIT],
  [["skipped", "[]", "detail"], FREE_TEXT_LIMIT],
];

/** A copy with `change` applied to the string at `keys`; anything that is not
 *  there, or not of the expected shape, is left for validation to name. */
function mapTextAt(value: unknown, keys: readonly string[], change: (text: string) => string): unknown {
  if (keys.length === 0) return typeof value === "string" ? change(value) : value;
  const [key, ...rest] = keys as [string, ...string[]];
  if (key === "[]") return Array.isArray(value) ? value.map((item) => mapTextAt(item, rest, change)) : value;
  if (!isObject(value) || !Object.hasOwn(value, key)) return value;
  return { ...value, [key]: mapTextAt(value[key], rest, change) };
}

/** The one place a record's free text is made safe to keep: every writer
 *  (decision, explicit, effort-ladder and verdict records) passes through it
 *  before validation and before the append. */
function recordSafeCopy<T>(record: T): T {
  let safe: unknown = record;
  for (const [path, limit] of FREE_TEXT_FIELDS) safe = mapTextAt(safe, path, (text) => recordSafeText(text, limit));
  return safe as T;
}

function checkFreeTextLimits(value: unknown, keys: readonly string[], limit: number, path: string): void {
  if (keys.length === 0) {
    if (typeof value === "string" && value.length > limit) {
      throw new RoutingRecordError(path, `holds ${value.length} characters; at most ${limit} are recorded`);
    }
    return;
  }
  const [key, ...rest] = keys as [string, ...string[]];
  if (key === "[]") {
    if (Array.isArray(value)) value.forEach((item, index) => checkFreeTextLimits(item, rest, limit, `${path}[${index}]`));
    return;
  }
  if (isObject(value)) checkFreeTextLimits(value[key], rest, limit, joinField(path, key));
}

/** Runtime state, not source: git-ignored under `src/state/`. */
export const DEFAULT_ROUTING_RECORD_DIR = "src/state/routing";

export const ROUTING_MODES = ["shadow", "live"] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

/** The reviewer's verdict as recorded. `missing` is a review that returned no
 *  structured verdict; it is never guessed from prose. */
export const VERDICTS = ["accept", "request_changes", "missing"] as const;
export type Verdict = (typeof VERDICTS)[number];

// ---------------------------------------------------------------------------
// The record shapes
// ---------------------------------------------------------------------------

export interface RecordedRung {
  readonly rung: string;
  readonly model: string;
  readonly effort: string;
  readonly origin: string;
}

export interface RecordedHop {
  readonly hop: string;
  readonly outcome: string;
  readonly detail?: string;
  readonly allowance?: { readonly reservationId: string; readonly settlement: string };
}

export interface RecordedClassification {
  readonly tier: RiskTier;
  /** The deciding hop: `model:<rung>` or `keywords`. */
  readonly cause: string;
  readonly modelTier?: RiskTier;
  readonly floor: string;
  readonly floorTier?: RiskTier;
  readonly floorSignals: readonly ClassificationSignal[];
  readonly risk: { readonly level: string; readonly reasons: readonly string[] };
  readonly ambiguity: string;
  readonly complexity: string;
  readonly kindOfWork: string;
  readonly why: string;
  readonly rubricVersion: string;
  readonly schemaVersion: string;
  readonly hops: readonly RecordedHop[];
}

export interface RecordedTierMap {
  readonly tiers: Readonly<Record<RiskTier, readonly RecordedRung[]>>;
  readonly drops: readonly TierMapDrop[];
  readonly ignoredProjectKeys: readonly string[];
}

export type RecordedRemovedRung = RemovedRung;

interface RecordedRouteCommon {
  readonly startedAtTier: RiskTier;
  readonly tiersTried: readonly RiskTier[];
  readonly removed: readonly RecordedRemovedRung[];
  readonly allowanceApplied: string;
}

export interface RecordedRouteChoice extends RecordedRouteCommon {
  readonly outcome: "chosen";
  readonly tier: RiskTier;
  readonly rung: RecordedRung;
  readonly survivors: readonly RecordedRung[];
}

export interface RecordedRouteRefusal extends RecordedRouteCommon {
  readonly outcome: "refused";
  readonly code: string;
  readonly message: string;
}

export type RecordedRoute = RecordedRouteChoice | RecordedRouteRefusal;

interface RecordCommon {
  readonly schemaVersion: string;
  /** Ticket 18's delegation id: the key verdicts attach by. */
  readonly delegationId: string;
  /** ISO-8601, UTC. */
  readonly timestamp: string;
}

export interface DecisionRecord extends RecordCommon {
  readonly recordType: "decision";
  readonly mode: RoutingMode;
  readonly taskTextPrefix: string;
  readonly agentRole: string;
  readonly classification: RecordedClassification;
  readonly tierMap: RecordedTierMap;
  readonly route: RecordedRoute;
  /** The rung in live mode, or the model the worker ran on in shadow mode or on refusal. Absent on /2 records. */
  readonly ranOn?: string;
  /** Shadow mode only: the model the orchestrator named by hand. */
  readonly handPickedModel?: string;
}

export interface VerdictRecord extends RecordCommon {
  readonly recordType: "verdict";
  readonly verdict: Verdict;
  /** The day file holding the decision this verdict is attached to. */
  readonly decisionFile: string;
}

/** A verdict whose delegation id matches no decision in the folder. Kept, not
 *  dropped (story 32), and counted by the report. */
export interface OrphanedVerdictRecord extends RecordCommon {
  readonly recordType: "orphaned-verdict";
  readonly verdict: Verdict;
}

export interface EffortLadderRecord extends RecordCommon {
  readonly recordType: "effort-ladder";
  readonly skipped: readonly LadderSkippedRung[];
  readonly cause: "effort-ladder";
  readonly previousDecisionId: string;
  readonly step: "effort" | "same-tier" | "next-tier";
  readonly mode: "live";
  readonly taskTextPrefix: string;
  readonly agentRole: string;
  readonly kindOfWork: string;
  readonly tierMap: RecordedTierMap;
  readonly route: RecordedRouteChoice;
}

/** Ticket 27: a delegation slot that named its own model, which the retired
 *  `subagent` call rewriting left alone. The router extension no longer
 *  writes it; readers keep accepting it. A legacy record type under
 *  `decision-record/2`, with a top-level `cause` as the ladder record has. It
 *  is not a routing decision: it has no tier and no rung, so it is not a
 *  report row and `isRoutedDecision` does not accept it. */
export interface ExplicitModelRecord extends RecordCommon {
  readonly recordType: "explicit";
  readonly cause: "explicit";
  readonly mode: RoutingMode;
  /** Where the call named the model: `model`, `tasks[1].model`, ... */
  readonly slot: string;
  /** The model as the call named it. */
  readonly model: string;
  readonly taskTextPrefix: string;
  readonly agentRole: string;
}

export type RoutedDecisionRecord = DecisionRecord | EffortLadderRecord;
export type RoutingRecord = RoutedDecisionRecord | ExplicitModelRecord | VerdictRecord | OrphanedVerdictRecord;

/** A record a verdict can attach to: a ticket 25 decision or a ladder climb. */
export function isRoutedDecision(record: RoutingRecord): record is RoutedDecisionRecord {
  return record.recordType === "decision" || record.recordType === "effort-ladder";
}

// ---------------------------------------------------------------------------
// Validation: every field named
// ---------------------------------------------------------------------------

export class RoutingRecordError extends Error {
  readonly field: string;
  readonly problem: string;
  constructor(field: string, problem: string, location?: string) {
    super(`routing record${location === undefined ? "" : ` ${location}`}: field '${field}' ${problem}`);
    this.name = "RoutingRecordError";
    this.field = field;
    this.problem = problem;
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinField(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/** Exactly the required keys plus any of the optional ones. */
function checkKeys(value: Json, path: string, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new RoutingRecordError(joinField(path, key), "is missing");
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new RoutingRecordError(joinField(path, key), "is not a known field");
  }
}

function objectAt(parent: Json, key: string, path: string): Json {
  const value = parent[key];
  if (!isObject(value)) throw new RoutingRecordError(joinField(path, key), `must be an object; got ${JSON.stringify(value)}`);
  return value;
}

function arrayAt(parent: Json, key: string, path: string): unknown[] {
  const value = parent[key];
  if (!Array.isArray(value)) throw new RoutingRecordError(joinField(path, key), `must be an array; got ${JSON.stringify(value)}`);
  return value;
}

function stringAt(parent: Json, key: string, path: string, options: { readonly nonBlank?: boolean } = {}): string {
  const value = parent[key];
  if (typeof value !== "string" || (options.nonBlank === true && value.trim().length === 0)) {
    throw new RoutingRecordError(joinField(path, key), `must be a${options.nonBlank ? " non-blank" : ""} string; got ${JSON.stringify(value)}`);
  }
  return value;
}

function oneOf<T extends string>(parent: Json, key: string, path: string, allowed: readonly T[]): T {
  const value = parent[key];
  if (!allowed.includes(value as T)) {
    throw new RoutingRecordError(joinField(path, key), `must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function eachObject(parent: Json, key: string, path: string, check: (item: Json, itemPath: string) => void): void {
  arrayAt(parent, key, path).forEach((item, index) => {
    const itemPath = `${joinField(path, key)}[${index}]`;
    if (!isObject(item)) throw new RoutingRecordError(itemPath, `must be an object; got ${JSON.stringify(item)}`);
    check(item, itemPath);
  });
}

function checkStrings(parent: Json, key: string, path: string): void {
  arrayAt(parent, key, path).forEach((item, index) => {
    if (typeof item !== "string") throw new RoutingRecordError(`${joinField(path, key)}[${index}]`, `must be a string; got ${JSON.stringify(item)}`);
  });
}

function checkTierList(parent: Json, key: string, path: string): void {
  arrayAt(parent, key, path).forEach((item, index) => {
    if (!RISK_TIERS.includes(item as RiskTier)) {
      throw new RoutingRecordError(`${joinField(path, key)}[${index}]`, `must be one of ${RISK_TIERS.join(", ")}; got ${JSON.stringify(item)}`);
    }
  });
}

const RUNG_KEYS = ["rung", "model", "effort", "origin"] as const;

function checkRung(rung: Json, path: string): void {
  checkKeys(rung, path, RUNG_KEYS);
  for (const key of RUNG_KEYS) stringAt(rung, key, path, { nonBlank: true });
}

function checkClassification(record: Json): void {
  const path = "classification";
  const value = objectAt(record, path, "");
  checkKeys(
    value,
    path,
    ["tier", "cause", "floor", "floorSignals", "risk", "ambiguity", "complexity", "kindOfWork", "why", "rubricVersion", "schemaVersion", "hops"],
    ["modelTier", "floorTier"],
  );
  oneOf(value, "tier", path, RISK_TIERS);
  if (value.modelTier !== undefined) oneOf(value, "modelTier", path, RISK_TIERS);
  if (value.floorTier !== undefined) oneOf(value, "floorTier", path, RISK_TIERS);
  for (const key of ["cause", "floor", "ambiguity", "complexity", "kindOfWork", "rubricVersion", "schemaVersion"]) {
    stringAt(value, key, path, { nonBlank: true });
  }
  stringAt(value, "why", path);
  eachObject(value, "floorSignals", path, (signal, signalPath) => {
    checkKeys(signal, signalPath, ["kind", "label", "matched"]);
  });
  const risk = objectAt(value, "risk", path);
  checkKeys(risk, `${path}.risk`, ["level", "reasons"]);
  stringAt(risk, "level", `${path}.risk`, { nonBlank: true });
  checkStrings(risk, "reasons", `${path}.risk`);
  eachObject(value, "hops", path, (hop, hopPath) => {
    checkKeys(hop, hopPath, ["hop", "outcome"], ["detail", "allowance"]);
    stringAt(hop, "hop", hopPath, { nonBlank: true });
    stringAt(hop, "outcome", hopPath, { nonBlank: true });
    if (hop.allowance !== undefined) checkKeys(objectAt(hop, "allowance", hopPath), `${hopPath}.allowance`, ["reservationId", "settlement"]);
  });
}

function checkTierMap(record: Json): void {
  const path = "tierMap";
  const value = objectAt(record, path, "");
  checkKeys(value, path, ["tiers", "drops", "ignoredProjectKeys"]);
  const tiers = objectAt(value, "tiers", path);
  checkKeys(tiers, `${path}.tiers`, RISK_TIERS);
  for (const tier of RISK_TIERS) eachObject(tiers, tier, `${path}.tiers`, checkRung);
  eachObject(value, "drops", path, (drop, dropPath) => {
    checkKeys(drop, dropPath, ["tier", "origin", "reason"], ["rung"]);
    oneOf(drop, "tier", dropPath, RISK_TIERS);
  });
  checkStrings(value, "ignoredProjectKeys", path);
}

function checkRoute(record: Json): void {
  const path = "route";
  const value = objectAt(record, path, "");
  const outcome = oneOf(value, "outcome", path, ["chosen", "refused"] as const);
  const common = ["outcome", "startedAtTier", "tiersTried", "removed", "allowanceApplied"];
  if (outcome === "chosen") {
    checkKeys(value, path, [...common, "tier", "rung", "survivors"]);
    oneOf(value, "tier", path, RISK_TIERS);
    checkRung(objectAt(value, "rung", path), `${path}.rung`);
    eachObject(value, "survivors", path, checkRung);
  } else {
    checkKeys(value, path, [...common, "code", "message"]);
    stringAt(value, "code", path, { nonBlank: true });
    stringAt(value, "message", path, { nonBlank: true });
  }
  oneOf(value, "startedAtTier", path, RISK_TIERS);
  checkTierList(value, "tiersTried", path);
  stringAt(value, "allowanceApplied", path);
  eachObject(value, "removed", path, (removed, removedPath) => {
    checkKeys(removed, removedPath, ["tier", "rung", "model", "reason", "detail"]);
    oneOf(removed, "tier", removedPath, RISK_TIERS);
  });
}

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const COMMON_KEYS = ["recordType", "schemaVersion", "delegationId", "timestamp"] as const;

/** First of all checks: a record of another version may have other fields
 *  and record types, so the version is reported before anything else. */
function checkSchemaVersion(record: Json): void {
  if (record.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION && record.schemaVersion !== LEGACY_DECISION_RECORD_SCHEMA_VERSION) {
    throw new RoutingRecordError(
      "schemaVersion",
      `is unsupported: must be ${LEGACY_DECISION_RECORD_SCHEMA_VERSION} or ${DECISION_RECORD_SCHEMA_VERSION}; got ${JSON.stringify(record.schemaVersion)}`,
    );
  }
}

function checkCommon(record: Json): void {
  stringAt(record, "delegationId", "", { nonBlank: true });
  const timestamp = stringAt(record, "timestamp", "", { nonBlank: true });
  if (Number.isNaN(Date.parse(timestamp))) throw new RoutingRecordError("timestamp", `must be an ISO-8601 time; got ${JSON.stringify(timestamp)}`);
}

/** Throws `RoutingRecordError` naming the first missing, unknown or malformed
 *  field; returns the record typed when it is valid. */
export function validateRoutingRecord(value: unknown): RoutingRecord {
  if (!isObject(value)) throw new RoutingRecordError("(record)", `must be a JSON object; got ${JSON.stringify(value)}`);
  checkSchemaVersion(value);
  const recordType = oneOf(value, "recordType", "", ["decision", "effort-ladder", "explicit", "verdict", "orphaned-verdict"] as const);
  if (value.schemaVersion === DECISION_RECORD_SCHEMA_VERSION && recordType === "explicit") {
    throw new RoutingRecordError("schemaVersion", `is unsupported for ${recordType} records`);
  }
  if (recordType === "decision") {
    const mode = oneOf(value, "mode", "", ROUTING_MODES);
    const required = [...COMMON_KEYS, "mode", "taskTextPrefix", "agentRole", "classification", "tierMap", "route",
      ...(value.schemaVersion === DECISION_RECORD_SCHEMA_VERSION ? ["ranOn"] : [])];
    checkKeys(value, "", mode === "shadow" ? [...required, "handPickedModel"] : required);
    checkCommon(value);
    stringAt(value, "taskTextPrefix", "");
    stringAt(value, "agentRole", "", { nonBlank: true });
    if (mode === "shadow") stringAt(value, "handPickedModel", "", { nonBlank: true });
    if (value.schemaVersion === DECISION_RECORD_SCHEMA_VERSION) stringAt(value, "ranOn", "", { nonBlank: true });
    checkClassification(value);
    checkTierMap(value);
    checkRoute(value);
  } else if (recordType === "effort-ladder") {
    checkKeys(value, "", [...COMMON_KEYS, "cause", "previousDecisionId", "step", "mode", "taskTextPrefix", "agentRole", "kindOfWork", "tierMap", "route", "skipped"]);
    checkCommon(value);
    eachObject(value, "skipped", "", (entry, path) => {
      checkKeys(entry, path, ["tier", "rung", "model", "reason", "detail"]);
      oneOf(entry, "tier", path, RISK_TIERS);
      oneOf(entry, "reason", path, LADDER_SKIP_REASONS);
      for (const key of ["rung", "model", "detail"]) stringAt(entry, key, path, { nonBlank: true });
    });
    oneOf(value, "cause", "", ["effort-ladder"]);
    oneOf(value, "step", "", ["effort", "same-tier", "next-tier"]);
    oneOf(value, "mode", "", ["live"]);
    for (const key of ["previousDecisionId", "agentRole", "kindOfWork"]) stringAt(value, key, "", { nonBlank: true });
    if (value.previousDecisionId === value.delegationId) throw new RoutingRecordError("previousDecisionId", "must name a different attempt");
    stringAt(value, "taskTextPrefix", "");
    checkTierMap(value);
    checkRoute(value);
    oneOf(objectAt(value, "route", ""), "outcome", "route", ["chosen"]);
  } else if (recordType === "explicit") {
    checkKeys(value, "", [...COMMON_KEYS, "cause", "mode", "slot", "model", "taskTextPrefix", "agentRole"]);
    checkCommon(value);
    oneOf(value, "cause", "", ["explicit"]);
    oneOf(value, "mode", "", ROUTING_MODES);
    for (const key of ["slot", "model", "agentRole"]) stringAt(value, key, "", { nonBlank: true });
    stringAt(value, "taskTextPrefix", "");
  } else if (recordType === "verdict") {
    checkKeys(value, "", [...COMMON_KEYS, "verdict", "decisionFile"]);
    checkCommon(value);
    oneOf(value, "verdict", "", VERDICTS);
    const decisionFile = stringAt(value, "decisionFile", "", { nonBlank: true });
    if (!DAY_FILE.test(decisionFile)) throw new RoutingRecordError("decisionFile", `must name a day file YYYY-MM-DD.jsonl; got ${JSON.stringify(decisionFile)}`);
  } else {
    checkKeys(value, "", [...COMMON_KEYS, "verdict"]);
    checkCommon(value);
    oneOf(value, "verdict", "", VERDICTS);
  }
  for (const [path, limit] of FREE_TEXT_FIELDS) checkFreeTextLimits(value, path, limit, "");
  return value as unknown as RoutingRecord;
}

// ---------------------------------------------------------------------------
// Building a decision record: every field copied by name
// ---------------------------------------------------------------------------

interface DecisionRecordInputCommon {
  readonly delegationId: string;
  /** Defaults to now. */
  readonly at?: Date;
  readonly taskText: string;
  readonly agentRole: string;
  readonly classification: TierClassification;
  readonly tierMap: ResolvedTierMap;
  readonly route: TierRouteDecision;
  readonly ranOn: string;
}

export type DecisionRecordInput =
  | (DecisionRecordInputCommon & { readonly mode: "live"; readonly handPickedModel?: undefined })
  | (DecisionRecordInputCommon & { readonly mode: "shadow"; readonly handPickedModel: string });

function recordedRung(rung: TierRung): RecordedRung {
  return { rung: rung.rung, model: rung.model, effort: rung.effort, origin: rung.origin };
}

function recordedHop(hop: HopOutcome): RecordedHop {
  return {
    hop: hop.hop,
    outcome: hop.outcome,
    ...(hop.detail === undefined ? {} : { detail: hop.detail }),
    ...(hop.allowance === undefined
      ? {}
      : { allowance: { reservationId: hop.allowance.reservationId, settlement: hop.allowance.settlement } }),
  };
}

function recordedClassification(classification: TierClassification): RecordedClassification {
  return {
    tier: classification.tier,
    cause: classification.cause,
    ...(classification.modelTier === undefined ? {} : { modelTier: classification.modelTier }),
    floor: classification.floor,
    ...(classification.floorTier === undefined ? {} : { floorTier: classification.floorTier }),
    floorSignals: classification.floorSignals.map((signal) => ({ kind: signal.kind, label: signal.label, matched: signal.matched })),
    risk: { level: classification.risk.level, reasons: [...classification.risk.reasons] },
    ambiguity: classification.ambiguity,
    complexity: classification.complexity,
    kindOfWork: classification.kindOfWork,
    why: classification.why,
    rubricVersion: classification.rubricVersion,
    schemaVersion: classification.schemaVersion,
    hops: classification.hops.map(recordedHop),
  };
}

function recordedDrop(drop: TierMapDrop): TierMapDrop {
  return "rung" in drop
    ? { tier: drop.tier, rung: drop.rung, origin: drop.origin, reason: drop.reason }
    : { tier: drop.tier, origin: drop.origin, reason: drop.reason };
}

function recordedTierMap(tierMap: ResolvedTierMap): RecordedTierMap {
  const tiers = {} as Record<RiskTier, readonly RecordedRung[]>;
  for (const tier of RISK_TIERS) tiers[tier] = tierMap.tiers[tier].map(recordedRung);
  return { tiers, drops: tierMap.drops.map(recordedDrop), ignoredProjectKeys: [...tierMap.ignoredProjectKeys] };
}

function recordedRemoved(removed: RemovedRung): RecordedRemovedRung {
  return { tier: removed.tier, rung: removed.rung, model: removed.model, reason: removed.reason, detail: removed.detail };
}

function recordedRoute(route: TierRouteDecision): RecordedRoute {
  const common = {
    startedAtTier: route.startedAtTier,
    tiersTried: [...route.tiersTried],
    removed: route.removed.map(recordedRemoved),
    allowanceApplied: route.allowanceApplied,
  };
  if (route.ok) {
    return {
      outcome: "chosen",
      ...common,
      tier: route.tier,
      rung: recordedRung(route.rung),
      survivors: route.survivors.map(recordedRung),
    };
  }
  return { outcome: "refused", ...common, code: route.code, message: route.message };
}

export function buildEffortLadderRecord(input: {
  readonly delegationId: string;
  readonly at: Date;
  readonly previousDecisionId: string;
  readonly step: EffortLadderRecord["step"];
  readonly skipped: readonly LadderSkippedRung[];
  readonly taskText: string;
  readonly agentRole: string;
  readonly kindOfWork: string;
  readonly tierMap: ResolvedTierMap;
  readonly route: Extract<TierRouteDecision, { ok: true }>;
}): EffortLadderRecord {
  const record: EffortLadderRecord = {
    recordType: "effort-ladder", schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    skipped: input.skipped.map((entry) => ({ tier: entry.tier, rung: entry.rung, model: entry.model, reason: entry.reason, detail: entry.detail })),
    cause: "effort-ladder", mode: "live", delegationId: input.delegationId,
    timestamp: input.at.toISOString(), previousDecisionId: input.previousDecisionId, step: input.step,
    taskTextPrefix: input.taskText, agentRole: input.agentRole, kindOfWork: input.kindOfWork,
    tierMap: recordedTierMap(input.tierMap), route: recordedRoute(input.route) as RecordedRouteChoice,
  };
  return checkedRecord(record);
}

export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const record: DecisionRecord = {
    recordType: "decision",
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    delegationId: input.delegationId,
    timestamp: (input.at ?? new Date()).toISOString(),
    mode: input.mode,
    taskTextPrefix: input.taskText,
    agentRole: input.agentRole,
    classification: recordedClassification(input.classification),
    tierMap: recordedTierMap(input.tierMap),
    route: recordedRoute(input.route),
    ranOn: input.ranOn,
    ...(input.handPickedModel === undefined ? {} : { handPickedModel: input.handPickedModel }),
  };
  return checkedRecord(record);
}

// ---------------------------------------------------------------------------
// Files: one per UTC day, append-only
// ---------------------------------------------------------------------------

export function dayFileName(timestamp: string): string {
  return `${timestamp.slice(0, 10)}.jsonl`;
}

export function decisionRecordPath(dir: string, at: Date): string {
  return join(dir, dayFileName(at.toISOString()));
}

/** Free text made safe (`recordSafeCopy`), then validated. */
function checkedRecord<T extends RoutingRecord>(record: T): T {
  const safe = recordSafeCopy(record);
  validateRoutingRecord(safe);
  return safe;
}

/** Make safe, validate, then append one record to its day file. Returns the
 *  file path. */
export function appendRoutingRecord(dir: string, record: RoutingRecord): string {
  const safe = checkedRecord(record);
  const path = join(dir, dayFileName(safe.timestamp));
  mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(safe)}\n`);
  return path;
}

export interface WrittenDecisionRecord {
  readonly path: string;
  readonly record: DecisionRecord;
}

/** Build, write and return one decision record. */
export function writeDecisionRecord(dir: string, input: DecisionRecordInput): WrittenDecisionRecord {
  const record = buildDecisionRecord(input);
  return { path: appendRoutingRecord(dir, record), record };
}

/** The two reads the record folder needs. Injected so a test can prove what
 *  was read. */
export interface RecordFolderReader {
  readonly readdir: (dir: string) => readonly string[];
  readonly readFile: (path: string) => string;
}

export const NODE_RECORD_FOLDER_READER: RecordFolderReader = {
  readdir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf8"),
};

export interface RoutingRecordEntry {
  readonly file: string;
  readonly line: number;
  readonly record: RoutingRecord;
}

/** Every record in the folder's day files, oldest file first, in file order.
 *  A folder that does not exist holds no records. Throws `RoutingRecordError`
 *  with `<file>:<line>` for the first invalid line. */
export function readRoutingRecordEntries(dir: string, reader: RecordFolderReader = NODE_RECORD_FOLDER_READER): RoutingRecordEntry[] {
  let names: readonly string[];
  try {
    names = reader.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: RoutingRecordEntry[] = [];
  for (const file of names.filter((name) => DAY_FILE.test(name)).sort()) {
    const lines = reader.readFile(join(dir, file)).split("\n");
    lines.forEach((text, index) => {
      if (text.trim().length === 0) return;
      const location = `${file}:${index + 1}`;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new RoutingRecordError("(record)", `is not valid JSON (${(error as Error).message})`, location);
      }
      try {
        entries.push({ file, line: index + 1, record: validateRoutingRecord(parsed) });
      } catch (error) {
        if (error instanceof RoutingRecordError) {
          throw new RoutingRecordError(error.field, error.problem, location);
        }
        throw error;
      }
    });
  }
  return entries;
}

export function readRoutingRecords(dir: string, reader?: RecordFolderReader): RoutingRecord[] {
  return readRoutingRecordEntries(dir, reader).map((entry) => entry.record);
}
