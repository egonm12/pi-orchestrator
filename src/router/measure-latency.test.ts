import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./measure-latency.ts", import.meta.url));

test("latency CLI rejects invalid or missing rung before requiring call authorization", () => {
  for (const args of [["--rung", "anthropic/claude-haiku-4-5:bogus"], ["--rung"], ["--rung", "other/model:off"]]) {
    // Never authorize a real call. A regression can only print usage.
    const run = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.error, undefined);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /--rung must be anthropic\/claude-haiku-4-5 with an effort suffix/);
    assert.equal(run.stdout, "");
  }
});

test("latency CLI accepts supported Haiku efforts but still requires explicit call authorization", () => {
  for (const effort of ["off", "minimal", "low", "medium", "high"]) {
    const run = spawnSync(process.execPath, [script, "--rung", `anthropic/claude-haiku-4-5:${effort}`], { encoding: "utf8", timeout: 10_000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /^usage: .*--live .*--rung /);
    assert.equal(run.stdout, "");
  }
});

// Pure evidence validation never opens an agent directory or starts pi.
const rung = "anthropic/claude-haiku-4-5:off";
function evidence() {
  const args = { agent: "router-latency-absent", task: "Add a retry option to the fetch helper in src/fetch.ts and cover it with a unit test.", context: "fresh", async: false };
  return {
    calls: 1, rung, mode: "shadow" as const,
    events: [
      { type: "tool_execution_start", toolName: "subagent", toolCallId: "call-1", args },
      { type: "tool_execution_end", toolName: "subagent", toolCallId: "call-1", isError: true, result: { content: [{ text: "Unknown agent: router-latency-absent" }] } },
    ],
    records: [{ attemptId: "call-1", recordType: "decision", classification: { cause: `model:${rung}` } }],
    lines: [`pi-orchestrator router: hook 10.0 ms for 1 slot(s), mode shadow`, `pi-orchestrator router: classifier ${rung} first token 1.0 ms, total 9.0 ms, tokens 20, reported cost $0.00100`],
    launches: [{ kind: "parent" }, { kind: "list-models" }],
  };
}

test("latency validation accepts complete requested-rung evidence", async () => {
  const { validateLatencyRun } = await import("./measure-latency.ts");
  assert.doesNotThrow(() => validateLatencyRun(evidence()));
});

const invalidEvidence: [string, (e: ReturnType<typeof evidence>) => void][] = [
  ["failed probe replacing success", (e) => { e.lines[1] = `pi-orchestrator router: classifier ${rung} failed after 1.0 ms: timeout`; }],
  ["missing parent launch", (e) => { e.launches = [{ kind: "list-models" }]; }],
  ["extra parent launch", (e) => { e.launches.push({ kind: "parent" }); }],
  ["missing result ID", (e) => { e.events[1]!.toolCallId = ""; e.records[0]!.attemptId = ""; e.events[0]!.toolCallId = ""; }],
  ["arguments for another call", (e) => { e.events[0]!.toolCallId = "other"; }],
  ["duplicate matching record with correct total", (e) => {
    e.calls = 2; e.events.push({ ...e.events[1]!, toolCallId: "call-2" });
    e.records.push(e.records[0]!); e.lines.push(...e.lines);
  }],
  ["arbitrary error suffix", (e) => { e.events[1]!.result!.content[0]!.text += " plus permission denied"; }],
  ["malformed successful probe", (e) => { e.lines[1] = e.lines[1]!.replace("total 9.0 ms", "total invalid"); }],
  ["extra unrelated record", (e) => { e.records.push({ ...e.records[0]!, attemptId: "other" }); }],
  ["duplicate results with distinct records", (e) => {
    e.calls = 2; e.events.push(e.events[1]!);
    e.records.push({ ...e.records[0]!, attemptId: "call-2" }); e.lines.push(...e.lines);
  }],
  ["duplicate records hiding a missing correspondence", (e) => {
    e.calls = 2; e.events.push({ ...e.events[1]!, toolCallId: "call-2" });
    e.records.push(e.records[0]!); e.lines.push(...e.lines);
  }],
  ["keyword fallback", (e) => { e.records[0]!.classification.cause = "keywords"; }],
  ["wrong decision rung", (e) => { e.records[0]!.classification.cause = "model:anthropic/claude-haiku-4-5:low"; }],
  ["wrong probe rung", (e) => { e.lines[1] = e.lines[1]!.replace(":off", ":low"); }],
  ["failed probe alongside success", (e) => { e.lines.push(`pi-orchestrator router: classifier ${rung} failed after 1.0 ms: timeout`); }],
  ["missing probe", (e) => { e.lines.pop(); }],
  ["unrelated error", (e) => { e.events[1]!.result!.content[0]!.text = "permission denied"; }],
  ["different unknown agent", (e) => { e.events[1]!.result!.content[0]!.text = "Unknown agent: other"; }],
  ["successful tool result", (e) => { e.events[1]!.isError = false; }],
  ["duplicate record", (e) => { e.records.push(e.records[0]!); }],
  ["missing record", (e) => { e.records = []; }],
  ["unmatched record", (e) => { e.records[0]!.attemptId = "other"; }],
  ["nondecision record", (e) => { e.records[0]!.recordType = "explicit"; }],
  ["classifier launch", (e) => { e.launches.push({ kind: "classifier" }); }],
  ["other launch", (e) => { e.launches.push({ kind: "other" }); }],
  ["wrong arguments", (e) => { e.events[0]!.args!.agent = "other"; }],
  ["extra arguments", (e) => { Object.assign(e.events[0]!.args!, { model: rung }); }],
  ["missing result", (e) => { e.events.pop(); }],
  ["duplicate result ID", (e) => { e.calls = 2; e.events.push(e.events[1]!); e.records.push(e.records[0]!); e.lines.push(...e.lines); }],
  ["missing hook", (e) => { e.lines.shift(); }],
  ["wrong hook mode", (e) => { e.lines[0] = e.lines[0]!.replace("shadow", "live"); }],
];
for (const [label, corrupt] of invalidEvidence) {
  test(`latency validation rejects ${label}`, async () => {
    const { validateLatencyRun } = await import("./measure-latency.ts");
    const input = evidence();
    corrupt(input);
    assert.throws(() => validateLatencyRun(input));
  });
}

test("latency validation accepts installed unknown-agent discovery diagnostics", async () => {
  const { validateLatencyRun } = await import("./measure-latency.ts");
  const input = evidence();
  input.events[1]!.result!.content[0]!.text += "\nEffective cwd: /tmp/latency\nConsulted agent-definition directories:\n- (none)\nDiscovered agents:\n- (none)";
  assert.doesNotThrow(() => validateLatencyRun(input));
});
