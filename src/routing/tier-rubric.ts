// Ticket 23: the classifier's rubric, versioned (story 20, ADR 0003).
//
// Change the text below only together with RUBRIC_VERSION, so every decision
// record names the rubric that produced it. The prompt is built from exactly
// three inputs: the task text, the agent role and the file paths named for the
// task. The conversation is not an input (story 14): it is not a field of
// `ClassifierInput`, and `classifierPrompt` reads the three fields by name.

import { TIER_ANSWER_SCHEMA } from "./tier-answer-schema.ts";

export const RUBRIC_VERSION = "tier-rubric-2";

export interface ClassifierInput {
  readonly task: string;
  readonly role: string;
  /** File paths named for the task. */
  readonly paths: readonly string[];
}

export const TIER_RUBRIC = `You classify one delegated coding task into a tier: the level of care it demands.
Judge the riskiest part of the task. Size never lowers a tier: a one-line change can be critical.
Ask the four questions below from the top down. The tier is the first one answered yes, so when two tiers both fit, the higher wins.

1. critical: does the task change a security boundary, or destroy data that cannot be recovered?
   A security boundary decides who may do what: authentication, authorization, sessions, credentials and secrets, cryptography, payments and permission checks. Destroying data means deleting, dropping, truncating or rewriting history. Any such change is critical however small, a one-line change included, and a change that only loosens or relaxes a check is still a change to the boundary.
   Example: grant the support role write access to billing settings.
2. elevated: without touching a security boundary, would a mistake be costly or hard to see?
   That means a breaking change to a public API or wire format, releases and deploys, data migrations, concurrency, performance-critical paths, changing how untrusted input is validated or sanitised, logging of sensitive data, or requirements vague enough to need judgement. An additive change that existing callers need not use, such as a new optional parameter with a default, is not breaking.
   Example: rename a field in a published JSON response that other services read.
3. standard: does the task change behaviour in ordinary code, with clear requirements, where tests or review catch a mistake and a revert undoes it?
   Features, bug fixes, tests and small refactors, in one file or across a few.
   Example: fix the off-by-one in the date range filter and add a regression test.
4. mechanical: does the task leave behaviour unchanged?
   Formatting, whitespace, indentation, typos, comment wording, import order, renames a tool can check.
   Example: sort the imports in src/util.ts alphabetically.

Also report:
- risk: "none", "some" or "high", with the reasons that made it so (an empty list for "none").
- ambiguity: "clear", "partial" or "vague" for how well the task states what done looks like.
- complexity: "low", "medium" or "high" for how much must be understood and changed.
- kindOfWork: one of "implement", "fix-after-review", "review", "security-review", "mechanical-edit", "research".
- why: one or two sentences explaining the tier.`;

function namedPaths(paths: readonly string[]): string {
  return paths.length === 0 ? "(none)" : paths.map((path) => `- ${path}`).join("\n");
}

/** The whole prompt the classifier model receives. */
export function classifierPrompt(input: ClassifierInput): string {
  return [
    TIER_RUBRIC,
    "",
    "Answer with one JSON object only, no prose and no code fence, matching this JSON schema:",
    JSON.stringify(TIER_ANSWER_SCHEMA),
    "",
    "Task text:",
    "<<<",
    input.task,
    ">>>",
    `Agent role: ${input.role}`,
    "Named file paths:",
    namedPaths(input.paths),
  ].join("\n");
}
