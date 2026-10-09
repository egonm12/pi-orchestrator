// The effort cache probe (bean pi-orchestrator-zv3l): the request payloads and
// the result evaluator. Pure: no network and no pi. The runner
// (src/live-check/run-effort-cache-probe.ts) sends these payloads through pi,
// and the pi extension (src/live-check/effort-cache-probe.ts) swaps each one in
// before its request, so pi's own auth, refresh and OAuth shaping still apply.
//
// Two cache-safe paths are measured, both from the docs:
// - Claude (platform.claude.com, effort, "Per-message effort (beta)"): a
//   system message `{role: "system", content: [], output_config: {effort}}`
//   with the beta `mid-conversation-output-config-2026-07-01`, and the
//   top-level `output_config.effort` left at its starting value.
// - OpenAI GPT-6 (developers.openai.com, reasoning, "Change reasoning
//   mid-conversation"): an input item `{type: "configuration_update",
//   reasoning: {effort}}` before the next user message, with the request-level
//   `reasoning.effort` left unchanged.

type Loose = Record<string, unknown>;

export const PROBE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ProbeEffort = (typeof PROBE_EFFORTS)[number];

export const CLAUDE_MID_CONVERSATION_BETA = "mid-conversation-output-config-2026-07-01";
/** The identity block pi sends first for an OAuth token, so the request is a Claude Code request. */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export const PROBE_TOOL_NAME = "lookup_numbers";
export const PROBE_NUMBERS = "91, 97, 127, 133, 221, 251, 299";
export const FIRST_TURN = "Reply with the single word: noted.";
export const NEW_TURN = `Which of these numbers are prime: ${PROBE_NUMBERS}? Answer in one line.`;
export const TOOL_TURN = "Fetch the number list with the lookup_numbers tool, then say which of its numbers are prime, in one line.";
const ASSISTANT_ACK = "noted.";
const CLAUDE_TOOL_USE_ID = "toolu_effort_probe_1";
const OPENAI_CALL_ID = "call_effort_probe_1";

/** Stable text sized to sit just above each provider's minimum cacheable prompt. */
const CLAUDE_NOTES_CHARS = 3200;
const OPENAI_NOTES_CHARS = 9000;
/** Tiny on purpose: the probe reads usage, not a long answer. */
const CLAUDE_MAX_TOKENS = 1024;

export interface ProbeModel {
  readonly provider: "anthropic" | "openai-codex";
  /** The id pi knows the model by, after the provider and a slash. */
  readonly id: string;
  readonly path: "claude-per-message" | "openai-configuration-update";
  /** The documented minimum cacheable prompt length, in tokens. */
  readonly minimumCacheTokens: number;
  readonly startEffort: ProbeEffort;
  readonly changedEffort: ProbeEffort;
}

const CLAUDE_PATH = "claude-per-message";
const OPENAI_PATH = "openai-configuration-update";

/** The owner's list: Haiku 5.5 first, then one probe each for Sonnet 5.5 and Opus 5.5, and the two GPT-6 models. */
export const PROBE_MODELS = {
  haiku: { provider: "anthropic", id: "claude-haiku-5-5", path: CLAUDE_PATH, minimumCacheTokens: 512, startEffort: "low", changedEffort: "high" },
  sonnet: { provider: "anthropic", id: "claude-sonnet-5-5", path: CLAUDE_PATH, minimumCacheTokens: 512, startEffort: "low", changedEffort: "high" },
  opus: { provider: "anthropic", id: "claude-opus-5-5", path: CLAUDE_PATH, minimumCacheTokens: 512, startEffort: "low", changedEffort: "high" },
  astra: { provider: "openai-codex", id: "gpt-6-astra", path: OPENAI_PATH, minimumCacheTokens: 1024, startEffort: "low", changedEffort: "high" },
  sol: { provider: "openai-codex", id: "gpt-6.1-sol", path: OPENAI_PATH, minimumCacheTokens: 1024, startEffort: "low", changedEffort: "high" },
} as const satisfies Record<string, ProbeModel>;

const SENTENCES = [
  "The depot ledger records every pallet that leaves the cold store and the dock it leaves from.",
  "Carriers confirm pickups by scanning the manifest at the gate before the trailer is sealed.",
  "Weekly reconciliation compares the warehouse count with the carrier log and flags any gap for review.",
  "Damaged cartons are photographed, tagged with a reason code, and held until a supervisor signs them off.",
  "Route planners group deliveries by postal district so that each van completes its stops in one loop.",
  "Returns arrive in plastic crates, and each crate is weighed before its contents are checked against the order.",
  "Temperature logs from the reefer units are attached to the shipment record for the full transit window.",
  "Seasonal demand forecasts adjust the reorder points for slow movers at the start of each quarter.",
  "Dock appointments are booked in fifteen minute slots, and late arrivals move to the back of the queue.",
  "Audit trails keep the name of every operator who changed a stock level, together with the reason given.",
];

/** Deterministic, prose-like notes of at least `minChars` characters. */
export function probeNotes(minChars: number): string {
  const lines = ["Stable reference notes for the effort cache probe. Keep them unchanged."];
  for (let n = 1; lines.join("\n").length < minChars; n++) lines.push(`${n}. ${SENTENCES[n % SENTENCES.length]}`);
  return lines.join("\n");
}

export type ProbeStepId = "R1" | "R2" | "C2" | "NC" | "TA" | "TB" | "TH";

export interface ProbeStep {
  readonly id: ProbeStepId;
  readonly purpose: string;
  /** The top-level effort the request carries. */
  readonly topEffort: ProbeEffort;
  /** Fields to put over pi's own payload. */
  readonly overrides: Loose;
}

/**
 * The steps for one model, in order. R1 writes the cache. R2 is the change
 * under test on a new user turn, C2 its control. NC moves the top-level effort
 * instead, which should break the cache: if it does not, the cache test cannot
 * fail. TA and TB are the tool_result pair (control and change), and TH runs
 * the same tool_result request at the changed top-level effort, as a reference
 * for what the changed effort looks like on that request.
 */
export function probePlan(model: ProbeModel): ProbeStep[] {
  return model.provider === "anthropic" ? claudeSteps(model) : openaiSteps(model);
}

function claudeSteps(model: ProbeModel): ProbeStep[] {
  const start = model.startEffort;
  const changed = model.changedEffort;
  const change = { role: "system", content: [], output_config: { effort: changed } };
  const shared = {
    system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }],
    tools: [{ name: PROBE_TOOL_NAME, description: "Returns the probe number list.", input_schema: { type: "object", properties: {}, additionalProperties: false } }],
    tool_choice: { type: "none" },
    betas: [CLAUDE_MID_CONVERSATION_BETA],
    max_tokens: CLAUDE_MAX_TOKENS,
  };
  // The stable notes carry the cache breakpoint; the question follows it in the same turn.
  const notes = { type: "text", text: probeNotes(CLAUDE_NOTES_CHARS), cache_control: { type: "ephemeral" } };
  const turn = (question: string) => ({ role: "user", content: [notes, { type: "text", text: question }] });
  const answered = [turn(FIRST_TURN), { role: "assistant", content: ASSISTANT_ACK }];
  const toolTurn = [
    turn(TOOL_TURN),
    { role: "assistant", content: [{ type: "tool_use", id: CLAUDE_TOOL_USE_ID, name: PROBE_TOOL_NAME, input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: CLAUDE_TOOL_USE_ID, content: PROBE_NUMBERS }] },
  ];
  const control = [...answered, { role: "user", content: NEW_TURN }];
  return [
    { id: "R1", purpose: "first request at the starting effort: writes the cached notes", topEffort: start,
      overrides: { ...shared, output_config: { effort: start }, messages: [turn(FIRST_TURN)] } },
    { id: "R2", purpose: "per-message change to the new effort, placed before a new user turn", topEffort: start,
      overrides: { ...shared, output_config: { effort: start }, messages: [...answered, change, { role: "user", content: NEW_TURN }] } },
    { id: "C2", purpose: "control: the same new user turn with no per-message change", topEffort: start,
      overrides: { ...shared, output_config: { effort: start }, messages: control } },
    { id: "NC", purpose: "negative control: the top-level effort changes, with no per-message change", topEffort: changed,
      overrides: { ...shared, output_config: { effort: changed }, messages: control } },
    { id: "TA", purpose: "control: the tool_result turn with no change", topEffort: start,
      overrides: { ...shared, output_config: { effort: start }, messages: toolTurn } },
    { id: "TB", purpose: "per-message change placed after a user turn that holds only a tool_result", topEffort: start,
      overrides: { ...shared, output_config: { effort: start }, messages: [...toolTurn, change] } },
    { id: "TH", purpose: "reference: the tool_result turn at the changed top-level effort, with no per-message change", topEffort: changed,
      overrides: { ...shared, output_config: { effort: changed }, messages: toolTurn } },
  ];
}

function openaiSteps(model: ProbeModel): ProbeStep[] {
  const start = model.startEffort;
  const changed = model.changedEffort;
  const change = { type: "configuration_update", reasoning: { effort: changed } };
  const shared = {
    // The notes are a developer message, not `instructions`: OpenAI counts the minimum over visible input tokens.
    instructions: "You are a helpful assistant.",
    tools: [{ type: "function", name: PROBE_TOOL_NAME, description: "Returns the probe number list.", parameters: { type: "object", properties: {}, additionalProperties: false }, strict: false }],
    tool_choice: "none",
    prompt_cache_key: `effort-cache-probe-${model.id}`,
  };
  const notes = { role: "developer", content: [{ type: "input_text", text: probeNotes(OPENAI_NOTES_CHARS) }] };
  const reasoning = (effort: ProbeEffort) => ({ effort, summary: "auto" });
  const answered = [notes, { role: "user", content: FIRST_TURN }, { role: "assistant", content: ASSISTANT_ACK }];
  const control = [...answered, { role: "user", content: NEW_TURN }];
  const call = { type: "function_call", call_id: OPENAI_CALL_ID, name: PROBE_TOOL_NAME, arguments: "{}" };
  const output = { type: "function_call_output", call_id: OPENAI_CALL_ID, output: PROBE_NUMBERS };
  const toolTurn = [notes, { role: "user", content: TOOL_TURN }, call, output];
  return [
    { id: "R1", purpose: "first request at the request-level effort: writes the cached prefix", topEffort: start,
      overrides: { ...shared, reasoning: reasoning(start), input: [notes, { role: "user", content: FIRST_TURN }] } },
    { id: "R2", purpose: "configuration_update to the new effort, placed before a new user turn", topEffort: start,
      overrides: { ...shared, reasoning: reasoning(start), input: [...answered, change, { role: "user", content: NEW_TURN }] } },
    { id: "C2", purpose: "control: the same new user turn with no update", topEffort: start,
      overrides: { ...shared, reasoning: reasoning(start), input: control } },
    { id: "NC", purpose: "negative control: the request-level effort changes, with no update", topEffort: changed,
      overrides: { ...shared, reasoning: reasoning(changed), input: control } },
    { id: "TA", purpose: "control: the function output with no update", topEffort: start,
      overrides: { ...shared, reasoning: reasoning(start), input: toolTurn } },
    { id: "TB", purpose: "configuration_update placed after the function output, with no new user turn", topEffort: start,
      overrides: { ...shared, reasoning: reasoning(start), input: [...toolTurn, change] } },
    { id: "TH", purpose: "reference: the function output at the changed request-level effort, with no update", topEffort: changed,
      overrides: { ...shared, reasoning: reasoning(changed), input: toolTurn } },
  ];
}

/** `payload` with `overrides` put over it. Betas are unioned, not replaced, so pi's OAuth betas survive. Neither input is changed. */
export function mergePayload(payload: Readonly<Loose>, overrides: Readonly<Loose>): Loose {
  const merged: Loose = { ...payload, ...overrides };
  const betas = [...new Set([...listOf(payload.betas), ...listOf(overrides.betas)])];
  if (betas.length > 0) merged.betas = betas;
  return merged;
}

function listOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** The fields of one assistant message from pi's `--mode json` output that the probe reads. */
export interface ProbeMessage {
  readonly role?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly content?: readonly unknown[];
  readonly usage?: Readonly<Record<string, unknown>>;
}

/** The last assistant message in pi's JSON event stream, or undefined when there is none. */
export function assistantMessageOf(stdout: string): ProbeMessage | undefined {
  let found: ProbeMessage | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: unknown; message?: ProbeMessage };
    try {
      event = JSON.parse(line) as { type?: unknown; message?: ProbeMessage };
    } catch {
      continue;
    }
    if (event.type === "message_end" && event.message?.role === "assistant") found = event.message;
  }
  return found;
}

/** What one request reported: pi's usage fields, the reasoning count when the provider gives one, and the thinking text size. */
export interface StepUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly thinkingChars: number;
  readonly stopReason: string;
}

export function usageOf(message: ProbeMessage | undefined): StepUsage {
  const raw = message?.usage ?? {};
  const count = (key: string): number => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
  const thinkingChars = (message?.content ?? []).reduce<number>((total, block) => total + thinkingLength(block), 0);
  return {
    input: count("input"),
    output: count("output"),
    cacheRead: count("cacheRead"),
    cacheWrite: count("cacheWrite"),
    ...(typeof raw.reasoning === "number" ? { reasoning: raw.reasoning } : {}),
    thinkingChars,
    stopReason: message?.stopReason ?? "none",
  };
}

function thinkingLength(block: unknown): number {
  const candidate = block as { type?: unknown; thinking?: unknown } | null;
  return candidate?.type === "thinking" && typeof candidate.thinking === "string" ? candidate.thinking.length : 0;
}

/**
 * The usage object of a raw provider stream event, where the provider reports
 * one: Anthropic's `message_start` (message.usage) and `message_delta` (usage),
 * OpenAI's `response.completed` (response.usage). Undefined for every other event.
 */
export function rawUsageOf(event: unknown): Loose | undefined {
  if (!event || typeof event !== "object") return undefined;
  const record = event as { type?: unknown; usage?: unknown; message?: { usage?: unknown }; response?: { usage?: unknown } };
  const usage = record.type === "message_start" ? record.message?.usage
    : record.type === "message_delta" ? record.usage
      : ["response.completed", "response.done", "response.incomplete"].includes(String(record.type)) ? record.response?.usage
        : undefined;
  return usage && typeof usage === "object" ? (usage as Loose) : undefined;
}

/** Why a run must stop, or undefined to carry on. Any error reply or a non-zero pi exit stops the run. */
export function runError(message: ProbeMessage | undefined, exitCode: number | null, stderr: string): string | undefined {
  if (exitCode !== 0) return `pi ended with exit ${exitCode}: ${tail(stderr)}`;
  if (!message) return `no assistant message in pi's output: ${tail(stderr)}`;
  if (message.stopReason === "error") return message.errorMessage ?? "the reply was an error with no message";
  return undefined;
}

function tail(text: string): string {
  return text.trim().slice(-400);
}

export type KeptVerdict = "yes" | "no" | "not measured";

export interface CacheVerdict {
  readonly verdict: KeptVerdict;
  readonly reason: string;
}

/** One cache-block granularity (OpenAI reports cached tokens in 128-token steps), or 10 percent, whichever is larger. */
const CACHE_TOLERANCE_TOKENS = 128;

function cacheTolerance(control: StepUsage): number {
  return Math.max(CACHE_TOLERANCE_TOKENS, 0.1 * control.cacheRead);
}

/** Whether the changed request reads about what the control reads, given that the first request wrote the prefix. */
export function cacheKept(input: { readonly control: StepUsage; readonly changed: StepUsage; readonly written: StepUsage }): CacheVerdict {
  const { control, changed, written } = input;
  if (written.cacheWrite + written.cacheRead === 0) return { verdict: "not measured", reason: "the first request wrote no cache" };
  if (control.cacheRead === 0) return { verdict: "not measured", reason: "the control read no cache, so there is nothing to compare" };
  const tolerance = cacheTolerance(control);
  const kept = changed.cacheRead >= control.cacheRead - tolerance;
  return { verdict: kept ? "yes" : "no", reason: `changed read ${changed.cacheRead} tokens, control read ${control.cacheRead} (tolerance ${tolerance})` };
}

export type SensitivityVerdict = "discriminates" | "does not discriminate" | "not measured";

/** Whether the negative control (a top-level change) breaks the cache, which shows the cache test can fail at all. */
export function cacheSensitivity(input: { readonly control: StepUsage; readonly negative: StepUsage }): { verdict: SensitivityVerdict; reason: string } {
  const { control, negative } = input;
  if (control.cacheRead === 0) return { verdict: "not measured", reason: "the control read no cache" };
  const broke = negative.cacheRead < control.cacheRead - cacheTolerance(control);
  return broke
    ? { verdict: "discriminates", reason: `the top-level change read ${negative.cacheRead} tokens against the control's ${control.cacheRead}` }
    : { verdict: "does not discriminate", reason: `the top-level change read ${negative.cacheRead} tokens, as much as the control's ${control.cacheRead}` };
}

export type ToolVerdict = "applied" | "not applied" | "inconclusive";

export interface ToolResultVerdict {
  readonly verdict: ToolVerdict;
  readonly reason: string;
}

/** The high reference must sit at least this many tokens above the control, or the change cannot be read. */
const MIN_REFERENCE_SPAN = 30;
/** The changed reply counts as applied when it lands in the upper third of the way from control to reference, not applied in the lower third. */
const APPLIED_SHARE = 2 / 3;
const NOT_APPLIED_SHARE = 1 / 3;

/** Reasoning tokens when the provider reports them, otherwise all output tokens. */
const effortTokens = (usage: StepUsage): number => usage.reasoning ?? usage.output;

/**
 * Whether a change placed after a tool_result turn reached that reply. The
 * reply's effort tokens are placed between the control (the starting effort on
 * the same request) and the reference (the changed effort on that request).
 * Single samples are noisy, so the verdict is a position, not a proof.
 */
export function toolResultChange(input: { readonly control: StepUsage; readonly changed: StepUsage; readonly reference: StepUsage }): ToolResultVerdict {
  const control = effortTokens(input.control);
  const span = effortTokens(input.reference) - control;
  if (span < MIN_REFERENCE_SPAN) {
    return { verdict: "inconclusive", reason: `the changed-effort reference is ${span} tokens above the control, too little to read the change against` };
  }
  const share = (effortTokens(input.changed) - control) / span;
  const reason = `the change's reply sits at ${share.toFixed(2)} of the way from the control (${control}) to the changed-effort reference (${control + span})`;
  if (share >= APPLIED_SHARE) return { verdict: "applied", reason };
  if (share <= NOT_APPLIED_SHARE) return { verdict: "not applied", reason };
  return { verdict: "inconclusive", reason };
}
