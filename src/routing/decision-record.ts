// Ticket 25: the decision record (stories 28, 32 and 34).
//
// One append-only JSON line per routing decision, one file per UTC day,
// `<folder>/<YYYY-MM-DD>.jsonl`. The folder is injected; the harness default
// is `src/state/routing` (git-ignored runtime state, like ticket 08's
// refresh state). Verdicts attached later (./verdicts.ts), and the edit
// records (../subagents/editing.ts) and gate requirements
// (../subagents/quality-gate.ts) of editing delegations are further lines in
// the same day files, so the folder holds every routing fact and nothing else.
//
// The writer copies each field it records by name from the values it is
// given: ticket 23's classification, ticket 22's resolved tier map, ticket
// 24's router decision, the worker's routing constraints, and the delegation
// facts (delegation id, mode, task text, agent role, the model the worker ran
// on, the hand-picked model in shadow mode, the parent delegation of a
// worker's own worker, and the delegation a reviewer reviews). Nothing else an input object carries (a parsed
// settings file, a token) can reach the file.
//
// Free text (task text, the classifier's `why` and reasons, hop details,
// route messages, removal and drop reasons, skipped-rung details, verdict
// reasons) passes one
// function, `recordSafeCopy`, on every write path: credential-shaped
// substrings become `[redacted]` (best effort, see `CREDENTIAL_PATTERNS`),
// then task text is cut to its first 200 characters and every other free-text
// field to 500. The limits are checked again on read.
//
// Every record is validated on write and on read: a missing or unknown field,
// at the top level or inside the classification, tier map or route, fails
// with the field named. The auto model (../router/auto-model.ts) writes
// one decision record per worker's first request, and when that request fails
// over (PRD cml8, "Failover") a failover record and a decision record for the
// rung it moved to.
//
// This module imports no other harness module at run time except the tier
// list (./tiers.ts) and the skip reasons, so the report CLI that reads records
// loads nothing else.
//
// Records written before ADR 0015 carry the keyword floor (`floor`,
// `floorTier`, `floorSignals`) and the model's own tier (`modelTier`) in their
// classification. New records carry neither; readers accept both.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RISK_TIERS, type RiskTier } from "./tiers.ts";
import type { HopOutcome, TierClassification } from "./tier-classifier.ts";
import type { ResolvedTierMap, TierMapDrop, TierOrder, TierRung } from "./tier-map.ts";
import type { LadderSkippedRung } from "./effort-ladder.ts";
import { LADDER_SKIP_REASONS } from "./skip-reasons.ts";
import type { RemovedRung, RoutingConstraints, TierRouteDecision } from "./tier-router.ts";

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
  // Only records written before ADR 0015 hold floor signals; read checks still apply.
  [["classification", "floorSignals", "[]", "matched"], FREE_TEXT_LIMIT],
  [["classification", "hops", "[]", "detail"], FREE_TEXT_LIMIT],
  [["tierMap", "drops", "[]", "reason"], FREE_TEXT_LIMIT],
  [["route", "message"], FREE_TEXT_LIMIT],
  [["route", "allowanceApplied"], FREE_TEXT_LIMIT],
  [["route", "removed", "[]", "detail"], FREE_TEXT_LIMIT],
  [["skipped", "[]", "detail"], FREE_TEXT_LIMIT],
  [["reason"], FREE_TEXT_LIMIT],
  [["gateLevelRaise", "reason"], FREE_TEXT_LIMIT],
  [["detail"], FREE_TEXT_LIMIT],
  [["paths", "[]"], FREE_TEXT_LIMIT],
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

/** Routing as a retry found it when it started: a routing mode, or `off`. */
export const LADDER_MODES = [...ROUTING_MODES, "off"] as const;
export type LadderMode = (typeof LADDER_MODES)[number];

/** A placed climb's step, as the effort ladder took it. */
export const LADDER_STEPS = ["effort", "same-tier", "next-tier"] as const;

/** The orchestrator's verdict as `subagents_verdict` records it. A verdict
 *  the gate required and nobody recorded is a missing verdict, which the
 *  routing report derives from gate requirement records; it is never a record. */
export const VERDICTS = ["accept", "request_changes"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** How strictly the quality gate treats each tier (ADR 0011), lowest first.
 *  At off there is no quality gate: every tier's gate action is none. */
export const GATE_LEVELS = ["off", "low", "medium", "high", "max"] as const;
export type GateLevel = (typeof GATE_LEVELS)[number];

/** CONTEXT.md, Gate action: no verdict, the orchestrator's spot check, or an independent reviewer. */
export const GATE_ACTIONS = ["none", "spot-check", "reviewer"] as const;
export type GateAction = (typeof GATE_ACTIONS)[number];

/** The orchestrator's raise of the gate level for one delegation (ADR 0011):
 *  from the level in force to a higher one, with its reason. */
export interface GateLevelRaise {
  readonly from: GateLevel;
  readonly to: GateLevel;
  readonly reason: string;
}

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

/** A keyword signal of the floor on a record written before ADR 0015. */
export interface RecordedFloorSignal {
  readonly kind: string;
  readonly label: string;
  readonly matched: string;
}

export interface RecordedClassification {
  readonly tier: RiskTier;
  /** What gave the tier: `model:<rung>`, `unclassified`, or
   *  `retry:<delegation id>` for a retry on the tier of the delegation it
   *  retries. `keywords` on records written before ADR 0015. */
  readonly cause: string;
  /** Records written before ADR 0015 only: the model's tier before the floor. */
  readonly modelTier?: RiskTier;
  /** Records written before ADR 0015 only: `none`, or the floor tier with its signal labels. */
  readonly floor?: string;
  readonly floorTier?: RiskTier;
  readonly floorSignals?: readonly RecordedFloorSignal[];
  /** The model's risk level and its reasons. */
  readonly risk: { readonly level: string; readonly reasons: readonly string[] };
  readonly ambiguity: string;
  readonly complexity: string;
  readonly kindOfWork: string;
  /** The model's reason for the tier. */
  readonly why: string;
  readonly rubricVersion: string;
  readonly schemaVersion: string;
  readonly hops: readonly RecordedHop[];
}

export interface RecordedTierMap {
  readonly tiers: Readonly<Record<RiskTier, readonly RecordedRung[]>>;
  /** Absent on records written before balanced tier order. */
  readonly orders?: Readonly<Record<RiskTier, TierOrder>>;
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
  readonly tierOrder?: TierOrder;
  readonly providerCounts?: Readonly<Record<string, number>>;
  /** Candidate providers a balanced choice weighted as under 10% left. */
  readonly lowUsageProviders?: readonly string[];
}

export interface RecordedRouteRefusal extends RecordedRouteCommon {
  readonly outcome: "refused";
  readonly code: string;
  readonly message: string;
}

export type RecordedRoute = RecordedRouteChoice | RecordedRouteRefusal;

/** The routing constraints a decision was made under. */
export interface RecordedConstraints {
  readonly minimumTier?: RiskTier;
  /** `provider/model:effort`. */
  readonly excludedRung?: string;
  /** The forced rung and the tier it stands for; never with another constraint. */
  readonly forcedRung?: { readonly tier: RiskTier; readonly rung: string };
}

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
  /** The delegation id of the worker that made this delegation (ADR 0008);
   *  absent when the orchestrator made it. */
  readonly parentDelegationId?: string;
  /** The worker's routing constraints; absent when it had none. */
  readonly constraints?: RecordedConstraints;
  /** The delegation this reviewer reviews (ADR 0010); absent for any other worker. */
  readonly reviewedDelegationId?: string;
}

export interface VerdictRecord extends RecordCommon {
  readonly recordType: "verdict";
  readonly verdict: Verdict;
  /** The day file holding the record this verdict is attached to: the
   *  delegation's decision, fork or agent-model record, or its edit record
   *  when it has none of those, as a worker the router did not route. */
  readonly decisionFile: string;
  /** Why the orchestrator judged so (subagents_verdict); absent on verdicts
   *  recorded without one, before subagents_verdict. */
  readonly reason?: string;
  /** The verdict rests on a same-rung review: its reviewer ran on the
   *  delegation's own rung, in shadow mode or with routing off (ADR 0010). */
  readonly sameRungReview?: true;
  /** The orchestrator raised the gate level for this delegation in its
   *  verdict call (ADR 0011); absent when the verdict was judged at the level in force. */
  readonly gateLevelRaise?: GateLevelRaise;
}

/** A verdict whose delegation id matches no decision in the folder. Kept, not
 *  dropped (story 32), and counted by the report. */
export interface OrphanedVerdictRecord extends RecordCommon {
  readonly recordType: "orphaned-verdict";
  readonly verdict: Verdict;
}

/** A climb on the effort ladder (ADR 0010): the retry `delegationId` of the
 *  failed attempt `previousDecisionId`, written when the retry starts. It is
 *  the link, not the routing decision: the retry's own decision record, when
 *  the router writes one, says what it ran on. */
interface EffortLadderRecordCommon extends RecordCommon {
  readonly recordType: "effort-ladder";
  readonly cause: "effort-ladder";
  readonly previousDecisionId: string;
  readonly taskTextPrefix: string;
  readonly agentRole: string;
}

/** A climb from the failed attempt's rung to the next one the ladder chose.
 *  In shadow mode the rung is the one the retry would use; it runs on the
 *  session model. */
export interface PlacedLadderRecord extends EffortLadderRecordCommon {
  readonly step: (typeof LADDER_STEPS)[number];
  readonly mode: RoutingMode;
  readonly skipped: readonly LadderSkippedRung[];
  readonly kindOfWork: string;
  readonly tierMap: RecordedTierMap;
  readonly route: RecordedRouteChoice;
}

/** A retry of a failed attempt the ladder cannot place: routing was off at
 *  the retry, or no routing decision names the attempt's rung. It names no
 *  rung, and still counts as a climb. */
export interface UnplacedLadderRecord extends EffortLadderRecordCommon {
  readonly step: "unplaced";
  readonly mode: LadderMode;
  /** Why the ladder cannot place the failed attempt. */
  readonly detail: string;
}

export type EffortLadderRecord = PlacedLadderRecord | UnplacedLadderRecord;

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

export interface AgentModelRecord extends RecordCommon {
  readonly recordType: "agent-model";
  readonly agent: string;
  readonly definitionFile: string;
  readonly model: string;
  readonly effort: string;
  /** The model is on the subagent ban list and the owner's exception for
   *  definition-named models let it run (ADR 0002 follow-up). */
  readonly banListException?: boolean;
}

export interface ForkRecord extends RecordCommon {
  readonly recordType: "fork";
  readonly parentDelegationId?: string;
  readonly model: string;
  readonly effort: string;
  readonly parentSession: string;
  readonly forkPoint: string | null;
  readonly banListException: boolean;
}

/** An editing delegation's edit (ADR 0010): written the first time in a run
 *  that its worker, or a worker it started, runs an editing tool call, and
 *  again as a run ends when the working tree changed while it ran
 *  (../subagents/working-tree.ts), naming the changed paths. A resumed
 *  delegation writes more in each run that edits. */
export interface EditRecord extends RecordCommon {
  readonly recordType: "edit";
  /** The orchestrator session the delegation belongs to. */
  readonly orchestratorSession: string;
  /** The editing call's tool: `edit`, `write`, `bash`, ... */
  readonly tool: string;
  /** The worker's own worker that made the edit, which counts for the
   *  delegation that started it; absent when the delegation's worker did. */
  readonly nestedDelegationId?: string;
  /** For a working-tree record (tool `working-tree`): the paths that changed
   *  while the run lasted, relative to the worker's working directory, at
   *  most EDIT_RECORD_PATH_LIMIT; empty when only HEAD moved. */
  readonly paths?: readonly string[];
  /** How many more changed paths there were than `paths` holds. */
  readonly omittedPaths?: number;
}

/** The most changed paths one edit record names. */
export const EDIT_RECORD_PATH_LIMIT = 100;

/** An editing delegation's gate requirement (ADR 0010, ADR 0011): written
 *  when a run of it that edited ends, at the gate level then in force. A
 *  resume that edits again writes another, and the latest counts. Gate action
 *  none makes it an ungated delegation; any other, with no verdict after its
 *  latest edit, a missing verdict. Neither teaches the router. */
export interface GateRequirementRecord extends RecordCommon {
  readonly recordType: "gate-requirement";
  readonly gateLevel: GateLevel;
  readonly gateAction: GateAction;
}

/** The limit a failover moved a worker away from: a usage limit (exhausted)
 *  or a rate limit (throttled). */
export const FAILOVER_LIMITS = ["exhausted", "throttled"] as const;

/** A failover on a worker's first request (PRD cml8, "Failover"): the rung
 *  of the refused attempt answered with a limit error before it produced
 *  anything, and the worker was pinned again to `rung`. Written with the
 *  delegation's next decision record, which says what the worker ran on;
 *  `refusedAttempt` names the decision record of the refused attempt (same
 *  delegation id) by its timestamp and rung. */
export interface FailoverRecord extends RecordCommon {
  readonly recordType: "failover";
  readonly refusedAttempt: { readonly timestamp: string; readonly rung: string };
  readonly limit: (typeof FAILOVER_LIMITS)[number];
  /** When the limit lifts, if the error stated it. */
  readonly resetsAt?: string;
  /** The refused rung's error text. */
  readonly detail: string;
  /** The rung the worker was pinned to again, `provider/model:effort`. */
  readonly rung: string;
}

export type RoutedDecisionRecord = DecisionRecord | EffortLadderRecord;
export type RoutingRecord = RoutedDecisionRecord | ForkRecord | AgentModelRecord | ExplicitModelRecord | VerdictRecord | OrphanedVerdictRecord | EditRecord |
  GateRequirementRecord | FailoverRecord;

/** A routed decision for the routing report. Forks accept verdicts but are not routed. */
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
    ["tier", "cause", "risk", "ambiguity", "complexity", "kindOfWork", "why", "rubricVersion", "schemaVersion", "hops"],
    // Written before ADR 0015 only.
    ["modelTier", "floor", "floorTier", "floorSignals"],
  );
  oneOf(value, "tier", path, RISK_TIERS);
  if (value.modelTier !== undefined) oneOf(value, "modelTier", path, RISK_TIERS);
  if (value.floorTier !== undefined) oneOf(value, "floorTier", path, RISK_TIERS);
  for (const key of ["cause", "ambiguity", "complexity", "kindOfWork", "rubricVersion", "schemaVersion"]) {
    stringAt(value, key, path, { nonBlank: true });
  }
  if (value.floor !== undefined) stringAt(value, "floor", path, { nonBlank: true });
  stringAt(value, "why", path);
  if (value.floorSignals !== undefined) {
    eachObject(value, "floorSignals", path, (signal, signalPath) => {
      checkKeys(signal, signalPath, ["kind", "label", "matched"]);
      for (const key of ["kind", "label", "matched"]) stringAt(signal, key, signalPath);
    });
  }
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
  checkKeys(value, path, ["tiers", "drops", "ignoredProjectKeys"], ["orders"]);
  if (value.orders !== undefined) {
    const orders = objectAt(value, "orders", path);
    checkKeys(orders, `${path}.orders`, RISK_TIERS);
    for (const tier of RISK_TIERS) oneOf(orders, tier, `${path}.orders`, ["balanced", "ordered"] as const);
  }
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
    checkKeys(value, path, [...common, "tier", "rung", "survivors"], ["tierOrder", "providerCounts", "lowUsageProviders"]);
    oneOf(value, "tier", path, RISK_TIERS);
    if (value.tierOrder !== undefined) oneOf(value, "tierOrder", path, ["balanced", "ordered"] as const);
    if (value.providerCounts !== undefined) {
      const counts = objectAt(value, "providerCounts", path);
      for (const [provider, count] of Object.entries(counts)) {
        if (!provider || !Number.isSafeInteger(count) || (count as number) < 0) {
          throw new RoutingRecordError(`${path}.providerCounts.${provider}`, "must be a non-negative integer provider count");
        }
      }
    }
    if (value.lowUsageProviders !== undefined) checkStrings(value, "lowUsageProviders", path);
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

function checkConstraints(record: Json): void {
  const path = "constraints";
  const value = objectAt(record, path, "");
  checkKeys(value, path, [], ["minimumTier", "excludedRung", "forcedRung"]);
  if (Object.keys(value).length === 0) throw new RoutingRecordError(path, "must name at least one constraint");
  if (value.minimumTier !== undefined) oneOf(value, "minimumTier", path, RISK_TIERS);
  if (value.excludedRung !== undefined) stringAt(value, "excludedRung", path, { nonBlank: true });
  if (value.forcedRung !== undefined) {
    if (Object.keys(value).length > 1) throw new RoutingRecordError(`${path}.forcedRung`, "must be the only constraint");
    const forced = objectAt(value, "forcedRung", path);
    checkKeys(forced, `${path}.forcedRung`, ["tier", "rung"]);
    oneOf(forced, "tier", `${path}.forcedRung`, RISK_TIERS);
    stringAt(forced, "rung", `${path}.forcedRung`, { nonBlank: true });
  }
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
  const recordType = oneOf(value, "recordType", "",
    ["decision", "effort-ladder", "agent-model", "fork", "explicit", "verdict", "orphaned-verdict", "edit", "gate-requirement", "failover"] as const);
  if (value.schemaVersion === DECISION_RECORD_SCHEMA_VERSION && recordType === "explicit") {
    throw new RoutingRecordError("schemaVersion", `is unsupported for ${recordType} records`);
  }
  if (recordType === "decision") {
    const mode = oneOf(value, "mode", "", ROUTING_MODES);
    const required = [...COMMON_KEYS, "mode", "taskTextPrefix", "agentRole", "classification", "tierMap", "route",
      ...(value.schemaVersion === DECISION_RECORD_SCHEMA_VERSION ? ["ranOn"] : [])];
    checkKeys(value, "", mode === "shadow" ? [...required, "handPickedModel"] : required, ["parentDelegationId", "constraints", "reviewedDelegationId"]);
    checkCommon(value);
    for (const key of ["parentDelegationId", "reviewedDelegationId"]) {
      if (value[key] === undefined) continue;
      stringAt(value, key, "", { nonBlank: true });
      if (value[key] === value.delegationId) throw new RoutingRecordError(key, "must name a different delegation");
    }
    stringAt(value, "taskTextPrefix", "");
    stringAt(value, "agentRole", "", { nonBlank: true });
    if (mode === "shadow") stringAt(value, "handPickedModel", "", { nonBlank: true });
    if (value.schemaVersion === DECISION_RECORD_SCHEMA_VERSION) stringAt(value, "ranOn", "", { nonBlank: true });
    checkClassification(value);
    checkTierMap(value);
    checkRoute(value);
    if (value.constraints !== undefined) checkConstraints(value);
  } else if (recordType === "effort-ladder") {
    const common = [...COMMON_KEYS, "cause", "previousDecisionId", "step", "mode", "taskTextPrefix", "agentRole"];
    const step = oneOf(value, "step", "", [...LADDER_STEPS, "unplaced"]);
    if (step === "unplaced") {
      if (value.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) throw new RoutingRecordError("schemaVersion", "is unsupported for unplaced effort-ladder records");
      checkKeys(value, "", [...common, "detail"]);
      oneOf(value, "mode", "", LADDER_MODES);
      stringAt(value, "detail", "", { nonBlank: true });
    } else {
      checkKeys(value, "", [...common, "kindOfWork", "tierMap", "route", "skipped"]);
      eachObject(value, "skipped", "", (entry, path) => {
        checkKeys(entry, path, ["tier", "rung", "model", "reason", "detail"]);
        oneOf(entry, "tier", path, RISK_TIERS);
        oneOf(entry, "reason", path, LADDER_SKIP_REASONS);
        for (const key of ["rung", "model", "detail"]) stringAt(entry, key, path, { nonBlank: true });
      });
      // A placed climb needs a tier map, which routing off does not load.
      oneOf(value, "mode", "", ROUTING_MODES);
      stringAt(value, "kindOfWork", "", { nonBlank: true });
      checkTierMap(value);
      checkRoute(value);
      oneOf(objectAt(value, "route", ""), "outcome", "route", ["chosen"]);
    }
    checkCommon(value);
    oneOf(value, "cause", "", ["effort-ladder"]);
    for (const key of ["previousDecisionId", "agentRole"]) stringAt(value, key, "", { nonBlank: true });
    if (value.previousDecisionId === value.delegationId) throw new RoutingRecordError("previousDecisionId", "must name a different attempt");
    stringAt(value, "taskTextPrefix", "");
  } else if (recordType === "fork") {
    if (value.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) throw new RoutingRecordError("schemaVersion", `is unsupported for ${recordType} records`);
    checkKeys(value, "", [...COMMON_KEYS, "model", "effort", "parentSession", "forkPoint", "banListException"], ["parentDelegationId"]);
    if (value.parentDelegationId !== undefined) stringAt(value, "parentDelegationId", "", { nonBlank: true });
    checkCommon(value);
    for (const key of ["model", "effort", "parentSession"]) stringAt(value, key, "", { nonBlank: true });
    if (value.forkPoint !== null) stringAt(value, "forkPoint", "", { nonBlank: true });
    if (typeof value.banListException !== "boolean") throw new RoutingRecordError("banListException", "must be a boolean");
  } else if (recordType === "agent-model") {
    if (value.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) throw new RoutingRecordError("schemaVersion", `is unsupported for ${recordType} records`);
    checkKeys(value, "", [...COMMON_KEYS, "agent", "definitionFile", "model", "effort"], ["banListException"]);
    checkCommon(value);
    for (const key of ["agent", "definitionFile", "model", "effort"]) stringAt(value, key, "", { nonBlank: true });
    if (value.banListException !== undefined && typeof value.banListException !== "boolean") {
      throw new RoutingRecordError("banListException", "must be a boolean");
    }
  } else if (recordType === "explicit") {
    checkKeys(value, "", [...COMMON_KEYS, "cause", "mode", "slot", "model", "taskTextPrefix", "agentRole"]);
    checkCommon(value);
    oneOf(value, "cause", "", ["explicit"]);
    oneOf(value, "mode", "", ROUTING_MODES);
    for (const key of ["slot", "model", "agentRole"]) stringAt(value, key, "", { nonBlank: true });
    stringAt(value, "taskTextPrefix", "");
  } else if (recordType === "verdict") {
    checkKeys(value, "", [...COMMON_KEYS, "verdict", "decisionFile"], ["reason", "sameRungReview", "gateLevelRaise"]);
    checkCommon(value);
    oneOf(value, "verdict", "", VERDICTS);
    const decisionFile = stringAt(value, "decisionFile", "", { nonBlank: true });
    if (!DAY_FILE.test(decisionFile)) throw new RoutingRecordError("decisionFile", `must name a day file YYYY-MM-DD.jsonl; got ${JSON.stringify(decisionFile)}`);
    if (value.reason !== undefined) stringAt(value, "reason", "", { nonBlank: true });
    if (value.sameRungReview !== undefined && value.sameRungReview !== true) throw new RoutingRecordError("sameRungReview", "must be true when present");
    if (value.gateLevelRaise !== undefined) {
      const raise = objectAt(value, "gateLevelRaise", "");
      checkKeys(raise, "gateLevelRaise", ["from", "to", "reason"]);
      const from = oneOf(raise, "from", "gateLevelRaise", GATE_LEVELS);
      const to = oneOf(raise, "to", "gateLevelRaise", GATE_LEVELS);
      if (GATE_LEVELS.indexOf(to) <= GATE_LEVELS.indexOf(from)) throw new RoutingRecordError("gateLevelRaise.to", `must be a higher gate level than ${from}; got ${JSON.stringify(to)}`);
      stringAt(raise, "reason", "gateLevelRaise", { nonBlank: true });
    }
  } else if (recordType === "edit") {
    if (value.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) throw new RoutingRecordError("schemaVersion", `is unsupported for ${recordType} records`);
    checkKeys(value, "", [...COMMON_KEYS, "orchestratorSession", "tool"], ["nestedDelegationId", "paths", "omittedPaths"]);
    checkCommon(value);
    for (const key of ["orchestratorSession", "tool"]) stringAt(value, key, "", { nonBlank: true });
    if (value.paths !== undefined) {
      const paths = arrayAt(value, "paths", "");
      if (paths.length > EDIT_RECORD_PATH_LIMIT) throw new RoutingRecordError("paths", `must hold at most ${EDIT_RECORD_PATH_LIMIT} paths; got ${paths.length}`);
      paths.forEach((_, index) => stringAt(paths as unknown as Json, String(index), "paths", { nonBlank: true }));
    }
    if (value.omittedPaths !== undefined && (!Number.isInteger(value.omittedPaths) || (value.omittedPaths as number) < 1)) {
      throw new RoutingRecordError("omittedPaths", `must be a positive integer when present; got ${JSON.stringify(value.omittedPaths)}`);
    }
    if (value.nestedDelegationId !== undefined) {
      stringAt(value, "nestedDelegationId", "", { nonBlank: true });
      if (value.nestedDelegationId === value.delegationId) throw new RoutingRecordError("nestedDelegationId", "must name a different delegation");
    }
  } else if (recordType === "gate-requirement") {
    if (value.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) throw new RoutingRecordError("schemaVersion", `is unsupported for ${recordType} records`);
    checkKeys(value, "", [...COMMON_KEYS, "gateLevel", "gateAction"]);
    checkCommon(value);
    oneOf(value, "gateLevel", "", GATE_LEVELS);
    oneOf(value, "gateAction", "", GATE_ACTIONS);
  } else if (recordType === "failover") {
    if (value.schemaVersion !== DECISION_RECORD_SCHEMA_VERSION) throw new RoutingRecordError("schemaVersion", `is unsupported for ${recordType} records`);
    checkKeys(value, "", [...COMMON_KEYS, "refusedAttempt", "limit", "detail", "rung"], ["resetsAt"]);
    checkCommon(value);
    const refused = objectAt(value, "refusedAttempt", "");
    checkKeys(refused, "refusedAttempt", ["timestamp", "rung"]);
    const refusedAt = stringAt(refused, "timestamp", "refusedAttempt", { nonBlank: true });
    if (Number.isNaN(Date.parse(refusedAt))) throw new RoutingRecordError("refusedAttempt.timestamp", `must be an ISO-8601 time; got ${JSON.stringify(refusedAt)}`);
    stringAt(refused, "rung", "refusedAttempt", { nonBlank: true });
    oneOf(value, "limit", "", FAILOVER_LIMITS);
    if (value.resetsAt !== undefined) {
      const resetsAt = stringAt(value, "resetsAt", "", { nonBlank: true });
      if (Number.isNaN(Date.parse(resetsAt))) throw new RoutingRecordError("resetsAt", `must be an ISO-8601 time; got ${JSON.stringify(resetsAt)}`);
    }
    stringAt(value, "detail", "", { nonBlank: true });
    stringAt(value, "rung", "", { nonBlank: true });
    if (value.rung === refused.rung) throw new RoutingRecordError("rung", "must name a different rung than the refused attempt");
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
  readonly parentDelegationId?: string;
  /** The worker's routing constraints; none leaves the record without the field. */
  readonly constraints?: RoutingConstraints;
  /** The delegation a reviewer reviews (ADR 0010). */
  readonly reviewedDelegationId?: string;
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
  return { tiers, orders: { ...tierMap.orders }, drops: tierMap.drops.map(recordedDrop), ignoredProjectKeys: [...tierMap.ignoredProjectKeys] };
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
      ...(route.tierOrder === undefined ? {} : { tierOrder: route.tierOrder }),
      ...(route.providerCounts === undefined ? {} : { providerCounts: { ...route.providerCounts } }),
      ...(route.lowUsageProviders === undefined ? {} : { lowUsageProviders: [...route.lowUsageProviders] }),
    };
  }
  return { outcome: "refused", ...common, code: route.code, message: route.message };
}

/** `undefined` when no constraint is set, so an unconstrained record has no
 *  `constraints` field. */
function recordedConstraints(constraints: RoutingConstraints | undefined): RecordedConstraints | undefined {
  const recorded: RecordedConstraints = {
    ...(constraints?.minimumTier === undefined ? {} : { minimumTier: constraints.minimumTier }),
    ...(constraints?.excludedRung === undefined ? {} : { excludedRung: `${constraints.excludedRung.model}:${constraints.excludedRung.effort}` }),
    ...(constraints?.forcedRung === undefined ? {} : { forcedRung: { tier: constraints.forcedRung.tier, rung: constraints.forcedRung.rung.rung } }),
  };
  return Object.keys(recorded).length === 0 ? undefined : recorded;
}

export function buildEffortLadderRecord(input: {
  readonly delegationId: string;
  readonly at: Date;
  readonly previousDecisionId: string;
  readonly step: PlacedLadderRecord["step"];
  readonly mode: RoutingMode;
  readonly skipped: readonly LadderSkippedRung[];
  readonly taskText: string;
  readonly agentRole: string;
  readonly kindOfWork: string;
  readonly tierMap: ResolvedTierMap;
  readonly route: Extract<TierRouteDecision, { ok: true }>;
}): PlacedLadderRecord {
  const record: PlacedLadderRecord = {
    recordType: "effort-ladder", schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    skipped: input.skipped.map((entry) => ({ tier: entry.tier, rung: entry.rung, model: entry.model, reason: entry.reason, detail: entry.detail })),
    cause: "effort-ladder", mode: input.mode, delegationId: input.delegationId,
    timestamp: input.at.toISOString(), previousDecisionId: input.previousDecisionId, step: input.step,
    taskTextPrefix: input.taskText, agentRole: input.agentRole, kindOfWork: input.kindOfWork,
    tierMap: recordedTierMap(input.tierMap), route: recordedRoute(input.route) as RecordedRouteChoice,
  };
  return checkedRecord(record);
}

/** The effort-ladder record of a retry whose failed attempt the ladder cannot place. */
export function buildUnplacedLadderRecord(input: {
  readonly delegationId: string;
  readonly at: Date;
  readonly previousDecisionId: string;
  readonly mode: LadderMode;
  readonly detail: string;
  readonly taskText: string;
  readonly agentRole: string;
}): UnplacedLadderRecord {
  return checkedRecord({
    recordType: "effort-ladder", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, cause: "effort-ladder",
    delegationId: input.delegationId, timestamp: input.at.toISOString(), previousDecisionId: input.previousDecisionId,
    step: "unplaced", mode: input.mode, detail: input.detail, taskTextPrefix: input.taskText, agentRole: input.agentRole,
  });
}

export function buildForkRecord(input: {
  readonly delegationId: string;
  readonly model: string;
  readonly effort: string;
  readonly parentSession: string;
  readonly forkPoint: string | null;
  readonly banListException: boolean;
  readonly parentDelegationId?: string;
  readonly at?: Date;
}): ForkRecord {
  return checkedRecord({
    recordType: "fork", schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    delegationId: input.delegationId, timestamp: (input.at ?? new Date()).toISOString(),
    model: input.model, effort: input.effort, parentSession: input.parentSession,
    forkPoint: input.forkPoint, banListException: input.banListException,
    ...(input.parentDelegationId === undefined ? {} : { parentDelegationId: input.parentDelegationId }),
  });
}

export function buildAgentModelRecord(input: {
  readonly delegationId: string;
  readonly agent: string;
  readonly definitionFile: string;
  readonly model: string;
  readonly effort: string;
  readonly banListException?: boolean;
  readonly at?: Date;
}): AgentModelRecord {
  return checkedRecord({
    recordType: "agent-model", schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    delegationId: input.delegationId, timestamp: (input.at ?? new Date()).toISOString(),
    agent: input.agent, definitionFile: input.definitionFile, model: input.model, effort: input.effort,
    ...(input.banListException ? { banListException: true } : {}),
  });
}

export function buildEditRecord(input: {
  readonly delegationId: string;
  readonly orchestratorSession: string;
  readonly tool: string;
  readonly nestedDelegationId?: string;
  /** The changed paths of a working-tree record; more than EDIT_RECORD_PATH_LIMIT are counted, not named. */
  readonly paths?: readonly string[];
  readonly at?: Date;
}): EditRecord {
  const paths = input.paths?.slice(0, EDIT_RECORD_PATH_LIMIT);
  const omitted = (input.paths?.length ?? 0) - (paths?.length ?? 0);
  return checkedRecord({
    recordType: "edit", schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    delegationId: input.delegationId, timestamp: (input.at ?? new Date()).toISOString(),
    orchestratorSession: input.orchestratorSession, tool: input.tool,
    ...(input.nestedDelegationId === undefined ? {} : { nestedDelegationId: input.nestedDelegationId }),
    ...(paths === undefined ? {} : { paths }),
    ...(omitted > 0 ? { omittedPaths: omitted } : {}),
  });
}

export function buildGateRequirementRecord(input: {
  readonly delegationId: string;
  readonly gateLevel: GateLevel;
  readonly gateAction: GateAction;
  readonly at?: Date;
}): GateRequirementRecord {
  return checkedRecord({
    recordType: "gate-requirement", schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    delegationId: input.delegationId, timestamp: (input.at ?? new Date()).toISOString(),
    gateLevel: input.gateLevel, gateAction: input.gateAction,
  });
}

export function buildFailoverRecord(input: {
  readonly delegationId: string;
  readonly at: Date;
  readonly refusedAttempt: { readonly timestamp: string; readonly rung: string };
  readonly limit: FailoverRecord["limit"];
  readonly resetsAt?: string;
  readonly detail: string;
  readonly rung: string;
}): FailoverRecord {
  return checkedRecord({
    recordType: "failover", schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    delegationId: input.delegationId, timestamp: input.at.toISOString(),
    refusedAttempt: { timestamp: input.refusedAttempt.timestamp, rung: input.refusedAttempt.rung },
    limit: input.limit, ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
    detail: input.detail, rung: input.rung,
  });
}

export function buildDecisionRecord(input: DecisionRecordInput): DecisionRecord {
  const constraints = recordedConstraints(input.constraints);
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
    ...(input.parentDelegationId === undefined ? {} : { parentDelegationId: input.parentDelegationId }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(input.reviewedDelegationId === undefined ? {} : { reviewedDelegationId: input.reviewedDelegationId }),
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
  /** A reader that can stat a day file lets the walk reuse its parse while
   *  the stat is unchanged (`RecordFileStat`). Without it every read parses. */
  readonly stat?: (path: string) => RecordFileStat;
}

/** What says a day file is unchanged since it was parsed. */
export interface RecordFileStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
}

export const NODE_RECORD_FOLDER_READER: RecordFolderReader = {
  readdir: (dir) => readdirSync(dir),
  readFile: (path) => readFileSync(path, "utf8"),
  stat: (path) => {
    const { size, mtimeMs, ino } = statSync(path);
    return { size, mtimeMs, ino };
  },
};

export interface RoutingRecordEntry {
  readonly file: string;
  readonly line: number;
  readonly record: RoutingRecord;
}

/** A day file line that is not a valid record: its error names `<file>:<line>`. */
export interface SkippedRoutingRecordLine {
  readonly file: string;
  readonly line: number;
  /** The line as it stands in the file. */
  readonly text: string;
  readonly error: RoutingRecordError;
}

/** One parsed line of a day file: a valid record or a skipped line. */
type ParsedRecordLine = RoutingRecordEntry | SkippedRoutingRecordLine;

/** A day file's parse, kept while its stat is unchanged. */
interface ParsedRecordFile {
  readonly stat: RecordFileStat;
  readonly text: string;
  /** Lines `text` holds, counting a last line with no newline. */
  readonly lineCount: number;
  readonly lines: readonly ParsedRecordLine[];
}

/** Parsed day files by path. Each pi process reads the shared folder on every
 *  routed first request, turn end and gated result; a day file only grows, so
 *  a read reparses only what changed (pi-orchestrator-gwp1). Cached records
 *  are deep-frozen: every reader shares them. */
const parsedRecordFiles = new Map<string, ParsedRecordFile>();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Parse `text`'s lines, numbering the first `firstLine`. Blank lines are
 *  dropped; a line that is not a valid record is kept as skipped. */
function parseRecordLines(file: string, text: string, firstLine: number): ParsedRecordLine[] {
  const parsedLines: ParsedRecordLine[] = [];
  text.split("\n").forEach((lineText, index) => {
    if (lineText.trim().length === 0) return;
    const line = firstLine + index;
    const location = `${file}:${line}`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(lineText);
    } catch (error) {
      parsedLines.push({ file, line, text: lineText, error: new RoutingRecordError("(record)", `is not valid JSON (${(error as Error).message})`, location) });
      return;
    }
    try {
      parsedLines.push(Object.freeze({ file, line, record: deepFreeze(validateRoutingRecord(parsed)) }));
    } catch (error) {
      if (!(error instanceof RoutingRecordError)) throw error;
      parsedLines.push({ file, line, text: lineText, error: new RoutingRecordError(error.field, error.problem, location) });
    }
  });
  return parsedLines;
}

function sameStat(a: RecordFileStat, b: RecordFileStat): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** A day file's parsed lines. With `reader.stat`, an unchanged stat reuses the
 *  last parse without reading; a file that kept its old text whole up to a
 *  newline and grew parses only the appended tail; anything else reparses. */
function parsedRecordFile(path: string, file: string, reader: RecordFolderReader): readonly ParsedRecordLine[] {
  if (reader.stat === undefined) return parseRecordLines(file, reader.readFile(path), 1);
  const stat = reader.stat(path);
  const cached = parsedRecordFiles.get(path);
  if (cached !== undefined && sameStat(cached.stat, stat)) return cached.lines;
  const text = reader.readFile(path);
  let next: ParsedRecordFile;
  if (cached !== undefined && cached.stat.ino === stat.ino && text.length > cached.text.length &&
    cached.text.endsWith("\n") && text.startsWith(cached.text)) {
    // The cached text ends in a newline, so its last counted line is empty and
    // the tail starts on it.
    const tail = text.slice(cached.text.length);
    next = {
      stat, text, lineCount: cached.lineCount - 1 + tail.split("\n").length,
      lines: [...cached.lines, ...parseRecordLines(file, tail, cached.lineCount)],
    };
  } else {
    next = { stat, text, lineCount: text.split("\n").length, lines: parseRecordLines(file, text, 1) };
  }
  parsedRecordFiles.set(path, next);
  return next.lines;
}

/** Each record in the folder's day files, oldest file first, in file order,
 *  and each invalid line handed to `invalid`. */
function walkRecordFolder(dir: string, reader: RecordFolderReader, invalid: (skipped: SkippedRoutingRecordLine) => void): RoutingRecordEntry[] {
  let names: readonly string[];
  try {
    names = reader.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const entries: RoutingRecordEntry[] = [];
  for (const file of names.filter((name) => DAY_FILE.test(name)).sort()) {
    for (const parsed of parsedRecordFile(join(dir, file), file, reader)) {
      if ("record" in parsed) entries.push(parsed);
      else invalid(parsed);
    }
  }
  return entries;
}

/** Every record in the folder's day files, oldest file first, in file order.
 *  A folder that does not exist holds no records. Throws `RoutingRecordError`
 *  with `<file>:<line>` for the first invalid line. For the routing report,
 *  which names a bad record rather than count around it. */
export function readRoutingRecordEntries(dir: string, reader: RecordFolderReader = NODE_RECORD_FOLDER_READER): RoutingRecordEntry[] {
  return walkRecordFolder(dir, reader, ({ error }) => { throw error; });
}

export interface UsableRoutingRecordEntries {
  readonly entries: RoutingRecordEntry[];
  readonly skipped: SkippedRoutingRecordLine[];
}

/** The folder's valid records, as `readRoutingRecordEntries` reads them, and
 *  every invalid line skipped. Every pi process appends to the same folder, so
 *  it can hold a record type or shape this reader does not know yet (one
 *  written by a newer version of the extension), or a torn line; neither may
 *  block a reader that only needs the records it knows (pi-orchestrator-zb6t). */
export function readUsableRoutingRecordEntries(dir: string, reader: RecordFolderReader = NODE_RECORD_FOLDER_READER): UsableRoutingRecordEntries {
  const skipped: SkippedRoutingRecordLine[] = [];
  const entries = walkRecordFolder(dir, reader, (line) => { skipped.push(line); });
  return { entries, skipped };
}

/** The folder's valid records, skipping every invalid line (`readUsableRoutingRecordEntries`). */
export function readUsableRoutingRecords(dir: string, reader?: RecordFolderReader): RoutingRecord[] {
  return readUsableRoutingRecordEntries(dir, reader).entries.map((entry) => entry.record);
}

/** A line this reader cannot validate that belongs to a delegation being
 *  judged. It may have been written by newer code than this session loaded. */
export class UnreadableDelegationRecordError extends Error {
  readonly delegationId: string;
  readonly file: string;
  readonly line: number;
  readonly recordError: RoutingRecordError;
  constructor(delegationId: string, skipped: SkippedRoutingRecordLine) {
    super(`routing record ${skipped.file}:${skipped.line} of delegation ${delegationId} cannot be read ` +
      `(field '${skipped.error.field}' ${skipped.error.problem}); it may come from newer code than this session has loaded, so /reload may be needed`);
    this.name = "UnreadableDelegationRecordError";
    this.delegationId = delegationId;
    this.file = skipped.file;
    this.line = skipped.line;
    this.recordError = skipped.error;
  }
}

/** The delegation of `ids` a skipped line belongs to: the one its
 *  delegationId or nestedDelegationId names, else the first whose id the raw
 *  line contains; `undefined` when it belongs to none of them. */
function ownerOfSkippedLine(skipped: SkippedRoutingRecordLine, ids: readonly string[]): string | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(skipped.text); } catch { parsed = undefined; }
  if (isObject(parsed)) {
    const named = ids.find((id) => parsed.delegationId === id || parsed.nestedDelegationId === id);
    if (named !== undefined) return named;
  }
  return ids.find((id) => skipped.text.includes(id));
}

export interface JudgedRoutingRecords extends UsableRoutingRecordEntries {
  readonly records: RoutingRecord[];
}

/** The folder's records for a reader that judges the delegations `ids` (a
 *  verdict: the judged delegation and its reviewer). It fails closed: a line it
 *  cannot validate that belongs to one of them throws
 *  `UnreadableDelegationRecordError`, since judging without that record could
 *  let a verdict through that the record would refuse (a critical decision
 *  read as none, a later edit missed). Lines of other delegations are skipped
 *  and returned, as `readUsableRoutingRecordEntries` does (pi-orchestrator-zb6t). */
export function readRoutingRecordsJudging(dir: string, ids: readonly string[], reader?: RecordFolderReader): JudgedRoutingRecords {
  const { entries, skipped } = readUsableRoutingRecordEntries(dir, reader);
  for (const line of skipped) {
    const owner = ownerOfSkippedLine(line, ids);
    if (owner !== undefined) throw new UnreadableDelegationRecordError(owner, line);
  }
  return { entries, skipped, records: entries.map((entry) => entry.record) };
}

export function readRoutingRecords(dir: string, reader?: RecordFolderReader): RoutingRecord[] {
  return readRoutingRecordEntries(dir, reader).map((entry) => entry.record);
}
