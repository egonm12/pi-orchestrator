import type { SessionModelRegistry } from "./model-stream.ts";
import type { EffortJudgeModelReply } from "./effort-judge.ts";
import { EFFORT_JUDGE_SYSTEM_PROMPT } from "./effort-rubric.ts";
import { sessionClassifierModelCall, type SessionClassifierCallOptions } from "./session-classifier-call.ts";

/** Build the effort judge's in-session call from the classifier's streaming,
 *  timeout and pi reply handling. No separate process or provider client. */
export function sessionEffortJudgeModelCall(
  registry: SessionModelRegistry,
  options: Omit<SessionClassifierCallOptions, "systemPrompt"> = {},
): (prompt: string, rung: string, signal: AbortSignal) => Promise<EffortJudgeModelReply> {
  const call = sessionClassifierModelCall(registry, {
    ...options,
    systemPrompt: EFFORT_JUDGE_SYSTEM_PROMPT,
  });
  return async (prompt, rung, signal): Promise<EffortJudgeModelReply> => {
    const reply = await call(prompt, rung, signal);
    return {
      text: reply.text,
      ...(reply.reportedUsd === undefined ? {} : { reportedUsd: reply.reportedUsd }),
    };
  };
}
