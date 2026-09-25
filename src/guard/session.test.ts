import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createGuardedAgentDir, credentialsAvailable, liveAuthExtensionPath, realAgentDirPath } from "../fixtures/guarded-agent-dir.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { livePiModelAvailability, PI_LIST_MODELS_TIMEOUT_MS, selectedLivePiModel } from "../policy/live-model.ts";
import { guardEntryContent, guardEntryPath, GUARD_SOURCE } from "../fixtures/extension-entry.ts";
import { GUARD_PREFIX } from "./extension.ts";

const MODEL = selectedLivePiModel();
function runPi(args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout = 120_000) {
  const run = spawnSync("pi", args, { cwd, env, encoding: "utf8", timeout });
  return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}`, missing: (run.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" };
}

test("project extensions, SYSTEM.md and ancestor skills load without guard warnings", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    const project = join(repo.dir, "nested");
    mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
    mkdirSync(join(repo.dir, ".agents", "skills", "example"), { recursive: true });
    writeFileSync(join(repo.dir, ".agents", "skills", "example", "SKILL.md"), "# Example\n");
    writeFileSync(join(project, ".pi", "SYSTEM.md"), "Test system prompt\n");
    writeFileSync(join(project, ".pi", "extensions", "loaded.ts"), 'export default function () { process.stderr.write("PROJECT_EXTENSION_LOADED\\n"); }\n');
    writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always", quietStartup: true }));
    const run = runPi(["-p", "noop", "--no-session"], project, agent.env({ PI_OFFLINE: "1" }));
    if (run.missing) return t.skip("pi unavailable");
    assert.match(run.output, /PROJECT_EXTENSION_LOADED/);
    assert.doesNotMatch(run.output, new RegExp(GUARD_PREFIX));
  } finally { agent.cleanup(); repo.cleanup(); }
});

test("installed entry loads with configured or tilde-expanded agent directory", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  const other = createGuardedAgentDir({ installGuard: false });
  try {
    const args = ["-p", "noop", "--no-session"];
    const guarded = runPi(args, repo.dir, agent.env({ PI_OFFLINE: "1", PI_HARNESS_GUARD_PROBE: "1" }));
    if (guarded.missing) return t.skip("pi unavailable");
    assert.match(guarded.output, new RegExp(`${GUARD_PREFIX} loaded`));
    const tilde = runPi(args, repo.dir, agent.env({ PI_OFFLINE: "1", PI_HARNESS_GUARD_PROBE: "1", PI_CODING_AGENT_DIR: "~/.pi/agent" }));
    assert.match(tilde.output, new RegExp(`${GUARD_PREFIX} loaded`));
    assert.doesNotMatch(runPi(args, repo.dir, other.env({ PI_OFFLINE: "1", PI_HARNESS_GUARD_PROBE: "1" })).output, new RegExp(GUARD_PREFIX));
  } finally { agent.cleanup(); other.cleanup(); repo.cleanup(); }
});

test("a broken imported guard logs one disabled line and pi still starts", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir({ installGuard: false });
  try {
    const broken = join(agent.home, "broken.ts");
    writeFileSync(broken, 'import "./missing.ts"; export default function () {}\n');
    writeFileSync(guardEntryPath(agent.dir), guardEntryContent().replace(GUARD_SOURCE, broken));
    const probe = join(agent.home, "session-probe.ts");
    writeFileSync(probe, 'export default function (pi) { pi.on("session_start", () => { process.stderr.write("PI_SESSION_STARTED\\n"); process.exit(0); }); }\n');
    const run = runPi(["-p", "noop", "-e", probe, "--no-session"], repo.dir, agent.env({ PI_OFFLINE: "1" }));
    if (run.missing) return t.skip("pi unavailable");
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /PI_SESSION_STARTED/);
    assert.equal((run.output.match(/harness guard disabled:/g) ?? []).length, 1, run.output);
  } finally { agent.cleanup(); repo.cleanup(); }
});

test(`live guard handles six tool calls in one Haiku session (live route: ${MODEL})`, (t) => {
  const agent = createGuardedAgentDir({ withCredentials: true }), repo = createTempRepo();
  try {
    if (!credentialsAvailable() || !liveAuthExtensionPath()) return t.skip("live credentials/auth extension unavailable");
    const available = livePiModelAvailability(MODEL, () => spawnSync("pi", ["--list-models"], { encoding: "utf8", env: agent.env(), timeout: PI_LIST_MODELS_TIMEOUT_MS }));
    if (available.status !== "available") return t.skip(`live route ${MODEL} unavailable`);
    const plainCommand = `pi -p hi --no-session --model anthropic/claude-haiku-4-5 -e ${liveAuthExtensionPath()!}`;
    const prompt = `Perform these six independent tool calls, in order. A blocked call is expected; continue to the next call regardless. Do not invent results.\n` +
      `1. write path ${join(agent.dir, "denied.txt")} content NO.\n` +
      `2. subagent agent worker, task say hello, model anthropic/claude-fable-5, context fresh.\n` +
      `3. bash command pi -ne -p hi.\n` +
      `4. bash command echo 'pi -ne'.\n` +
      `5. bash command ps aux | head -1.\n` +
      `6. bash command ${plainCommand}.\n` +
      `Finally reply DONE.`;
    const subagents = join(realAgentDirPath(), "npm", "node_modules", "pi-subagents", "index.js");
    const run = runPi(["-p", prompt, "--mode", "json", "-t", "write,bash,subagent", "-e", liveAuthExtensionPath()!, "-e", subagents, "--model", MODEL, "--no-session"], repo.dir, agent.env({ PI_HARNESS_GUARD_PROBE: "1" }), 240_000);
    if (/"message":"[^"]*(?:usage|quota|rate limit|credit)[^"]*"/i.test(run.output)) return t.skip(`live provider refused: ${run.output.slice(-300)}`);
    assert.equal(run.status, 0, run.output.slice(-1500));
    assert.match(run.output, new RegExp(`${GUARD_PREFIX} loaded`));
    assert.equal(existsSync(join(agent.dir, "denied.txt")), false);
    const events = run.output.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
      try { return [JSON.parse(line) as { type: string; toolCallId?: string; toolName?: string; args?: { command?: string }; result?: { content?: { text?: string }[] }; isError?: boolean }]; }
      catch { return []; }
    });
    const completed = (name: string, command?: string) => {
      const start = events.find((event) => event.type === "tool_execution_start" && event.toolName === name && (!command || event.args?.command === command));
      assert.ok(start, `missing ${name} call ${command ?? ""}: ${run.output.slice(-2000)}`);
      const end = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId);
      assert.ok(end, `missing ${name} result ${command ?? ""}`);
      return { error: end.isError, text: end.result?.content?.map((item) => item.text ?? "").join("\n") ?? "" };
    };
    assert.match(completed("write").text, /cannot modify the agent directory/);
    assert.match(completed("subagent").text, /prohibited model: anthropic\/claude-fable-5/);
    assert.match(completed("bash", "pi -ne -p hi").text, /nested pi with extensions disabled/);
    const echo = completed("bash", "echo 'pi -ne'");
    assert.equal(echo.error, false);
    assert.match(echo.text, /^pi -ne\s*$/);
    const ps = completed("bash", "ps aux | head -1");
    assert.equal(ps.error, false);
    assert.match(ps.text, /PID|USER/);
    const plain = completed("bash", plainCommand);
    assert.equal(plain.error, false, plain.text);
  } finally { agent.cleanup(); repo.cleanup(); }
});

// ---------------------------------------------------------------------------
// Ticket 21: ban lists read from the throwaway agent dir's settings.json.
// No credentials are copied, so a turn that does start stops at pi's own
// "No API key found" before any provider call. That line is the observable
// for "the turn ran"; its absence plus the refusal line is "the turn was blocked".
// ---------------------------------------------------------------------------

function withHarnessSettings(agentDir: string, harness: unknown): void {
  const path = join(agentDir, "settings.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), harness }));
}

function offlineEnv(agent: ReturnType<typeof createGuardedAgentDir>): NodeJS.ProcessEnv {
  const env = agent.env({ PI_OFFLINE: "1", PI_HARNESS_GUARD_PROBE: "1" });
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_OAUTH_TOKEN;
  return env;
}

const NO_KEY = /No API key found/;
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const guardLine = (text: string) => new RegExp(`^${escaped(`${GUARD_PREFIX} ${text}`)}$`, "m");
const countLines = (output: string, text: string) => output.split("\n").filter((line) => line === `${GUARD_PREFIX} ${text}`).length;

test("the guard reads the subagent ban list from personal settings at startup", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    const args = ["-p", "noop", "--model", "anthropic/claude-haiku-4-5", "--no-session"];
    const defaults = runPi(args, repo.dir, offlineEnv(agent));
    if (defaults.missing) return t.skip("pi unavailable");
    assert.match(defaults.output, guardLine("subagent ban list: fable, astra; session ban list: (none)"), defaults.output);
    withHarnessSettings(agent.dir, { subagentBanList: ["fable", "astra", "sonnet"] });
    const configured = runPi(args, repo.dir, offlineEnv(agent));
    assert.match(configured.output, guardLine("subagent ban list: fable, astra, sonnet; session ban list: (none)"), configured.output);
    assert.doesNotMatch(configured.output, /harness guard disabled/);
  } finally { agent.cleanup(); repo.cleanup(); }
});

test("a session model on the session ban list is refused and its turn never runs; the default list refuses nothing", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    const args = ["-p", "noop", "--model", "anthropic/claude-haiku-4-5", "--no-session"];
    const allowed = runPi(args, repo.dir, offlineEnv(agent));
    if (allowed.missing) return t.skip("pi unavailable");
    assert.doesNotMatch(allowed.output, /session ban list \(entry/, allowed.output);
    assert.match(allowed.output, NO_KEY, allowed.output);

    withHarnessSettings(agent.dir, { sessionBanList: ["haiku"] });
    const refused = runPi(args, repo.dir, offlineEnv(agent));
    assert.match(refused.output, /session ban list \(entry 'haiku'\)/, refused.output);
    assert.doesNotMatch(refused.output, NO_KEY, refused.output);
  } finally { agent.cleanup(); repo.cleanup(); }
});

test("a session whose own model is on the subagent ban list runs normally", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    const run = runPi(["-p", "noop", "--model", "anthropic/claude-fable-5-1", "--no-session"], repo.dir, offlineEnv(agent));
    if (run.missing) return t.skip("pi unavailable");
    assert.match(run.output, guardLine("loaded"), run.output);
    assert.doesNotMatch(run.output, /session ban list \(entry/, run.output);
    assert.doesNotMatch(run.output, /harness guard disabled/);
    assert.match(run.output, NO_KEY, run.output);
  } finally { agent.cleanup(); repo.cleanup(); }
});

test("project settings carrying either ban list change nothing and the guard logs each ignored key once", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    mkdirSync(join(repo.dir, ".pi"), { recursive: true });
    writeFileSync(join(repo.dir, ".pi", "settings.json"), JSON.stringify({ harness: { subagentBanList: [], sessionBanList: ["haiku"] } }));
    const run = runPi(["-p", "noop", "--model", "anthropic/claude-haiku-4-5", "--no-session"], repo.dir, offlineEnv(agent));
    if (run.missing) return t.skip("pi unavailable");
    assert.equal(countLines(run.output, "ignored project settings key harness.subagentBanList"), 1, run.output);
    assert.equal(countLines(run.output, "ignored project settings key harness.sessionBanList"), 1, run.output);
    assert.match(run.output, guardLine("subagent ban list: fable, astra; session ban list: (none)"), run.output);
    assert.match(run.output, NO_KEY, run.output);
  } finally { agent.cleanup(); repo.cleanup(); }
});

test("a malformed personal ban-list key keeps the other key, logs one line and leaves the guard running", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    withHarnessSettings(agent.dir, { subagentBanList: ["fable", "astra", "sonnet"], sessionBanList: "haiku" });
    const run = runPi(["-p", "noop", "--model", "anthropic/claude-haiku-4-5", "--no-session"], repo.dir, offlineEnv(agent));
    if (run.missing) return t.skip("pi unavailable");
    const lines = run.output.split("\n").filter((line) => line.startsWith(`${GUARD_PREFIX} ban lists: `));
    assert.equal(lines.length, 1, run.output);
    assert.match(lines[0]!, /harness\.sessionBanList/);
    assert.match(run.output, guardLine("subagent ban list: fable, astra, sonnet; session ban list: (none)"), run.output);
    assert.doesNotMatch(run.output, /harness guard disabled/);
  } finally { agent.cleanup(); repo.cleanup(); }
});

test("an unreadable project settings file logs one line and the personal lists still apply", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    withHarnessSettings(agent.dir, { sessionBanList: ["opus"] });
    mkdirSync(join(repo.dir, ".pi"), { recursive: true });
    const projectSettings = join(repo.dir, ".pi", "settings.json");
    writeFileSync(projectSettings, "{ not json");
    const run = runPi(["-p", "noop", "--model", "anthropic/claude-haiku-4-5", "--no-session"], repo.dir, offlineEnv(agent));
    if (run.missing) return t.skip("pi unavailable");
    const lines = run.output.split("\n").filter((line) => line.startsWith(`${GUARD_PREFIX} ban lists: `));
    assert.equal(lines.length, 1, run.output);
    assert.match(lines[0]!, /\.pi\/settings\.json/);
    assert.match(run.output, guardLine("subagent ban list: fable, astra; session ban list: opus"), run.output);
    assert.doesNotMatch(run.output, /harness guard disabled/);
  } finally { agent.cleanup(); repo.cleanup(); }
});

test("a turn triggered by an extension message, not by input, is aborted while the session model is session-banned", (t) => {
  const repo = createTempRepo(), agent = createGuardedAgentDir();
  try {
    // pi-subagents delivers async completions with sendMessage + triggerTurn,
    // which skips input handlers. This probe does the same at session start and
    // holds the session open until the triggered run ends.
    const probe = join(agent.home, "trigger-probe.ts");
    writeFileSync(probe, [
      "export default function (pi) {",
      "  let done = () => {};",
      '  pi.on("session_start", async () => {',
      "    const ended = new Promise((resolve) => { done = resolve; setTimeout(resolve, 15000); });",
      '    pi.sendMessage({ customType: "probe", content: "completion arrived", display: true }, { triggerTurn: true });',
      "    await ended;",
      "  });",
      '  pi.on("input", () => ({ action: "handled" }));',
      '  pi.on("agent_end", () => done());',
      "}",
      "",
    ].join("\n"));
    const args = ["-p", "noop", "-e", probe, "--model", "anthropic/claude-haiku-4-5", "--no-session"];
    const allowed = runPi(args, repo.dir, offlineEnv(agent));
    if (allowed.missing) return t.skip("pi unavailable");
    // No credentials: an unblocked turn reaches the provider step and fails there.
    assert.match(allowed.output, /Provider is not configured: anthropic/, allowed.output);
    assert.doesNotMatch(allowed.output, /session ban list \(entry/, allowed.output);

    withHarnessSettings(agent.dir, { sessionBanList: ["haiku"] });
    const refused = runPi(args, repo.dir, offlineEnv(agent));
    assert.match(refused.output, /session ban list \(entry 'haiku'\)/, refused.output);
    assert.match(refused.output, /This operation was aborted/, refused.output);
    assert.doesNotMatch(refused.output, /Provider is not configured/, refused.output);
  } finally { agent.cleanup(); repo.cleanup(); }
});
