import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installedPiSubagentsSrc, PI_SUBAGENTS_VERSION } from "./installed.ts";

// The lookup reads HOME and PI_CODING_AGENT_DIR, so each case runs in a
// child process against a throwaway home: the same probe against this
// reimplementation and, where installed, against pi-subagents itself.

const OURS = fileURLToPath(new URL("./agents.ts", import.meta.url));

interface Fixture {
  readonly home: string;
  readonly agentDir: string;
  readonly project: string;
  cleanup(): void;
}

function agentFile(name: string, extra: Record<string, string> = {}): string {
  const lines = [`name: ${name}`, `description: test agent ${name}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
  return `---\n${lines.join("\n")}\n---\nBody\n`;
}

function fixture(settings: { user?: unknown; project?: unknown } = {}): Fixture {
  const home = mkdtempSync(join(tmpdir(), "pi-orchestrator-agents-"));
  const agentDir = join(home, ".pi", "agent");
  const project = join(home, "work", "repo");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(project, ".pi", "agents"), { recursive: true });
  mkdirSync(join(project, ".git"), { recursive: true });
  writeFileSync(join(agentDir, "agents", "pinned.md"), agentFile("pinned", { model: "anthropic/claude-haiku-4-5" }));
  writeFileSync(join(agentDir, "agents", "loose.md"), agentFile("loose", { aliases: "lax, easy" }));
  writeFileSync(join(agentDir, "agents", "inherits.md"), agentFile("inherits", { model: "inherit" }));
  writeFileSync(join(agentDir, "agents", "scoped.md"), agentFile("tool", { package: "My Pkg" }));
  writeFileSync(join(agentDir, "agents", "notes.chain.md"), agentFile("chain"));
  writeFileSync(join(project, ".pi", "agents", "pinned.md"), agentFile("pinned", { model: "openai-codex/gpt-6-luna" }));
  writeFileSync(join(project, ".pi", "agents", "worker.md"), agentFile("worker", { model: "anthropic/claude-sonnet-5" }));
  if (settings.user !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings.user));
  if (settings.project !== undefined) writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify(settings.project));
  return { home, agentDir, project, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

const NAMES = ["global-agent", "pinned", "loose", "lax", "inherits", "my-pkg.tool", "tool", "worker", "developer", "oracle", "advisor", "reviewer", "chain", "missing"];

function probe(module: string, fx: Fixture, scope: string, provider?: string, env: NodeJS.ProcessEnv = { PI_OFFLINE: "1" }): unknown {
  const script =
    `const m = await import(${JSON.stringify(module)});` +
    `const scope = m.resolveExecutionAgentScope(${JSON.stringify(scope)});` +
    `const found = m.discoverAgents(${JSON.stringify(fx.project)}, scope, ${JSON.stringify(provider)}).agents;` +
    `const out = {};` +
    `for (const name of ${JSON.stringify(NAMES)}) { const r = m.resolveAgentName(name, found); ` +
    `out[name] = r.agent ? { name: r.agent.name, source: r.agent.source, model: r.agent.model, modelSourceType: r.agent.modelSource?.type, modelProvider: r.agent.modelProvider } : (r.error ? { error: r.error } : null); }` +
    `process.stdout.write(JSON.stringify({ scope, out }));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    cwd: fx.project,
    env: { PATH: process.env.PATH, HOME: fx.home, PI_CODING_AGENT_DIR: fx.agentDir, ...env },
    timeout: 30_000,
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

const SETTINGS_CASES: readonly [label: string, settings: { user?: unknown; project?: unknown }][] = [
  ["no settings", {}],
  ["user defaultModel and defaultProvider", { user: { subagents: { defaultModel: "anthropic/claude-haiku-4-5:low", defaultProvider: "anthropic" } } }],
  ["project defaultModel over user", { user: { subagents: { defaultModel: "a/b" } }, project: { subagents: { defaultModel: "c/d" } } }],
  ["overrides and provider overrides", {
    user: { subagents: { agentOverrides: { reviewer: { model: "anthropic/claude-sonnet-5" }, loose: { model: "x/y" }, pinned: { model: false } }, agentOverridesByProvider: { anthropic: { oracle: { model: "anthropic/claude-opus-5" } } } } },
  }],
  ["disableBuiltins and a disabled agent", { user: { subagents: { disableBuiltins: true, agentOverrides: { loose: { disabled: true } } } } }],
];

test("the lookup finds project over user over builtin, by name, local name and alias, and reads the definition's model", () => {
  const fx = fixture();
  try {
    const { out } = probe(OURS, fx, "anything") as { out: Record<string, { name: string; source: string; model?: string } | null> };
    assert.deepEqual(out.pinned, { name: "pinned", source: "project", model: "openai-codex/gpt-6-luna" });
    assert.equal(out.lax?.name, "loose");
    assert.equal(out.tool?.name, "my-pkg.tool");
    assert.equal(out.developer, null, "the project's worker replaces the builtin, and its aliases with it");
    assert.equal(out.worker?.model, "anthropic/claude-sonnet-5");
    assert.equal(out.advisor?.name, "oracle");
    assert.equal(out.chain, null, "chain files are not agents");
    assert.equal(out.missing, null);
  } finally { fx.cleanup(); }
});

test("a malformed subagents setting throws, which disables the router", () => {
  const fx = fixture({ user: { subagents: { disableBuiltins: "yes" } } });
  try {
    assert.throws(() => probe(OURS, fx, "both"), /invalid 'disableBuiltins'/);
  } finally { fx.cleanup(); }
});

test(`the lookup matches the installed pi-subagents ${PI_SUBAGENTS_VERSION}`, (t) => {
  const src = installedPiSubagentsSrc();
  if (!src) return t.skip("pi-subagents is not installed in ~/.pi/agent");
  const theirs = join(src, "agents", "agents.js");
  const theirsScope = join(src, "agents", "agent-scope.js");
  // pi-subagents splits the scope helper into its own module; a small shim joins them.
  const shimDir = mkdtempSync(join(tmpdir(), "pi-orchestrator-agents-shim-"));
  try {
    const shim = join(shimDir, "shim.mjs");
    writeFileSync(shim, `export { discoverAgents, resolveAgentName } from ${JSON.stringify(theirs)};\nexport { resolveExecutionAgentScope } from ${JSON.stringify(theirsScope)};\n`);
    for (const [label, settings] of SETTINGS_CASES) {
      for (const scope of ["both", "user", "project", undefined]) {
        for (const provider of [undefined, "anthropic"]) {
          const fx = fixture(settings);
          try {
            assert.deepEqual(probe(OURS, fx, scope as string, provider), probe(shim, fx, scope as string, provider), `${label}, scope ${scope}, provider ${provider}`);
          } finally { fx.cleanup(); }
        }
      }
    }
  } finally { rmSync(shimDir, { recursive: true, force: true }); }
});

/** A fake `npm` whose `root -g` names a global root holding one agent package. */
function fakeGlobalNpm(fx: Fixture): NodeJS.ProcessEnv {
  const bin = join(fx.home, "bin");
  const root = join(fx.home, "global", "node_modules");
  const pkg = join(root, "global-agents");
  mkdirSync(join(pkg, "agents"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "global-agents", pi: { subagents: { agents: ["./agents"] } } }));
  writeFileSync(join(pkg, "agents", "global-agent.md"), agentFile("global-agent", { model: "anthropic/claude-haiku-4-5" }));
  writeFileSync(join(bin, "npm"), `#!/bin/sh\necho ${root}\n`, { mode: 0o755 });
  return { PATH: `${bin}:${process.env.PATH}` };
}

test("agent packages in the global npm root are found, except offline", { skip: process.platform === "win32" }, () => {
  const fx = fixture();
  try {
    const env = fakeGlobalNpm(fx);
    const online = probe(OURS, fx, "both", undefined, env) as { out: Record<string, { source: string; model?: string } | null> };
    assert.deepEqual(online.out["global-agent"], { name: "global-agent", source: "package", model: "anthropic/claude-haiku-4-5" });
    const offline = probe(OURS, fx, "both", undefined, { ...env, PI_OFFLINE: "1" }) as { out: Record<string, unknown> };
    assert.equal(offline.out["global-agent"], null);
    const projectOnly = probe(OURS, fx, "project", undefined, env) as { out: Record<string, unknown> };
    assert.equal(projectOnly.out["global-agent"], null, "the global root is a user source");
  } finally { fx.cleanup(); }
});

test(`the global npm root lookup matches the installed pi-subagents ${PI_SUBAGENTS_VERSION}`, { skip: process.platform === "win32" }, (t) => {
  const src = installedPiSubagentsSrc();
  if (!src) return t.skip("pi-subagents is not installed in ~/.pi/agent");
  const shimDir = mkdtempSync(join(tmpdir(), "pi-orchestrator-agents-shim-"));
  try {
    const shim = join(shimDir, "shim.mjs");
    writeFileSync(shim, `export { discoverAgents, resolveAgentName } from ${JSON.stringify(join(src, "agents", "agents.js"))};\nexport { resolveExecutionAgentScope } from ${JSON.stringify(join(src, "agents", "agent-scope.js"))};\n`);
    for (const scope of ["both", "user", "project"]) {
      const fx = fixture();
      try {
        const env = fakeGlobalNpm(fx);
        assert.deepEqual(probe(OURS, fx, scope, undefined, env), probe(shim, fx, scope, undefined, env), `scope ${scope}`);
      } finally { fx.cleanup(); }
    }
  } finally { rmSync(shimDir, { recursive: true, force: true }); }
});
