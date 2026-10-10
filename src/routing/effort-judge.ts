import {
  getSupportedThinkingLevels,
  splitKnownThinkingSuffix,
  THINKING_LEVELS,
  type ModelInfo,
  type ThinkingLevel,
} from "../models/model-info.ts";
import { resolveDelegationModel } from "../policy/model-resolution.ts";
import {
  DEFAULT_CLASSIFIER_CONFIG,
  classifierConfigFromSettings,
  type ClassifierConfig,
} from "./tier-classifier.ts";
import { effortJudgePrompt } from "./effort-rubric.ts";
import type { EffortBand, EffortJudgeInput } from "./effort-rubric.ts";

export type { EffortBand, EffortJudgeInput, EffortJudgeKind } from "./effort-rubric.ts";

export interface EffortJudgeConfig {
  readonly model: string;
  readonly timeoutMs: number;
  readonly fallback: readonly string[];
}

export const DEFAULT_EFFORT_JUDGE_MODEL = "anthropic/claude-haiku-5-5:low";

function classifierFallback(classifier: ClassifierConfig): readonly string[] {
  return Object.freeze([classifier.model, ...classifier.fallback]);
}

export const DEFAULT_EFFORT_JUDGE_CONFIG: EffortJudgeConfig = Object.freeze({
  model: DEFAULT_EFFORT_JUDGE_MODEL,
  timeoutMs: 30_000,
  fallback: classifierFallback(DEFAULT_CLASSIFIER_CONFIG),
});

const SETTINGS_KEY = "orchestrator.routing.effortJudge";
const EFFORT_JUDGE_KEYS = ["model", "timeoutMs", "fallback"] as const;

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

/** Pure: read the effort judge only from personal settings. When its fallback
 *  is omitted, it follows the classifier's configured primary and fallbacks. */
export function effortJudgeConfigFromSettings(personal: unknown): EffortJudgeConfig {
  const classifier = classifierConfigFromSettings(personal);
  if (!isPlainObject(personal)) throw new Error("personal settings must be a JSON object.");
  const orchestrator = objectAt(personal, "orchestrator", "orchestrator");
  const routing = orchestrator && objectAt(orchestrator, "routing", "orchestrator.routing");
  const judge = routing && objectAt(routing, "effortJudge", SETTINGS_KEY);
  const inheritedFallback = classifierFallback(classifier);
  if (!judge) {
    return Object.freeze({ ...DEFAULT_EFFORT_JUDGE_CONFIG, fallback: inheritedFallback });
  }

  const unknownKeys = Object.keys(judge).filter((key) => !(EFFORT_JUDGE_KEYS as readonly string[]).includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`${SETTINGS_KEY} has unknown key(s) ${unknownKeys.map((key) => `${SETTINGS_KEY}.${key}`).join(", ")}.`);
  }

  const model = judge.model === undefined
    ? DEFAULT_EFFORT_JUDGE_CONFIG.model
    : rungSetting(judge.model, `${SETTINGS_KEY}.model`);
  const { timeoutMs: rawTimeout } = judge;
  if (rawTimeout !== undefined && (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout <= 0)) {
    throw new Error(`${SETTINGS_KEY}.timeoutMs must be a positive integer of milliseconds; got ${JSON.stringify(rawTimeout)}.`);
  }
  const timeoutMs = rawTimeout ?? DEFAULT_EFFORT_JUDGE_CONFIG.timeoutMs;
  const { fallback: rawFallback } = judge;
  if (rawFallback !== undefined && !Array.isArray(rawFallback)) {
    throw new Error(`${SETTINGS_KEY}.fallback must be an array of rung strings; got ${JSON.stringify(rawFallback)}.`);
  }
  const fallback = rawFallback === undefined
    ? inheritedFallback
    : Object.freeze(rawFallback.map((rung, index) => rungSetting(rung, `${SETTINGS_KEY}.fallback[${index}]`)));

  return Object.freeze({ model, timeoutMs, fallback });
}

export interface EffortJudgeChainEntry {
  readonly rung: string;
  readonly refusal?: string;
}

export interface LoadedEffortJudgeChain {
  readonly timeoutMs: number;
  readonly entries: readonly EffortJudgeChainEntry[];
  readonly refusals: readonly { readonly rung: string; readonly error: string }[];
}

function effortJudgeLoadRefusal(rung: string, models: readonly ModelInfo[]): string | undefined {
  const refused = (why: string) => `effort judge rung '${rung}' refused at load: ${why}`;
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(rung);
  if (!thinkingSuffix) {
    return refused(`a rung must name a supported effort level: ${THINKING_LEVELS.join(", ")}`);
  }
  const resolved = resolveDelegationModel({ model: rung, source: "explicit" });
  if (!resolved.ok) return refused(resolved.message);

  const installed = models.find((model) => model.fullId === baseModel);
  if (installed === undefined) return refused(`model '${baseModel}' is not installed`);
  const effort = thinkingSuffix.slice(1) as ThinkingLevel;
  const supported = getSupportedThinkingLevels(installed);
  if (!supported.includes(effort)) {
    return refused(`effort '${effort}' is not supported by '${baseModel}'; supported levels: ${supported.join(", ")}`);
  }
  return undefined;
}

/** Load the primary and fallback rungs against installed model capabilities. */
export function loadEffortJudgeChain(
  config: EffortJudgeConfig,
  models: readonly ModelInfo[],
): LoadedEffortJudgeChain {
  const entries = [config.model, ...config.fallback].map((rung): EffortJudgeChainEntry => {
    const refusal = effortJudgeLoadRefusal(rung, models);
    return refusal === undefined ? { rung } : { rung, refusal };
  });
  const refusals = entries.flatMap((entry) => (entry.refusal === undefined ? [] : [{ rung: entry.rung, error: entry.refusal }]));
  return { timeoutMs: config.timeoutMs, entries, refusals };
}

export interface EffortJudgeModelReply {
  readonly text: string;
  readonly reportedUsd?: number;
}

/** Compatible with the classifier's in-session model call. */
export type EffortJudgeModelCall = (
  prompt: string,
  rung: string,
  signal: AbortSignal,
) => Promise<string | EffortJudgeModelReply>;

export interface EffortJudgeDecision {
  readonly from: ThinkingLevel;
  readonly to: ThinkingLevel;
  /** `now` applies `to` at once; `declined` keeps `from`: a lower effort
   *  chosen while a run is in progress (ADR 0018); `none` is no change. */
  readonly applyAt: "now" | "declined" | "none";
  readonly reason: string;
  readonly judgeModel: string | "skipped" | "fallback";
}

export interface JudgeEffortOptions {
  readonly chain: LoadedEffortJudgeChain;
  readonly callModel: EffortJudgeModelCall;
}

function effortIndex(effort: ThinkingLevel): number {
  return THINKING_LEVELS.indexOf(effort);
}

function decision(
  input: EffortJudgeInput,
  to: ThinkingLevel,
  reason: string,
  judgeModel: EffortJudgeDecision["judgeModel"],
): EffortJudgeDecision {
  if (to === input.currentEffort) {
    return { from: input.currentEffort, to, applyAt: "none", reason, judgeModel };
  }
  const applyAt = input.turnRunning && effortIndex(to) < effortIndex(input.currentEffort) ? "declined" : "now";
  return { from: input.currentEffort, to, applyAt, reason, judgeModel };
}

interface EffortAnswer {
  readonly effort: ThinkingLevel;
  readonly why: string;
}

function checkEffortAnswer(text: string): EffortAnswer {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("effort judge reply was not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("effort judge reply must be a JSON object");
  }
  const answer = value as Record<string, unknown>;
  if (Object.keys(answer).some((key) => key !== "effort" && key !== "why")) {
    throw new Error("effort judge reply has an unknown property");
  }
  if (typeof answer.effort !== "string" || !THINKING_LEVELS.includes(answer.effort as ThinkingLevel)) {
    throw new Error("effort judge reply has an unknown effort");
  }
  if (typeof answer.why !== "string" || answer.why.trim().length === 0) {
    throw new Error("effort judge reply needs a non-empty why");
  }
  return { effort: answer.effort as ThinkingLevel, why: answer.why.trim() };
}

class EffortJudgeTimeout extends Error {}

async function callWithTimeout(
  callModel: EffortJudgeModelCall,
  prompt: string,
  rung: string,
  timeoutMs: number,
): Promise<string | EffortJudgeModelReply> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EffortJudgeTimeout(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    const call = Promise.resolve().then(() => callModel(prompt, rung, controller.signal));
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function clampToBand(effort: ThinkingLevel, band: EffortBand): ThinkingLevel {
  const level = effortIndex(effort);
  const min = effortIndex(band.min);
  const max = effortIndex(band.max);
  if (min > max) throw new Error(`invalid effort band ${band.min}-${band.max}`);
  return level < min ? band.min : level > max ? band.max : effort;
}

function isShortFollowUp(input: EffortJudgeInput): boolean {
  // A short reply from the owner or the orchestrator ("yes", "thanks") keeps
  // the effort; a task or retry feedback is new work and is always judged.
  if (input.kind === "task" || input.kind === "retry-feedback") return false;
  // "ultrathink" asks for more effort, however short the message.
  if (/ultrathink/i.test(input.message)) return false;
  const trimmed = input.message.trim();
  const words = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  return trimmed.length <= 12 && words.length <= 2;
}

/** Judge an incoming message without changing session or worker state. */
export async function judgeEffort(
  input: EffortJudgeInput,
  options: JudgeEffortOptions,
): Promise<EffortJudgeDecision> {
  if (isShortFollowUp(input)) {
    return decision(input, input.currentEffort, "short follow-up kept the current effort", "skipped");
  }
  const prompt = effortJudgePrompt(input);
  let lastError: string | undefined;
  for (const entry of options.chain.entries) {
    if (entry.refusal !== undefined) {
      lastError = entry.refusal;
      continue;
    }
    try {
      const reply = await callWithTimeout(options.callModel, prompt, entry.rung, options.chain.timeoutMs);
      const text = typeof reply === "string" ? reply : reply.text;
      const answer = checkEffortAnswer(text);
      return decision(input, clampToBand(answer.effort, input.band), answer.why, entry.rung);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  const detail = lastError ?? "no callable judge models in the configured chain";
  return decision(
    input,
    input.band.max,
    `effort judge fallback to band maximum: ${detail}`,
    "fallback",
  );
}
