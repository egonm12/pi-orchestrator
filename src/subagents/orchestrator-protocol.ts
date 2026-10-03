import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ContextEventResult, ContextWithSystemEvent, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { hasQualityGate, tiersByGateAction, type GateAction, type GateLevel } from "./quality-gate.ts";

// The orchestrator protocol: how the orchestrator's own session delegates and
// judges (ADR 0010, ADR 0011, ADR 0013). It must be in the system prompt of
// every request of every orchestrator run. Two hooks put it there:
// - before_agent_start, when a prompt (typed, a skill, a template) starts a
//   run: the protocol becomes a named section, which pi records in the
//   transcript and keeps through the run's turns and after a compaction. When
//   an extension loaded earlier forced the whole prompt (returned systemPrompt,
//   as pi-claude-rules does), the provider gets that forced text instead of the
//   sections, so the protocol is appended to it.
// - context_with_system, before each request: a run a message starts
//   (sendMessage with triggerTurn: completion notices and worker questions)
//   skips before_agent_start, and pi 0.87.1 builds
//   its turns from the base prompt, so its second turn removes the section,
//   and a later such run starts without it. When the request's replayed prompt
//   lacks the current protocol, the request, not the transcript, gets a section
//   patch after its last system message. The commit gate starts no run: its
//   reminder is appended to the bash tool result, and its turn-end notice is
//   sent with triggerTurn: false (commit-gate.ts), so each lands in a request
//   this hook already covers.
// pi exposes no supported way to add a section to the base prompt (tool
// guidelines render only without a custom SYSTEM.md, as bullets, and reach
// workers that have the subagents tool), and sending wake-ups as user messages
// would put words in the owner's mouth; see bean pi-orchestrator-6yxt.
// Only the orchestrator's session gets it: a worker, a forked worker (whose
// copied conversation may carry the orchestrator's section; pi removes it from
// the fork's prompt) and a pi-subagents child do not.

/** The protocol's section name in the system prompt. */
export const ORCHESTRATOR_PROTOCOL_SECTION = "orchestrator_protocol";

/** What each gate action asks for, as the gate level's entry names it. */
const ACTION_TEXT: Readonly<Record<GateAction, string>> = { none: "no verdict", "spot-check": "your spot check", reviewer: "an independent reviewer" };

/** "mechanical and standard need your spot check; elevated and critical need an independent reviewer", at `level`. */
function gateTable(level: GateLevel): string {
  const byAction = tiersByGateAction(level);
  return (["none", "spot-check", "reviewer"] as const).flatMap((action) => {
    const tiers = byAction[action];
    if (tiers.length === 0) return [];
    const named = tiers.length === 1 ? tiers[0]! : `${tiers.slice(0, -1).join(", ")} and ${tiers.at(-1)}`;
    return [`${named} ${tiers.length === 1 ? "needs" : "need"} ${ACTION_TEXT[action]}`];
  }).join("; ");
}

/** The gate level's entry: the level in force and what it asks of each tier (ADR 0011). */
function gateLevelParagraph(level: GateLevel): string {
  return `Your gate level is ${level}. It sets what an editing delegation needs by its tier: ${gateTable(level)}. ` +
    "A delegation without a tier (a forked worker, or one whose agent definition names a model) counts as elevated. " +
    (tiersByGateAction(level).none.length > 0 ? "An ungated delegation needs no verdict; you may still record one. " : "") +
    (level === "max" ? "Every reviewer reruns the Result's Verified by commands. " : "") +
    "The owner sets the level. You may raise it for one delegation, never lower it: pass `gateLevel` and `gateLevelReason` to " +
    "`subagents_verdict` when the work is riskier than its tier says or the user asks for a closer look, and the verdict is held to the raised level.";
}

// One entry per rule, in the order the orchestrator reads them. The exploration
// nudge's entry names the owner's threshold (exploration-nudge.ts), and the
// gate level's entry the level in force (gate-level.ts). At gate level off
// there is no quality gate, and the protocol says nothing of verdicts,
// reviewers or retries (qualityGateParagraphs).
const paragraphs = (explorationNudge: number, gateLevel: GateLevel): readonly string[] => [
  "You are the orchestrator. You own clarification, task decomposition, delegation, synthesis and acceptance. " +
    "Your context window is the scarce resource: keep conclusions in it, not file dumps.",
  "Delegate exploration and substantial work to workers with the `subagents` tool. Delegate when you expect more than two " +
    "exploratory commands (reads, searches, listings, diffs) before you can answer, when the question is open, such as " +
    "\"any risks?\" or \"why does this fail?\", or when the output will be large and you only need the conclusion. " +
    "Decide before your first command, not after the fifth. Give each worker one bounded task. Write each `subagents` task as " +
    "structured Markdown with short sections such as Goal, Context, Steps, Constraints and Report; use bullets instead of one dense paragraph. " +
    "Check on a background worker with `subagents_status`, and steer it or answer the question in its Report with `subagents_message`.",
  "A `subagents` call runs in the background unless you set `background: false`: it returns its call id and delegation ids at once, " +
    "and you stay free to answer the user, do unrelated work, check on or steer its workers. Its results come in one completion notice. " +
    "Keep the default for exploration, coding, reviews and anything whose length you cannot tell. Set `background: false` only for a " +
    "short, bounded task whose result your very next step needs; a foreground call holds your turn, and the user's messages wait, " +
    "until every worker has finished. Do not follow a background call with `subagents_status` and `wait: true` by habit, which " +
    "holds your turn just the same: wait only when you cannot go on without the result, and otherwise let the completion notice bring it.",
  "Keep small known actions yourself: a single lookup, a small edit you can already see, a build or test run, a commit, " +
    "or a decision only you can make.",
  `After ${explorationNudge} exploratory call${explorationNudge === 1 ? "" : "s"} in one user prompt, the result of each further one ends ` +
    "with an exploration nudge that counts your exploratory calls so far. Exploratory calls are reads, searches, listings, diffs, web " +
    "lookups, ctx and MCP calls, and any bash command that is not a build, test run or commit. Checking a worker's Result counts too. " +
    "Edits, builds, test runs, commits and the subagents tools never count. No call is denied: a quick lookup, or a check of what a " +
    "worker changed, is yours to make. When the nudge appears, hand the rest of the research to a worker with `subagents`.",
  `A worker's Result is evidence, not ${hasQualityGate(gateLevel) ? "a verdict" : "proof"}. Check it before you act on it: does every claim carry file:line evidence, ` +
    "does it say what it could not verify, does anything contradict what you already know? Do not build on a claim without " +
    "evidence: check that claim yourself, or resume the worker with the `subagents` tool and ask for it.",
  ...(hasQualityGate(gateLevel) ? qualityGateParagraphs(gateLevel) : []),
];

/** The quality gate's entries at `gateLevel`, which is not off: verdicts, the gate level, reviewers and retries. */
const qualityGateParagraphs = (gateLevel: GateLevel): readonly string[] => [
  "A delegation that edited needs your verdict unless your gate level leaves it ungated; its Result says which. In a git repository " +
    "it edited when the working tree changed while its worker, or a worker it started, ran, or when one of them ran edit or write; " +
    "a command that changed nothing is research. Without a repository it edited when one of them ran edit, write, ctx_execute or a " +
    "bash command that is not a read-only search or a build or test run. " +
    "If a repository's working tree cannot be read when the worker ends, that same command rule decides. " +
    "Judge the change itself, not the worker's " +
    "account of it: spot-check the diff and the claims that matter, or read a reviewer's Result. Then record the verdict with " +
    "`subagents_verdict`: the delegation id, accept or request_changes, and a reason naming what you checked. A later verdict on " +
    "the same delegation replaces the earlier one, and a resume that edits again needs a new one. A research Result gets no verdict. " +
    "Your git commit or git push always goes through, and its result names each editing delegation still waiting for a verdict. " +
    "Record those verdicts, or tell the user which are missing: the routing report counts every missing verdict.",
  gateLevelParagraph(gateLevel),
  "Where your gate level calls for an independent reviewer, an editing delegation needs one before its verdict; its Result says so. " +
    "Start one with a `subagents` item whose `review` is the " +
    "delegation id and whose `task` says what to check. The reviewer is routed at the delegation's tier or higher and never on its rung, " +
    `gets its task, Result and changed files, ${gateLevel === "max" ? "reruns the Result's Verified by commands" : "reruns nothing unless the task tells it to"}, ` +
    "and answers accept or request changes with reasons. " +
    "Judge the reviewer's Result like any other, then record the verdict with `subagents_verdict`, naming the reviewer delegation as " +
    "`reviewer`; without it the verdict is refused. A review started before the delegation's latest edit does not count. Where your own " +
    "spot check is enough, a reviewer is welcome too. " +
    (gateLevel === "max" ? "" : "When you raise the gate level to max for a delegation, tell its reviewer in the task to rerun the Verified by commands. ") +
    "In shadow mode or with routing off no other rung can be " +
    "chosen, so the reviewer runs on the delegation's own rung with a fresh context, and the verdict records a same-rung review. If a review " +
    "fails because live routing left no rung but the delegation's own, tell the user.",
  "When you record request_changes, the reply names the effort ladder's next rung for a retry, or says why there is none. To retry, start " +
    "a `subagents` item whose `retry` is the delegation id and whose `task` is your feedback: each shortfall with its file:line and what the " +
    "task asked for. The retry is a new delegation on that rung; it gets the original task, your feedback and the failed attempt's saved " +
    "session, follows the same agent definition, and needs its own verdict. `retry` takes no `agent`, `fork`, `resume` or `review`, and only " +
    "a delegation whose latest verdict is request_changes can be retried. A task climbs the ladder at most twice, a retry of a retry included. " +
    "When a retry is refused because the ladder is exhausted or the task has climbed twice, take the task back to the user: say what fell short, " +
    "and do not work around the limit by starting a new worker.",
];

/** The protocol text, as the orchestrator's system prompt carries it, for an
 *  exploration nudge after `explorationNudge` exploratory calls per user prompt, at the gate level `gateLevel`,
 *  ending with the usage line (usage-line.ts) when there is one. */
export function orchestratorProtocol(explorationNudge: number, gateLevel: GateLevel, usage?: string): string {
  return `# Orchestrator protocol\n\n${[...paragraphs(explorationNudge, gateLevel), ...(usage === undefined ? [] : [usage])].join("\n\n")}`;
}

/** The protocol as a section of a system message, delimited as pi renders a named section. */
function protocolSection(protocol: string): string {
  return `<${ORCHESTRATOR_PROTOCOL_SECTION}>\n${protocol}\n</${ORCHESTRATOR_PROTOCOL_SECTION}>`;
}

/** A `before_agent_start` handler: adds the protocol to this prompt's system
 *  prompt in the orchestrator's own session, and leaves any other session's
 *  alone. Returns the forced prompt with the protocol appended when an earlier
 *  handler forced one without it. */
export function addOrchestratorProtocol(event: Pick<BeforeAgentStartEvent, "systemPromptOptions">,
  ctx: Pick<ExtensionContext, "sessionManager">, explorationNudge: number, gateLevel: GateLevel, usage?: string): BeforeAgentStartEventResult | undefined {
  if (!isOrchestratorSession(ctx)) return undefined;
  const protocol = orchestratorProtocol(explorationNudge, gateLevel, usage);
  event.systemPromptOptions.sections[ORCHESTRATOR_PROTOCOL_SECTION] = protocol;
  const forced = event.systemPromptOptions.forceSystemPrompt;
  if (forced === undefined || forced.includes(protocol)) return undefined;
  return { systemPrompt: `${forced}\n\n${protocolSection(protocol)}` };
}

/** A transcript message as far as the protocol reads it. */
interface PromptMessage {
  readonly role: string;
  readonly sections?: Readonly<Record<string, string | null>>;
  readonly timestamp?: number;
}

/** A `context_with_system` handler: in the orchestrator's own session, gives a
 *  request whose replayed system prompt lacks the current protocol a section
 *  patch right after its last system message, so the prefix before it stays
 *  stable across the run's requests. Leaves a request without any system
 *  message alone: pi sent it no prompt, and the protocol alone is not one. */
export function keepOrchestratorProtocol(event: Pick<ContextWithSystemEvent, "messages">,
  ctx: Pick<ExtensionContext, "sessionManager">, explorationNudge: number, gateLevel: GateLevel, usage?: string): ContextEventResult | undefined {
  if (!isOrchestratorSession(ctx)) return undefined;
  const messages = event.messages as readonly PromptMessage[];
  let lastSystem = -1;
  let current: string | null | undefined;
  messages.forEach((message, index) => {
    if (message.role !== "system") return;
    lastSystem = index;
    const section = message.sections?.[ORCHESTRATOR_PROTOCOL_SECTION];
    if (section !== undefined) current = section;
  });
  const protocol = orchestratorProtocol(explorationNudge, gateLevel, usage);
  // Exactly the current section: the protocol without a usage line is a prefix of one with it, so a
  // containment check would keep a line whose limit has lifted. A patch replaces the section by name, never adds one.
  if (lastSystem < 0 || current === protocolSection(protocol) || current === protocol) return undefined;
  // The last system message's timestamp, not the clock's: the same request prefix on every request of the run.
  const patch = { role: "system", content: "", sections: { [ORCHESTRATOR_PROTOCOL_SECTION]: protocolSection(protocol) },
    timestamp: messages[lastSystem]!.timestamp ?? 0 };
  return { messages: [...event.messages.slice(0, lastSystem + 1), patch as never, ...event.messages.slice(lastSystem + 1)] };
}
