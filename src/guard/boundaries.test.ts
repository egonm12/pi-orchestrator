import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configureBanLists, resetBanLists } from "../policy/ban-lists.ts";
import { launchesUnguardedPi, toolRefusal, protectedAgentPath } from "./boundaries.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

const ctx = { agentDir: "/tmp/guard-agent", cwd: "/tmp/work" };

test("model fields are banned across tools and nested delegation objects, not prose or shell text", () => {
  for (const model of ["anthropic/claude-fable-5", "anthropic/claude-fable-5-1", "anthropic/claude-fable-6", "openai-codex/gpt-6-astra", "ANTHROPIC/CLAUDE-FABLE-5"]) {
    assert.match(toolRefusal("subagent", { tasks: [{ workflow: { model } }] }, ctx)!, /prohibited model/, model);
    assert.match(toolRefusal("mcp", { model }, ctx)!, /prohibited model/, model);
    assert.match(toolRefusal("subagent", { chain: [{ model }] }, ctx)!, /prohibited model/, model);
    assert.match(toolRefusal("subagent", { workflow: { steps: [{ model }] } }, ctx)!, /prohibited model/, model);
    assert.match(toolRefusal("subagent", { MoDeL: model }, ctx)!, /prohibited model/, model);
    assert.equal(toolRefusal("read", {}, ctx), undefined);
    assert.equal(toolRefusal("bash", { command: `echo 'A commit about ${model}'` }, ctx), undefined);
    assert.equal(toolRefusal("bash", { command: `git commit -m 'A story about ${model}'` }, ctx), undefined);
  }
  assert.equal(toolRefusal("subagent", { task: "tell a fable about astra", model: "anthropic/claude-haiku-4-5" }, ctx), undefined);
  assert.equal(toolRefusal("mcp", { dataModel: "astra-db", modelId: "anthropic/claude-fable-5" }, ctx), undefined);
  assert.equal(toolRefusal("subagent", { modelId: "anthropic/claude-fable-5", workflow: { steps: [{ dataModel: "astra-db" }] } }, ctx), undefined);
  assert.equal(toolRefusal("mcp", { payload: { model: "anthropic/claude-fable-5" } }, ctx), undefined);
});

test("only executable pi disabling or redirecting extensions is refused", () => {
  for (const command of ["pi -ne -p hi", "pi --no-extensions -p hi", "sh -c 'pi -ne -p hi'", "bash -lc 'p\"i\" --no-extensions'", "\\pi -ne", "PI_CODING_AGENT_DIR=/tmp/other pi -p hi", "env PI_CODING_AGENT_DIR=/tmp/other pi -p hi", "PI_CODING_AGENT_DIR=/tmp/other sh -c 'pi -p hi'"]) {
    assert.equal(launchesUnguardedPi(command, ctx), true, command);
    assert.match(toolRefusal("bash", { command }, ctx)!, /nested pi/, command);
  }
  for (const command of ["pi -p hello", "sh -c 'pi --model anthropic/claude-haiku-4-5'", "git push origin main", "rm -rf node_modules", "echo 'run pi -ne to debug'", "rg 'pi -ne' .", "grep -rn 'pi --no-extensions' docs/", "cat <<'EOF'\npi -ne\nEOF", "sh -c 'echo pi -ne'", "ps aux | head -1", "PI_CODING_AGENT_DIR=/tmp/guard-agent pi -p hi", "env PI_CODING_AGENT_DIR=/tmp/guard-agent pi -p hi"]) {
    assert.equal(launchesUnguardedPi(command, ctx), false, command);
    assert.equal(toolRefusal("bash", { command }, ctx), undefined, command);
  }
});

test("all tools and roles are allowed unless one of the three checks applies", () => {
  for (const tool of ["mcp", "ctx_execute", "web_search", "contact_supervisor", "powershell", "subagent", "write", "edit"]) {
    assert.equal(toolRefusal(tool, {}, ctx), undefined, tool);
  }
});

test("write and edit reject canonical symlink, tilde, and case-equivalent agent paths", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-guard-path-"));
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const agentDir = join(home, ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    symlinkSync(agentDir, join(home, "alias"));
    const scene = { agentDir, cwd: home };
    for (const spelling of [join(home, "alias"), "$HOME/.pi/agent", "${HOME}/.pi/agent", "~/.pi/agent"]) {
      assert.equal(toolRefusal("bash", { command: `PI_CODING_AGENT_DIR=${spelling} pi -p hi` }, scene), undefined, spelling);
    }
    assert.match(toolRefusal("bash", { command: "PI_CODING_AGENT_DIR=$HOME/other pi -p hi" }, scene)!, /nested pi/);
    for (const path of [join(agentDir, "new.txt"), "alias/new.txt", ".pi/agent/new.txt", "~/.pi/agent/new.txt"]) {
      assert.equal(protectedAgentPath(path, scene), true, path);
      for (const tool of ["write", "edit"]) assert.match(toolRefusal(tool, { path }, scene)!, /agent directory/);
    }
    const alternate = join(home, ".PI", "AGENT", "new.txt");
    const caseEquivalent = existsSync(join(home, ".PI", "AGENT"));
    assert.equal(protectedAgentPath(alternate, scene), caseEquivalent);
    assert.equal(toolRefusal("bash", { command: "PI_CODING_AGENT_DIR=~/.PI/agent pi -p hi" }, scene) === undefined, caseEquivalent);
    assert.equal(toolRefusal("write", { path: alternate }, scene) !== undefined, caseEquivalent);
    assert.equal(toolRefusal("write", { path: join(home, "project.txt") }, scene), undefined);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("write and edit may use the agent directory's sessions subtree, where subagent extensions keep artifacts, and nothing else there", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-guard-sessions-"));
  const originalHome = process.env.HOME;
  try {
    process.env.HOME = home;
    const agentDir = join(home, ".pi", "agent");
    const artifacts = join(agentDir, "sessions", "--project--", "subagent-artifacts", "outputs", "run-1");
    mkdirSync(artifacts, { recursive: true });
    symlinkSync(agentDir, join(home, "alias"));
    symlinkSync(agentDir, join(agentDir, "sessions", "escape"));
    const scene = { agentDir, cwd: home };
    for (const path of [join(artifacts, "standard.md"), "alias/sessions/--project--/subagent-artifacts/outputs/run-1/standard.md", "~/.pi/agent/sessions/new.md"]) {
      for (const tool of ["write", "edit"]) assert.equal(toolRefusal(tool, { path }, scene), undefined, `${tool} ${path}`);
    }
    for (const path of [join(agentDir, "sessions"), join(agentDir, "sessions", "..", "settings.json"), join(agentDir, "sessions", "escape", "settings.json"),
      join(agentDir, "settings.json"), join(agentDir, "pi-orchestrator", "authorized-recipients.json"), join(agentDir, "sessions-backup", "x.md")]) {
      for (const tool of ["write", "edit"]) assert.match(toolRefusal(tool, { path }, scene) ?? "", /agent directory/, `${tool} ${path}`);
    }
    // A sessions/ that points back at the agent directory opens nothing.
    const looped = join(home, "looped");
    mkdirSync(looped);
    symlinkSync(looped, join(looped, "sessions"));
    assert.match(toolRefusal("write", { path: join(looped, "sessions", "settings.json") }, { agentDir: looped, cwd: home }) ?? "", /agent directory/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  }
});

const WITH_SONNET = { subagentBanList: ["fable", "astra", "sonnet"], sessionBanList: [] };

test("a subagent call naming a model added to the configured subagent ban list is refused, and admitted once the name is removed", () => {
  try {
    configureBanLists(WITH_SONNET);
    assert.match(toolRefusal("subagent", { agent: "worker", task: "say hello", model: "anthropic/claude-sonnet-5" }, ctx)!, /prohibited model: anthropic\/claude-sonnet-5/);
    assert.match(toolRefusal("subagent", { tasks: [{ model: "ANTHROPIC/CLAUDE-SONNET-5:high" }] }, ctx)!, /prohibited model/);
    configureBanLists({ subagentBanList: ["fable", "astra"], sessionBanList: [] });
    assert.equal(toolRefusal("subagent", { agent: "worker", task: "say hello", model: "anthropic/claude-sonnet-5" }, ctx), undefined);
  } finally {
    resetBanLists();
  }
});

test("the session ban list does not bind subagent calls", () => {
  try {
    configureBanLists({ subagentBanList: ["fable", "astra"], sessionBanList: ["haiku"] });
    assert.equal(toolRefusal("subagent", { agent: "worker", task: "say hello", model: "anthropic/claude-haiku-4-5" }, ctx), undefined);
  } finally {
    resetBanLists();
  }
});

test("a subagent call naming the session's own subagent-banned model is refused", () => {
  // The session may run on anthropic/claude-fable-5-1 (ADR 0002); delegating to it is still refused.
  assert.match(toolRefusal("subagent", { agent: "worker", task: "say hello", model: "anthropic/claude-fable-5-1" }, ctx)!, /prohibited model: anthropic\/claude-fable-5-1/);
});

test("banned names in commit messages, shell text, write paths and subagent task text are allowed under the configured list", () => {
  try {
    configureBanLists(WITH_SONNET);
    assert.equal(toolRefusal("bash", { command: 'git commit -m "drop the fable idea"' }, ctx), undefined);
    assert.equal(toolRefusal("bash", { command: "echo astra" }, ctx), undefined);
    assert.equal(toolRefusal("write", { path: "notes/astra.md", content: "Fable, Astra and Sonnet" }, ctx), undefined);
    assert.equal(toolRefusal("subagent", { agent: "worker", task: "compare Fable and Sonnet in notes/astra.md", model: "anthropic/claude-haiku-4-5" }, ctx), undefined);
  } finally {
    resetBanLists();
  }
});
