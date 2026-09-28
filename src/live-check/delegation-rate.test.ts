import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { orchestratorProtocol } from "../subagents/orchestrator-protocol.ts";
import { promptsOfSession, readRows, runExtract, summarize, type LabelRow, type PromptOutcome, type Route } from "./delegation-rate.ts";

const PROTOCOL = orchestratorProtocol(3, "medium");

/** One pi session file's text, from its entries after the header. */
function sessionFile(id: string, entries: readonly Record<string, unknown>[]): string {
  let n = 0;
  const lines = [{ type: "session", version: 3, id, timestamp: "2026-09-30T08:00:00.000Z", cwd: "/private/project" },
    ...entries.map((entry) => ({ id: `${id}-e${++n}`, parentId: null, timestamp: "2026-09-30T09:00:00.000Z", ...entry }))];
  return lines.map((line) => JSON.stringify(line)).join("\n");
}
const system = (protocol = true) => ({ type: "message", message: { role: "system", content: protocol ? `You are pi.\n${PROTOCOL}` : "You are pi.",
  sections: protocol ? { preamble: "You are pi.", orchestrator_protocol: PROTOCOL } : { preamble: "You are pi." } } });
const user = (text: string, timestamp?: string) => ({ type: "message", ...(timestamp ? { timestamp } : {}),
  message: { role: "user", content: [{ type: "text", text }] } });
let calls = 0;
const call = (name: string, args: Record<string, unknown>) => ({ type: "message", message: { role: "assistant", provider: "anthropic",
  model: "claude-opus-4-5", content: [{ type: "toolCall", id: `t${++calls}`, name, arguments: args }] } });
const result = (text: string) => ({ type: "message", message: { role: "toolResult", toolCallId: "t", toolName: "bash",
  content: [{ type: "text", text }], isError: false } });

test("a prompt's outcome counts the workers it started and the exploratory calls made before the first one", () => {
  const found = promptsOfSession(sessionFile("S1", [
    system(),
    user("Why does the reminder not fire when I run release?"),
    call("read", { path: "src/a.ts" }),
    call("bash", { command: "rg reminder src" }),
    call("bash", { command: "npm test" }),
    call("subagents", { items: [{ task: "trace the reminder" }, { task: "list the hooks" }] }),
    call("read", { path: "src/b.ts" }),
  ]));
  assert.ok(found);
  assert.equal(found.outcomes.length, 1);
  const [outcome] = found.outcomes;
  assert.ok(outcome);
  assert.equal(outcome.delegations, 2);
  assert.equal(outcome.exploratoryBeforeDelegation, 2, "a read and a search count; a test run does not");
  assert.equal(outcome.exploratory, 3);
  assert.equal(outcome.model, "anthropic/claude-opus-4-5");
  assert.equal(outcome.protocol, true);
  assert.deepEqual(found.labels.map((label) => ({ id: label.id, route: label.route, kind: label.kind, text: label.text })),
    [{ id: outcome.id, route: "", kind: "plain", text: "Why does the reminder not fire when I run release?" }]);
});

test("each prompt gets its own nudges, gate reminders and wake-ups, and a skill prompt reads as the /skill: line typed", () => {
  const skill = `<skill name="research" location="/Users/me/.agents/skills/research/SKILL.md">\nReferences are relative to /x.\n\nBody\n</skill>\n\nlist the ADRs`;
  const found = promptsOfSession(sessionFile("S2", [
    system(),
    user(skill),
    call("read", { path: "a" }),
    result("contents\n4 exploratory calls this prompt: consider handing the rest to a worker."),
    { type: "custom_message", customType: "subagents-completion", content: "done" },
    { type: "custom_message", customType: "pi-goal-event", content: "other extension" },
    call("bash", { command: "git commit -m x" }),
    result("[main 1234] x\npi-orchestrator: git commit ran while an editing delegation waits for your verdict: d1. Judge each Result."),
    user("yes, push it"),
    call("read", { path: "b" }),
  ]));
  assert.ok(found);
  const [first, second] = found.outcomes;
  assert.ok(first && second && found.labels[0]);
  assert.deepEqual([first.kind, first.nudges, first.gateReminders, first.wakeUps, first.delegations], ["skill", 1, 1, 1, 0]);
  assert.equal(first.exploratoryBeforeDelegation, 1, "without a worker, every exploratory call came before delegating");
  assert.deepEqual([second.kind, second.nudges, second.gateReminders, second.wakeUps, second.exploratory], ["plain", 0, 0, 0, 1]);
  assert.equal(found.labels[0].text, "/skill:research list the ADRs");
  assert.equal(first.session, second.session);
});

test("a session that never had the protocol is not sampled, and outcomes carry no text, path or session id", () => {
  assert.equal(promptsOfSession(sessionFile("S3", [system(false), user("hello"), call("read", { path: "a" })])), undefined);
  const found = promptsOfSession(`${sessionFile("S4-secret-id", [system(false), user("before the protocol"), system(), user("Review the secret plan")])}\nnot json`);
  assert.ok(found);
  assert.deepEqual(found.outcomes.map((outcome) => outcome.protocol), [false, true]);
  assert.equal(found.badLines, 1);
  const outcomes = JSON.stringify(found.outcomes);
  for (const secret of ["secret", "/private/project", "S4", "Review"]) assert.ok(!outcomes.includes(secret), `outcomes hold ${secret}`);
  assert.deepEqual(found.labels.map((label) => label.id), found.outcomes.map((outcome) => outcome.id));
});

/** A labelled prompt and its outcome. */
interface Row { readonly route: Route; readonly delegated?: boolean; readonly nudges?: number; readonly kind?: "plain" | "skill"; readonly explored?: number; readonly session?: string }
function sample(rows: readonly Row[]): { labels: LabelRow[]; outcomes: PromptOutcome[] } {
  const labels = rows.map((row, i): LabelRow => ({ id: `p${i}`, route: row.route, kind: row.kind ?? "plain", text: `prompt ${i}` }));
  const outcomes = rows.map((row, i): PromptOutcome => ({ id: `p${i}`, session: row.session ?? "s1", at: `2026-09-30T09:${String(i % 60).padStart(2, "0")}:00.000Z`,
    kind: row.kind ?? "plain", model: "anthropic/claude-opus-4-5", protocol: true, delegations: row.delegated ? 1 : 0,
    exploratory: row.explored ?? 0, exploratoryBeforeDelegation: row.explored ?? 0, nudges: row.nudges ?? 0, gateReminders: 0, wakeUps: 0 }));
  return { labels, outcomes };
}
const summarized = (rows: readonly Row[]) => { const { labels, outcomes } = sample(rows); return summarize(labels, outcomes); };
const needed = (delegated: number, of: number): Row[] => Array.from({ length: of }, (_, i) => ({ route: "delegate", delegated: i < delegated }));

test("the decision compares plain delegate prompts with the baseline's 6 of 29 by a one-sided Fisher exact test", () => {
  // Expected p values from scipy.stats.fisher_exact([[x, n - x], [6, 23]], alternative="greater").
  const improved = summarized(needed(14, 29));
  assert.equal(improved.decision, "improved");
  assert.ok(improved.lines.includes("headline (plain prompts, as the baseline): delegated 14 of 29 needed (48%); baseline 6 of 29 (21%)"), improved.lines.join("\n"));
  assert.ok(improved.lines.includes("one-sided Fisher exact test against the baseline: p = 0.026"), improved.lines.join("\n"));
  assert.equal(improved.lines.at(-1), "DECISION: IMPROVED. ADR 0013 stands: the rate is above the baseline at p < 0.05.");

  assert.equal(summarized(needed(13, 29)).decision, "improved", "p = 0.046");
  const near = summarized(needed(12, 29));
  assert.equal(near.decision, "near-baseline", "p = 0.077");
  assert.ok(near.lines.includes("one-sided Fisher exact test against the baseline: p = 0.077"), near.lines.join("\n"));
  assert.equal(near.lines.at(-1), "DECISION: NEAR BASELINE. Revisit ADR 0013 with this evidence: the rate is not above the baseline at p < 0.05.");

  const small = summarized(needed(28, 28));
  assert.equal(small.decision, "insufficient");
  assert.equal(small.lines.at(-1), "DECISION: INSUFFICIENT SAMPLE. 28 plain prompts labelled delegate, at least 29 needed: keep sampling.");
});

test("skill prompts, skipped rows and quick prompts stay out of the headline and are reported apart", () => {
  const { labels, outcomes } = sample([
    ...needed(13, 29),
    { route: "delegate", kind: "skill", delegated: true }, { route: "delegate", kind: "skill", delegated: false },
    { route: "skip", delegated: true },
    { route: "self", delegated: true }, { route: "self", nudges: 2 }, { route: "self" },
    { route: "delegate", delegated: false, explored: 3, session: "s2" },
  ]);
  const { lines, decision } = summarize(labels, outcomes);
  assert.equal(decision, "near-baseline", "13 of 30: scipy p = 0.056");
  for (const line of [
    "sample: 35 labelled prompts in 2 sessions (1 skipped), 2026-09-30 to 2026-09-30",
    "headline (plain prompts, as the baseline): delegated 13 of 30 needed (43%); baseline 6 of 29 (21%)",
    "skill prompts: delegated 1 of 2 needed",
    "all prompts: delegated 14 of 32 needed",
    "quick prompts delegated anyway: 1 of 3",
    "needed prompts with more than 2 exploratory calls before a worker (or none): 1 of 30; baseline 15 of 29",
    "not delegated although needed (plain): 17 prompts",
    "models: anthropic/claude-opus-4-5 35",
    "protocol recorded before the prompt: 35 of 35",
    "exploration nudges seen: 2 in 1 prompt; gate reminders seen: 0 in 0 prompts; wake-ups: 0",
  ]) assert.ok(lines.includes(line), `missing ${line}\n${lines.join("\n")}`);
  assert.ok(!lines.join("\n").includes("prompt 1"), "no prompt text in the summary");
});

test("the summary refuses unlabelled rows and outcomes it has no label for, and reports a second labeller's agreement", () => {
  const { labels, outcomes } = sample(needed(13, 29));
  const [head] = labels;
  assert.ok(head);
  assert.throws(() => summarize([{ ...head, route: "" }, ...labels.slice(1)], outcomes), /1 prompt is not labelled yet/);
  assert.throws(() => summarize(labels.slice(1), outcomes), /no label for 1 outcome/);
  const second = labels.map((label, i) => (i < 3 ? { ...label, route: "self" as const } : label));
  const { lines } = summarize(labels, outcomes, second);
  assert.ok(lines.includes("second labeller agreement: 26 of 29 (90%); baseline labellers 88%"), lines.join("\n"));
});

test("extract reads the orchestrator's session files in the window, skips workers' sessions, and writes labels and outcomes apart", () => {
  const root = mkdtempSync(join(tmpdir(), "delegation-rate-"));
  const sessions = join(root, "sessions");
  const project = join(sessions, "--private-project--");
  mkdirSync(join(project, "subagents", "S5"), { recursive: true });
  writeFileSync(join(project, "a.jsonl"), sessionFile("S5", [system(), user("too early", "2026-09-28T09:00:00.000Z"),
    user("Why does it fail?", "2026-09-30T09:00:00.000Z"), call("subagents", { items: [{ task: "trace" }] }), user("too late", "2026-10-09T09:00:00.000Z")]));
  writeFileSync(join(project, "subagents", "S5", "worker.jsonl"), sessionFile("W1", [system(), user("worker task", "2026-09-30T09:00:00.000Z")]));
  writeFileSync(join(project, "plain.jsonl"), sessionFile("S6", [system(false), user("no orchestrator", "2026-09-30T09:00:00.000Z")]));
  const out = join(root, "out");

  const summary = runExtract({ sessionsDir: sessions, outDir: out, since: new Date("2026-09-29T00:00:00Z"), until: new Date("2026-10-08T00:00:00Z"), repoRoot: join(root, "repo") });
  assert.deepEqual([summary.sessions, summary.orchestratorSessions, summary.prompts], [2, 1, 1]);
  const labels = readRows<LabelRow>(join(out, "labels.jsonl"));
  const outcomes = readRows<PromptOutcome>(join(out, "outcomes.jsonl"));
  assert.deepEqual(labels.map((label) => [label.route, label.text]), [["", "Why does it fail?"]]);
  assert.deepEqual(outcomes.map((outcome) => [outcome.id, outcome.delegations]), [[labels[0]?.id, 1]]);
  assert.ok(!readFileSync(join(out, "outcomes.jsonl"), "utf8").includes("Why"));

  const carried = join(root, "wider");
  runExtract({ sessionsDir: sessions, outDir: carried, since: new Date("2026-09-29T00:00:00Z"), repoRoot: join(root, "repo"),
    labelsFrom: labels.map((label) => ({ ...label, route: "delegate" as const })) });
  assert.deepEqual(readRows<LabelRow>(join(carried, "labels.jsonl")).map((label) => [label.route, label.text]).sort(),
    [["", "too late"], ["delegate", "Why does it fail?"]], "a wider window keeps earlier labels by id");
  assert.throws(() => runExtract({ sessionsDir: sessions, outDir: out, repoRoot: join(root, "repo") }), /already holds labels\.jsonl/);
  assert.throws(() => runExtract({ sessionsDir: sessions, outDir: join(root, "repo", "tmp"), repoRoot: join(root, "repo") }), /inside the repository/);
  assert.equal(existsSync(join(root, "repo")), false);
});
