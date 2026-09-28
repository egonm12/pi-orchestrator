import type { BeforeAgentStartEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOrchestratorSession } from "./orchestrator-session.ts";

// The orchestrator protocol: how the orchestrator's own session delegates and
// judges (ADR 0005, ADR 0010). It is a named section of the system prompt,
// added when each user prompt starts its agent loop, so pi keeps it through
// the loop's turns and puts it back after a compaction. A run a message starts
// without a user prompt (sendMessage with triggerTurn) skips before_agent_start:
// pi drops the section from its second turn on. Only the orchestrator's
// session gets it: a worker, a forked worker (whose copied conversation may
// carry the orchestrator's section; pi removes it from the fork's prompt) and
// a pi-subagents child do not.

/** The protocol's section name in the system prompt. */
export const ORCHESTRATOR_PROTOCOL_SECTION = "orchestrator_protocol";

// One entry per rule, in the order the orchestrator reads them. A later rule
// (retries, gate level) is one more entry here. The exploration
// budget's entry names the owner's threshold (exploration-budget.ts).
const paragraphs = (explorationBudget: number): readonly string[] => [
  "You are the orchestrator. You own clarification, task decomposition, delegation, synthesis and acceptance. " +
    "Your context window is the scarce resource: keep conclusions in it, not file dumps.",
  "Delegate exploration and substantial work to workers with the `subagents` tool. Delegate when you expect more than two " +
    "exploratory commands (reads, searches, listings, diffs) before you can answer, when the question is open, such as " +
    "\"any risks?\" or \"why does this fail?\", or when the output will be large and you only need the conclusion. " +
    "Decide before your first command, not after the fifth. Give each worker one bounded task. Check on a background worker " +
    "with `subagents_status`, and steer it or answer the question in its Report with `subagents_message`.",
  "Keep small known actions yourself: a single lookup, a small edit you can already see, a build or test run, a commit, " +
    "or a decision only you can make.",
  `Your exploration budget is ${explorationBudget} exploratory call${explorationBudget === 1 ? "" : "s"} per user prompt: reads, searches, listings, ` +
    "diffs, web lookups, ctx and MCP calls, and any bash command that is not a build, test run or commit. Checking a worker's " +
    "Result counts too. Edits, builds, test runs, commits and the subagents tools never count. The next exploratory call is " +
    "denied: hand the rest of the research to a worker with `subagents` instead of trying another way. Only the user can lift the budget.",
  "A worker's Result is evidence, not a verdict. Check it before you act on it: does every claim carry file:line evidence, " +
    "does it say what it could not verify, does anything contradict what you already know? Do not build on a claim without " +
    "evidence: check that claim yourself, or resume the worker with the `subagents` tool and ask for it.",
  "A delegation that edited (its worker, or a worker it started, ran edit, write, ctx_execute or a bash command that is not a " +
    "read-only search or a build or test run) needs your verdict; its Result says so. Judge the change itself, not the worker's " +
    "account of it: spot-check the diff and the claims that matter, or read a reviewer's Result. Then record the verdict with " +
    "`subagents_verdict`: the delegation id, accept or request_changes, and a reason naming what you checked. A later verdict on " +
    "the same delegation replaces the earlier one, and a resume that edits again needs a new one. A research Result gets no verdict. " +
    "Your git commit and git push are denied until every editing delegation has a verdict.",
  "An elevated or critical editing delegation, and one without a tier (a forked worker, or one whose agent definition names a model), " +
    "needs an independent reviewer before its verdict; its Result says so. Start one with a `subagents` item whose `review` is the " +
    "delegation id and whose `task` says what to check. The reviewer is routed at the delegation's tier or higher and never on its rung, " +
    "gets its task, Result and changed files, reruns nothing unless the task tells it to, and answers accept or request changes with reasons. " +
    "Judge the reviewer's Result like any other, then record the verdict with `subagents_verdict`, naming the reviewer delegation as " +
    "`reviewer`; without it the verdict is refused. A review started before the delegation's latest edit does not count. For a mechanical " +
    "or standard delegation your own spot check is enough, and a reviewer is welcome. If a review fails because the reviewer would run on " +
    "the delegation's own rung, tell the user: switching the session model or turning on live routing lets it run.",
];

/** The protocol text, as the orchestrator's system prompt carries it, for
 *  `explorationBudget` exploratory calls per user prompt. */
export function orchestratorProtocol(explorationBudget: number): string {
  return `# Orchestrator protocol\n\n${paragraphs(explorationBudget).join("\n\n")}`;
}

/** Part of a `before_agent_start` handler: adds the protocol to this prompt's
 *  system prompt in the orchestrator's own session, and leaves any other session's alone. */
export function addOrchestratorProtocol(event: Pick<BeforeAgentStartEvent, "systemPromptOptions">,
  ctx: Pick<ExtensionContext, "sessionManager">, explorationBudget: number): void {
  if (!isOrchestratorSession(ctx)) return;
  event.systemPromptOptions.sections[ORCHESTRATOR_PROTOCOL_SECTION] = orchestratorProtocol(explorationBudget);
}
