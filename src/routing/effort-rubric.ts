import { THINKING_LEVELS, type ThinkingLevel } from "../models/model-info.ts";
import { HANDLING_CRITERIA } from "./handling-criteria.ts";
import type { RiskTier } from "./tiers.ts";

export const RUBRIC_VERSION = "effort-rubric-1";

export type EffortJudgeKind = "user-prompt" | "task" | "steer" | "follow-up" | "retry-feedback";

export interface EffortBand {
  readonly min: ThinkingLevel;
  readonly max: ThinkingLevel;
}

export interface EffortJudgeInput {
  readonly message: string;
  readonly kind: EffortJudgeKind;
  readonly tier: RiskTier | "orchestrator";
  readonly band: EffortBand;
  readonly currentEffort: ThinkingLevel;
  readonly turnRunning: boolean;
  /** The last user message, included only for the orchestrator. */
  readonly lastUserMessage?: string;
  /** The last assistant reply, included only for the orchestrator. */
  readonly lastAssistantReply?: string;
  /** The task prefix, included only for a worker steer or follow-up. */
  readonly taskPrefix?: string;
  /** Also judge the handling of this owner prompt, in the same reply (ADR 0020). */
  readonly withHandling?: boolean;
}

export const EFFORT_JUDGE_SYSTEM_PROMPT =
  "You choose the effort for one incoming message. You never use tools. Answer with one JSON object only.";

export const EFFORT_JUDGE_RUBRIC = `Choose the lowest effort inside the supplied band that will do this message well. Correctness comes before speed.
Questions, lookups and mechanical edits usually need low effort. Multi-file design, debugging and security work usually need high effort.
If the message says to think hard, choose at least high when the band permits it. If it pushes back because a previous answer was bad, raise effort from the current level to correct the failure.
Choose only an effort inside the inclusive band. The available order is ${THINKING_LEVELS.join(", ")}.
Answer with exactly one JSON object matching this schema, with a concise reason in why:`;

export const EFFORT_JUDGE_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    effort: { type: "string", enum: [...THINKING_LEVELS] },
    why: { type: "string" },
  },
  required: ["effort", "why"],
  additionalProperties: false,
} as const;

/** The answer schema when one reply also judges the handling (ADR 0020). */
export const EFFORT_AND_HANDLING_ANSWER_SCHEMA = {
  type: "object",
  properties: {
    effort: { type: "string", enum: [...THINKING_LEVELS] },
    why: { type: "string" },
    handling: { type: "string", enum: ["self", "delegate"] },
    handlingWhy: { type: "string" },
  },
  required: ["effort", "why", "handling", "handlingWhy"],
  additionalProperties: false,
} as const;

/** The handling question added to the rubric when one reply also judges the handling. */
const HANDLING_QUESTION = `Also judge the handling of this message. ${HANDLING_CRITERIA} Give handling and a short handlingWhy with your effort answer.`;

function firstCharacters(value: string | undefined, limit: number): string {
  return (value ?? "").slice(0, limit);
}

function tailCharacters(value: string | undefined, limit: number): string {
  return (value ?? "").slice(-limit);
}

/** Build a prompt from explicit, bounded fields. Other properties on the
 *  caller's object, including tool results, are never included. */
export function effortJudgePrompt(input: EffortJudgeInput): string {
  const lines = [
    EFFORT_JUDGE_RUBRIC,
    "",
    `Effort judge rubric version: ${RUBRIC_VERSION}`,
    "JSON schema:",
    JSON.stringify(input.withHandling ? EFFORT_AND_HANDLING_ANSWER_SCHEMA : EFFORT_JUDGE_ANSWER_SCHEMA),
    "",
    "Incoming message (first 2000 characters):",
    "<<<",
    firstCharacters(input.message, 2_000),
    ">>>",
    `Message kind: ${input.kind}`,
    `Delegation tier: ${input.tier}`,
    `Effort band, inclusive: ${input.band.min}-${input.band.max}`,
    `Current effort: ${input.currentEffort}`,
  ];

  if (input.withHandling) lines.push(HANDLING_QUESTION);

  if (input.tier === "orchestrator") {
    lines.push(
      "Last user message (first 400 characters):",
      "<<<",
      firstCharacters(input.lastUserMessage, 400),
      ">>>",
      "Tail of last assistant reply (last 2000 characters):",
      "<<<",
      tailCharacters(input.lastAssistantReply, 2_000),
      ">>>",
    );
  } else if (input.kind === "steer" || input.kind === "follow-up") {
    lines.push(
      "Task prefix (first 400 characters):",
      "<<<",
      firstCharacters(input.taskPrefix, 400),
      ">>>",
    );
  }

  return lines.join("\n");
}
