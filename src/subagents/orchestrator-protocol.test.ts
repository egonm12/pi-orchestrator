import assert from "node:assert/strict";
import { test } from "node:test";
import { addOrchestratorProtocol, keepOrchestratorProtocol, orchestratorProtocol, ORCHESTRATOR_PROTOCOL_SECTION } from "./orchestrator-protocol.ts";
import { markWorkerSession } from "./worker-sessions.ts";

// The protocol's two hooks, fed plain events: before_agent_start for a run a
// prompt starts, context_with_system for every request of every run.

const PROTOCOL = orchestratorProtocol(3, "medium");

test("the protocol asks for scannable Markdown delegation tasks", () => {
  assert.match(PROTOCOL, /structured Markdown with short sections such as Goal, Context, Steps, Constraints and Report; use bullets/);
});
const orchestrator = { sessionManager: { getSessionId: () => "orchestrator-session" } } as never;

type Message = { role: string; content?: unknown; sections?: Record<string, string | null>; timestamp?: number };

/** The prompt a model gets from `messages`: every system message's text, then its sections replayed in order. */
function promptOf(messages: readonly Message[]): string {
  const texts: string[] = [];
  const sections = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "system") continue;
    if (typeof message.content === "string" && message.content.length > 0) texts.push(message.content);
    for (const [name, value] of Object.entries(message.sections ?? {})) {
      if (value === null) sections.delete(name);
      else sections.set(name, value);
    }
  }
  return [...texts, ...sections.values()].join("\n\n");
}

const system = (sections: Record<string, string | null>): Message => ({ role: "system", content: "", sections, timestamp: 1 });
const user = (text: string): Message => ({ role: "user", content: text, timestamp: 2 });
const custom = (text: string): Message => ({ role: "custom", content: text, timestamp: 3 });

function keep(messages: readonly Message[], ctx = orchestrator) {
  return keepOrchestratorProtocol({ messages: messages as never }, ctx, 3, "medium")?.messages as Message[] | undefined;
}

test("a request whose prompt lost the protocol gets it back, after the transcript's last system message", () => {
  // A prompt's run added the section; a run a message started removed it at its second turn.
  const messages = [system({ preamble: "You are pi." }), user("Start a worker"), system({ [ORCHESTRATOR_PROTOCOL_SECTION]: `<x>${PROTOCOL}</x>` }),
    custom("Background call finished"), system({ [ORCHESTRATOR_PROTOCOL_SECTION]: null }), user("tool result")];
  const kept = keep(messages);
  assert.ok(kept, "the request changed");
  assert.ok(promptOf(kept).includes(PROTOCOL), promptOf(kept));
  assert.ok(promptOf(kept).startsWith("You are pi."), "the rest of the prompt stays");
  assert.equal(kept.findIndex((message, index) => index > 4 && message.role === "system"), 5, "right after the removal, so the request's prefix stays stable");
  assert.deepEqual(kept.filter((message) => message.role !== "system"), messages.filter((message) => message.role !== "system"), "the conversation is unchanged");
  assert.equal(promptOf(messages).includes(PROTOCOL), false, "the transcript's messages are not edited");
});

test("a request whose prompt never had the protocol gets it", () => {
  const kept = keep([system({ preamble: "You are pi." }), custom("A worker asks: which config?")]);
  assert.ok(kept && promptOf(kept).includes(PROTOCOL), JSON.stringify(kept));
});

test("a request that already has the current protocol is left alone", () => {
  // As pi renders a named section (system-prompt.js buildSystemPromptSections).
  const rendered = `<${ORCHESTRATOR_PROTOCOL_SECTION}>\n${PROTOCOL}\n</${ORCHESTRATOR_PROTOCOL_SECTION}>`;
  assert.equal(keep([system({ preamble: "You are pi.", [ORCHESTRATOR_PROTOCOL_SECTION]: rendered }), user("hi")]), undefined);
});

test("a request with an older protocol gets the current one", () => {
  const older = orchestratorProtocol(5, "high");
  const kept = keep([system({ preamble: "You are pi.", [ORCHESTRATOR_PROTOCOL_SECTION]: older }), user("hi")]);
  assert.ok(kept, "the request changed");
  assert.ok(promptOf(kept).includes(PROTOCOL) && !promptOf(kept).includes(older), promptOf(kept));
});

test("a worker's request and a request without any system prompt are left alone", () => {
  const worker = { sessionManager: { getSessionId: () => "worker-session" } } as never;
  markWorkerSession("worker-session");
  assert.equal(keep([system({ preamble: "You are a worker." }), user("task")], worker), undefined);
  assert.equal(keep([user("hi")]), undefined, "pi sent no prompt; the protocol alone is not one");
});

function start(forceSystemPrompt: string | undefined, ctx = orchestrator) {
  const event = { systemPromptOptions: { sections: {} as Record<string, string>, ...(forceSystemPrompt === undefined ? {} : { forceSystemPrompt }) } };
  const result = addOrchestratorProtocol(event as never, ctx, 3, "medium");
  return { section: event.systemPromptOptions.sections[ORCHESTRATOR_PROTOCOL_SECTION], result };
}

test("a prompt's run gets the protocol as a named section", () => {
  const { section, result } = start(undefined);
  assert.equal(section, PROTOCOL);
  assert.equal(result, undefined, "the structured prompt carries it");
});

test("when an extension before it forced the whole prompt, the forced prompt ends with the protocol", () => {
  const { section, result } = start("You are pi.\n\n## Project rules");
  assert.equal(section, PROTOCOL, "the transcript still records the section");
  const forced = result?.systemPrompt ?? "";
  assert.ok(forced.startsWith("You are pi.\n\n## Project rules\n\n"), forced);
  assert.ok(forced.includes(PROTOCOL), forced);
  assert.equal(start(forced).result, undefined, "a forced prompt that has it already is left alone");
});

test("a worker's prompt gets no protocol, forced or not", () => {
  const worker = { sessionManager: { getSessionId: () => "worker-session-2" } } as never;
  markWorkerSession("worker-session-2");
  assert.deepEqual(start(undefined, worker), { section: undefined, result: undefined });
  assert.deepEqual(start("You are a worker.", worker), { section: undefined, result: undefined });
});

test("the protocol text opens with its heading, so a section patch is self-delimiting", () => {
  assert.ok(PROTOCOL.startsWith("# Orchestrator protocol\n\n"), PROTOCOL);
  assert.ok(PROTOCOL.includes("After 3 exploratory calls in one user prompt"), PROTOCOL);
  assert.ok(PROTOCOL.includes("Your gate level is medium."), PROTOCOL);
  assert.ok(PROTOCOL.includes("No call is denied"), PROTOCOL);
});

test("the protocol says a subagents call runs in the background unless foreground is chosen, and not to wait on it by default", () => {
  const paragraph = PROTOCOL.split("\n\n").find((text) => text.startsWith("A `subagents` call runs in the background"));
  assert.ok(paragraph, PROTOCOL);
  for (const phrase of ["`background: false`", "short, bounded task", "`subagents_status`", "`wait: true`", "completion notice"]) {
    assert.ok(paragraph.includes(phrase), `${phrase}: ${paragraph}`);
  }
});

test("the protocol says what makes a delegation editing: the working tree in a repository, the command rule without one", () => {
  const paragraph = PROTOCOL.split("\n\n").find((text) => text.startsWith("A delegation that edited"));
  assert.ok(paragraph, PROTOCOL);
  for (const phrase of ["In a git repository", "the working tree changed", "edit or write", "a command that changed nothing is research",
    "Without a repository", "ctx_execute", "read-only search or a build or test run",
    "If a repository's working tree cannot be read when the worker ends, that same command rule decides"]) {
    assert.ok(paragraph.includes(phrase), `${phrase}: ${paragraph}`);
  }
});

test("at gate level off the protocol says nothing of verdicts, the gate or reviewers", () => {
  const off = orchestratorProtocol(3, "off");
  assert.ok(off.startsWith("# Orchestrator protocol\n\n"), off);
  assert.ok(off.includes("After 3 exploratory calls in one user prompt"), off);
  assert.ok(off.includes("Check it before you act on it"), off);
  assert.doesNotMatch(off, /verdict|\bgate\b|reviewer|retry|request_changes|effort ladder/i);
  assert.ok(orchestratorProtocol(3, "low").includes("Your gate level is low."), "every other level keeps the gate's entries");
});
