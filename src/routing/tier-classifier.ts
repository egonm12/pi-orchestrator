// Ticket 23: the classifier. Assigns a tier to one delegated task (stories
// 13 to 20, ADR 0003). Only the classifier model chooses the tier (ADR 0015):
// no keyword list raises or replaces its answer.
//
//   1. Model chain. The primary rung, then each fallback rung in order. Each
//      hop has the configured timeout. A timeout, a schema-invalid answer, an
//      unknown tier, a thrown error or a provider out of usage moves to the
//      next hop. A rung refused at load (subagent ban list, allowed-model list,
//      no effort) is skipped without being called. The first hop that decides
//      gives the tier, with the model's own `why` and `risk.reasons`.
//   2. Unclassified. When no model hop decides, the task runs as `elevated`
//      and the cause is `unclassified` (CONTEXT.md, Unclassified task).
//
// Every model hop reserves against the shared task allowance (ticket 09)
// under the label `classifier` before the call and settles after it. With no
// allowance left the hop is skipped and the record says so.
//
// The model call is injected (`ClassifierModelCall`), so tests use fakes. The
// router uses `sessionClassifierModelCall` (./session-classifier-call.ts),
// which classifies inside the running pi session (ADR 0004); ticket 23's
// live test uses the `pi -p` subprocess, `piClassifierModelCall` in
// ./pi-classifier-call.ts.

import {
  ReconciliationError,
  remainingUsd,
  type TaskAllowanceOwner,
} from "../budget/task-allowance.ts";
import type { ModelCatalog } from "../catalog/model-catalog.ts";
import {
  splitKnownThinkingSuffix,
  THINKING_LEVELS,
} from "../models/model-info.ts";
import { resolveDelegationModel } from "../policy/model-resolution.ts";
import type { RiskTier } from "./tiers.ts";
import {
  checkTierAnswer,
  SCHEMA_VERSION,
  type AmbiguityLevel,
  type ComplexityLevel,
  type KindOfWork,
  type RiskLevel,
  type TierAnswer,
} from "./tier-answer-schema.ts";
import { classifierPrompt, RUBRIC_VERSION, type ClassifierInput } from "./tier-rubric.ts";

// ---------------------------------------------------------------------------
// Settings: orchestrator.routing.classifier
// ---------------------------------------------------------------------------

export interface ClassifierConfig {
  /** Primary classifier rung, `provider/model:effort`. */
  readonly model: string;
  /** Per-hop timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Fallback rungs tried in order after the primary. When none decides,
   *  the task is unclassified. */
  readonly fallback: readonly string[];
}

export const DEFAULT_CLASSIFIER_RUNG = "openai-codex/gpt-6-luna:low";

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = Object.freeze({
  model: DEFAULT_CLASSIFIER_RUNG,
  timeoutMs: 30_000,
  fallback: Object.freeze([]),
});

const CLASSIFIER_KEYS = ["model", "timeoutMs", "fallback"] as const;
const SETTINGS_KEY = "orchestrator.routing.classifier";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(parent: Record<string, unknown>, key: string, dotted: string): Record<string, unknown> | undefined {
  const value = parent[key];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`${dotted} must be an object; got ${JSON.stringify(value)}.`);
  return value;
}

function rungSetting(value: unknown, dotted: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${dotted} must be a non-empty rung string provider/model:effort; got ${JSON.stringify(value)}.`);
  }
  return value.trim();
}

/** Pure: the classifier config from parsed personal settings. Absent keys take
 *  the defaults; a malformed or unknown key fails closed naming the key. Only
 *  personal settings are read, so a project cannot change the classifier. */
export function classifierConfigFromSettings(personal: unknown): ClassifierConfig {
  if (!isPlainObject(personal)) throw new Error("personal settings must be a JSON object.");
  const orchestrator = objectAt(personal, "orchestrator", "orchestrator");
  const routing = orchestrator && objectAt(orchestrator, "routing", "orchestrator.routing");
  const classifier = routing && objectAt(routing, "classifier", SETTINGS_KEY);
  if (!classifier) return DEFAULT_CLASSIFIER_CONFIG;

  const unknownKeys = Object.keys(classifier).filter((key) => !(CLASSIFIER_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${SETTINGS_KEY} has unknown key(s) ${unknownKeys.map((key) => `${SETTINGS_KEY}.${key}`).join(", ")}.`);
  }

  const model = classifier.model === undefined
    ? DEFAULT_CLASSIFIER_CONFIG.model
    : rungSetting(classifier.model, `${SETTINGS_KEY}.model`);

  const { timeoutMs: rawTimeout } = classifier;
  if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0)) {
    throw new Error(`${SETTINGS_KEY}.timeoutMs must be a positive integer of milliseconds; got ${JSON.stringify(rawTimeout)}.`);
  }
  const timeoutMs = rawTimeout ?? DEFAULT_CLASSIFIER_CONFIG.timeoutMs;

  const { fallback: rawFallback } = classifier;
  if (rawFallback !== undefined && !Array.isArray(rawFallback)) {
    throw new Error(`${SETTINGS_KEY}.fallback must be an array of rung strings; got ${JSON.stringify(rawFallback)}.`);
  }
  const fallback = rawFallback === undefined
    ? DEFAULT_CLASSIFIER_CONFIG.fallback
    : Object.freeze(rawFallback.map((rung, index) => rungSetting(rung, `${SETTINGS_KEY}.fallback[${index}]`)));

  return Object.freeze({ model, timeoutMs, fallback });
}

// ---------------------------------------------------------------------------
// Load: every classifier rung is held to the same rules as any delegation
// ---------------------------------------------------------------------------

export interface ClassifierChainEntry {
  readonly rung: string;
  /** Present when the rung was refused at load; the hop is then skipped. */
  readonly refusal?: string;
}

export interface ClassifierChainRefusal {
  readonly rung: string;
  readonly error: string;
}

export interface LoadedClassifierChain {
  readonly timeoutMs: number;
  /** Primary first, then fallbacks, in config order, refused rungs included. */
  readonly entries: readonly ClassifierChainEntry[];
  readonly refusals: readonly ClassifierChainRefusal[];
}

function loadRefusal(rung: string): string | undefined {
  const refused = (why: string) => `classifier rung '${rung}' refused at load: ${why}`;
  const { thinkingSuffix } = splitKnownThinkingSuffix(rung);
  if (!thinkingSuffix) {
    return refused(`a rung must be written provider/model:effort, with effort one of ${THINKING_LEVELS.join(", ")}`);
  }
  // The subagent ban list and the allowed-model list, through the same
  // resolver every delegation uses (ticket 04, ticket 21).
  const decision = resolveDelegationModel({ model: rung, source: "explicit" });
  return decision.ok ? undefined : refused(decision.message);
}

export function loadClassifierChain(config: ClassifierConfig): LoadedClassifierChain {
  const entries = [config.model, ...config.fallback].map((rung): ClassifierChainEntry => {
    const refusal = loadRefusal(rung);
    return refusal === undefined ? { rung } : { rung, refusal };
  });
  const refusals = entries.flatMap((entry) => (entry.refusal === undefined ? [] : [{ rung: entry.rung, error: entry.refusal }]));
  return { timeoutMs: config.timeoutMs, entries, refusals };
}

// ---------------------------------------------------------------------------
// The injected model call
// ---------------------------------------------------------------------------

export interface ClassifierModelReply {
  readonly text: string;
  /** Cost figure the runtime reported, when it reported one. Needed to settle
   *  a metered reservation; on a subscription route it is kept as a
   *  consumption signal only. */
  readonly reportedUsd?: number;
}

/** One classifier model call. `rung` is `provider/model:effort`; the call must
 *  stop when `signal` aborts (the hop's timeout). */
export type ClassifierModelCall = (
  prompt: string,
  rung: string,
  signal: AbortSignal,
) => Promise<string | ClassifierModelReply>;

/** Thrown by a model call whose provider refused for usage or quota. */
export class ProviderOutOfUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOutOfUsageError";
  }
}

// ---------------------------------------------------------------------------
// The shared task allowance
// ---------------------------------------------------------------------------

export const CLASSIFIER_ALLOWANCE_LABEL = "classifier";

/** Token ceilings for a classifier reservation. The prompt's UTF-8 byte count
 *  bounds its tokens; the overhead covers pi's own system prompt; the output
 *  ceiling covers low-effort thinking plus the JSON answer. Only a metered
 *  route turns these into dollars. */
export const CLASSIFIER_PROMPT_OVERHEAD_TOKENS = 2_000;
export const CLASSIFIER_MAX_OUTPUT_TOKENS = 4_000;

export interface ClassifierAllowance {
  readonly owner: TaskAllowanceOwner;
  readonly catalog: ModelCatalog;
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

export type HopOutcomeKind =
  | "decided"
  | "refused-at-load"
  | "allowance-exhausted"
  | "allowance-refused"
  | "timeout"
  | "schema-invalid"
  | "unknown-tier"
  | "out-of-usage"
  | "error";

export interface HopOutcome {
  /** The rung. */
  readonly hop: string;
  readonly outcome: HopOutcomeKind;
  readonly detail?: string;
  /** How the hop's reservation ended: `settled`, or `held-open` when a
   *  metered call reported no cost (ticket 09 keeps that hold). */
  readonly allowance?: { readonly reservationId: string; readonly settlement: "settled" | "held-open" };
}

/** What gave the tier: the deciding model hop, `unclassified` when none
 *  decided, or `retry:<delegation id>` for a retry routed on the tier of the
 *  delegation it retries (CONTEXT.md, Retry tier), which is not classified. */
export type ClassifierCause = `model:${string}` | "unclassified" | `retry:${string}`;

/** The tier an unclassified task runs at. */
export const UNCLASSIFIED_TIER: RiskTier = "elevated";

export interface TierClassification {
  readonly tier: RiskTier;
  readonly cause: ClassifierCause;
  /** `unassessed` and no reasons when the task is unclassified. */
  readonly risk: { readonly level: RiskLevel | "unassessed"; readonly reasons: readonly string[] };
  /** `unassessed` when the task is unclassified, here and in the two below. */
  readonly ambiguity: AmbiguityLevel | "unassessed";
  readonly complexity: ComplexityLevel | "unassessed";
  readonly kindOfWork: KindOfWork | "unassessed";
  /** The deciding model's reason for the tier. */
  readonly why: string;
  readonly rubricVersion: string;
  readonly schemaVersion: string;
  readonly hops: readonly HopOutcome[];
}

// ---------------------------------------------------------------------------
// One model hop
// ---------------------------------------------------------------------------

class HopTimeout extends Error {}

async function callWithTimeout(
  callModel: ClassifierModelCall,
  prompt: string,
  rung: string,
  timeoutMs: number,
): Promise<string | ClassifierModelReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new HopTimeout(`no answer within ${timeoutMs} ms`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    const call = Promise.resolve().then(() => callModel(prompt, rung, controller.signal));
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function failureOutcome(error: unknown): { outcome: HopOutcomeKind; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof HopTimeout) return { outcome: "timeout", detail };
  if (error instanceof ProviderOutOfUsageError) return { outcome: "out-of-usage", detail };
  return { outcome: "error", detail };
}

function settle(
  owner: TaskAllowanceOwner,
  reservationId: string,
  reportedUsd: number | undefined,
): NonNullable<HopOutcome["allowance"]> {
  try {
    owner.reconcile({ reservationId, ...(reportedUsd === undefined ? {} : { reportedUsd }) });
    return { reservationId, settlement: "settled" };
  } catch (error) {
    if (error instanceof ReconciliationError && error.code === "missing_reported_cost") {
      return { reservationId, settlement: "held-open" };
    }
    throw error;
  }
}

function isValidReportedUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

type HopResult =
  | { readonly decided: true; readonly outcome: HopOutcome; readonly answer: TierAnswer }
  | { readonly decided: false; readonly outcome: HopOutcome };

async function modelHop(
  rung: string,
  prompt: string,
  timeoutMs: number,
  callModel: ClassifierModelCall,
  { owner, catalog }: ClassifierAllowance,
): Promise<HopResult> {
  const ledger = owner.snapshot();
  if (remainingUsd(ledger) <= 0) {
    return {
      decided: false,
      outcome: {
        hop: rung,
        outcome: "allowance-exhausted",
        detail:
          `no remaining task allowance on task '${ledger.taskId}' ` +
          `($${remainingUsd(ledger).toFixed(4)} of $${ledger.allowanceUsd.toFixed(2)}); the hop was skipped`,
      },
    };
  }
  const reserved = owner.reserve(
    {
      model: splitKnownThinkingSuffix(rung).baseModel,
      role: "orchestration",
      label: CLASSIFIER_ALLOWANCE_LABEL,
      maxInputTokens: Buffer.byteLength(prompt, "utf8") + CLASSIFIER_PROMPT_OVERHEAD_TOKENS,
      maxOutputTokens: CLASSIFIER_MAX_OUTPUT_TOKENS,
    },
    catalog,
  );
  if (!reserved.ok) {
    return { decided: false, outcome: { hop: rung, outcome: "allowance-refused", detail: reserved.message } };
  }
  const { reservationId } = reserved.reservation;

  let reply: string | ClassifierModelReply;
  try {
    reply = await callWithTimeout(callModel, prompt, rung, timeoutMs);
  } catch (error) {
    const allowance = settle(owner, reservationId, undefined);
    return { decided: false, outcome: { hop: rung, ...failureOutcome(error), allowance } };
  }
  const text = typeof reply === "string" ? reply : reply.text;
  const reportedUsd = typeof reply === "string" ? undefined : reply.reportedUsd;
  // A malformed cost is treated as no reported cost, so a metered hold stays
  // open, and the hop is an error: its answer came with untrustworthy data.
  if (reportedUsd !== undefined && !isValidReportedUsd(reportedUsd)) {
    const allowance = settle(owner, reservationId, undefined);
    return {
      decided: false,
      outcome: {
        hop: rung,
        outcome: "error",
        detail: `the call returned an invalid reported cost (${String(reportedUsd)}); treated as no reported cost`,
        allowance,
      },
    };
  }
  const allowance = settle(owner, reservationId, reportedUsd);
  const answer = checkTierAnswer(text);
  if (!answer.ok) {
    return { decided: false, outcome: { hop: rung, outcome: answer.outcome, detail: answer.detail, allowance } };
  }
  return { decided: true, answer: answer.answer, outcome: { hop: rung, outcome: "decided", allowance } };
}

// ---------------------------------------------------------------------------
// The public function (seam 1)
// ---------------------------------------------------------------------------

export interface ClassifyTierOptions {
  readonly chain: LoadedClassifierChain;
  readonly callModel: ClassifierModelCall;
  readonly allowance: ClassifierAllowance;
}

export async function classifyTier(input: ClassifierInput, options: ClassifyTierOptions): Promise<TierClassification> {
  // Read the three inputs by name, so nothing else a caller's object carries
  // (a conversation, say) can reach the prompt.
  const prompt = classifierPrompt({ task: input.task, role: input.role, paths: [...input.paths] });
  const versions = { rubricVersion: RUBRIC_VERSION, schemaVersion: SCHEMA_VERSION };
  const hops: HopOutcome[] = [];

  for (const entry of options.chain.entries) {
    if (entry.refusal !== undefined) {
      hops.push({ hop: entry.rung, outcome: "refused-at-load", detail: entry.refusal });
      continue;
    }
    const result = await modelHop(entry.rung, prompt, options.chain.timeoutMs, options.callModel, options.allowance);
    hops.push(result.outcome);
    if (!result.decided) continue;
    const { answer } = result;
    return {
      tier: answer.tier,
      cause: `model:${entry.rung}`,
      risk: answer.risk,
      ambiguity: answer.ambiguity,
      complexity: answer.complexity,
      kindOfWork: answer.kindOfWork,
      why: answer.why,
      ...versions,
      hops,
    };
  }

  // No hop decided: the words of the task are not read for a tier (ADR 0015).
  return {
    tier: UNCLASSIFIED_TIER,
    cause: "unclassified",
    risk: { level: "unassessed", reasons: [] },
    ambiguity: "unassessed",
    complexity: "unassessed",
    kindOfWork: "unassessed",
    why: `no classifier model could classify the task, so it runs as ${UNCLASSIFIED_TIER}`,
    ...versions,
    hops,
  };
}
