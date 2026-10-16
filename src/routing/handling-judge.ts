import { judgeConfigFromSettings, type EffortJudgeConfig, type EffortJudgeModelCall, type LoadedEffortJudgeChain } from "./effort-judge.ts";

// The handling judge (ADR 0020): one small model call per orchestrator user
// prompt that answers whether the orchestrator should handle the prompt itself
// (`self`) or hand it to workers (`delegate`).

export type HandlingMode = "self" | "delegate";

const HANDLING_JUDGE_KEY = "orchestrator.routing.handlingJudge";

/** The handling judge's model, timeout and fallbacks, read only from personal settings. It defaults like the effort judge. */
export function handlingJudgeConfigFromSettings(personal: unknown): EffortJudgeConfig {
  return judgeConfigFromSettings(personal, HANDLING_JUDGE_KEY);
}

export interface HandlingVerdict {
  readonly handling: HandlingMode;
  readonly reason: string;
  readonly judgeModel: string;
}

export interface JudgeHandlingOptions {
  readonly chain: LoadedEffortJudgeChain;
  readonly callModel: EffortJudgeModelCall;
}

export interface HandlingJudgeInput {
  readonly message: string;
}

const PROMPT = (message: string): string => [
  "Judge how the orchestrator should handle one user prompt.",
  "Answer self when the prompt is one lookup, edit or check. Answer delegate when it has several independent parts, open research, or work likely to run for minutes.",
  'Answer with one JSON object only: {"handling":"self" or "delegate","why":"a short reason"}.',
  "",
  "Prompt (first 2000 characters):",
  "<<<",
  message.slice(0, 2_000),
  ">>>",
].join("\n");

/** Calls one rung, giving up at `timeoutMs`: a judge that never answers must not hold the owner's prompt. */
async function callWithTimeout(callModel: JudgeHandlingOptions["callModel"], prompt: string, rung: string, timeoutMs: number): Promise<string | { readonly text: string }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`handling judge timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => callModel(prompt, rung, controller.signal)), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Never throws. The chain's rungs are tried in order, each within the chain's timeout; a failed judgement, a timeout or an
 *  unreadable reply on every rung is self, and its reason names the last failure. */
export async function judgeHandling(input: HandlingJudgeInput, options: JudgeHandlingOptions): Promise<HandlingVerdict> {
  let lastError = "no callable judge models in the configured chain";
  for (const entry of options.chain.entries) {
    if (entry.refusal !== undefined) {
      lastError = entry.refusal;
      continue;
    }
    try {
      const reply = await callWithTimeout(options.callModel, PROMPT(input.message), entry.rung, options.chain.timeoutMs);
      const text = typeof reply === "string" ? reply : reply.text;
      const answer = JSON.parse(text) as { handling?: unknown; why?: unknown };
      if (answer.handling !== "self" && answer.handling !== "delegate") throw new Error("handling judge reply has an unknown handling");
      if (typeof answer.why !== "string" || answer.why.trim().length === 0) throw new Error("handling judge reply needs a non-empty why");
      return { handling: answer.handling, reason: answer.why.trim(), judgeModel: entry.rung };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { handling: "self", reason: `handling judge fallback to self: ${lastError}`, judgeModel: "fallback" };
}
