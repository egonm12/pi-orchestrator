import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { buildCatalog, type ModelCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState, type RefreshState, type ThrottlingObservation } from "../catalog/refresh-lifecycle.ts";
import type { UsageHeadroom } from "../catalog/model-catalog.ts";
import { withUsageHeadroom } from "../fixtures/catalog-facts.ts";
import { known } from "../catalog/epistemic.ts";
import { saveAuthorization } from "../recipients/authorization.ts";
import { defaultStateDir } from "./extension.ts";
import { installRouterEntry, ROUTER_ENTRY_NAME } from "../fixtures/extension-entry.ts";
import { GUARD_ENTRY_NAME } from "../fixtures/extension-entry.ts";
import { createGuardedAgentDir } from "../fixtures/guarded-agent-dir.ts";
import { pathToFileURL } from "node:url";
import { stateFolderEvidence } from "./evidence.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, type RecipientAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, type RoutingRecord } from "../routing/decision-record.ts";
import { answerEvents, errorEvents, fakeSessionRegistry, assistantMessage } from "../fixtures/session-model-registry.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext as ExtensionContext } from "../fixtures/extension-context.ts";
import type { SessionModelRegistry } from "../routing/model-stream.ts";
import { createRouterExtension, type RouterDependencies, type RoutingEvidence } from "./extension.ts";
import { OWNER_BAN_LIST_SETTINGS, useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

type ProviderConfigInput = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>;
type AutoStream = NonNullable<ProviderConfigInput["streamSimple"]>;
const AUTO_MODEL = { provider: "orchestrator", id: "auto", api: "orchestrator-auto" } as Parameters<AutoStream>[0];

useOwnerBanLists();

// Seam 1 (docs/specs/auto-routing.md, "Testing decisions"): the router's hook,
// called directly. The fakes sit at the system boundaries only: the classifier
// model call, the evidence source (catalog, ticket 08 refresh state, approved
// recipients), the clock, and settings files in a throwaway agent dir and
// project dir. Every assertion reads one of three outputs: the call's `model`
// fields, whether the call was blocked, and the records in the state folder.

const originalEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_ORCHESTRATOR_STATE_DIR: process.env.PI_ORCHESTRATOR_STATE_DIR,
  PI_ORCHESTRATOR_ROUTER_PROBE: process.env.PI_ORCHESTRATOR_ROUTER_PROBE,
  PI_ORCHESTRATOR_SESSION_MODEL: process.env.PI_ORCHESTRATOR_SESSION_MODEL,
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  PI_SUBAGENTS_HERDR_BRIDGE: process.env.PI_SUBAGENTS_HERDR_BRIDGE,
  PI_OFFLINE: process.env.PI_OFFLINE,
};
delete process.env.PI_ORCHESTRATOR_ROUTER_PROBE;
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENTS_HERDR_BRIDGE;
after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetBanLists();
});

const HAIKU = "anthropic/claude-haiku-4-5";
const TEST_TIERS = {
  mechanical: [`${HAIKU}:low`, "openai-codex/gpt-6-luna:low"],
  standard: ["anthropic/claude-sonnet-5:medium", "openai-codex/gpt-6-sol:medium"],
  elevated: ["anthropic/claude-opus-5:high", "openai-codex/gpt-6-sol:high"],
  critical: ["anthropic/claude-opus-5:xhigh", "openai-codex/gpt-6-sol:xhigh"],
};

const NOW = new Date("2026-09-26T12:00:00.000Z");

function approved(...providers: string[]): RecipientAuthorization {
  let authorization = emptyAuthorization();
  for (const provider of providers) {
    const approval = grantOwnerApproval({ approvedBy: "owner", scope: "data-recipient", acknowledgement: `send delegation data to ${provider}` });
    authorization = authorizeRecipient(authorization, provider, approval);
  }
  return authorization;
}

function evidenceOf(overrides: Partial<RoutingEvidence> = {}): RoutingEvidence {
  return {
    catalog: buildCatalog({ modelIds: INSTALLED_MODEL_IDS, now: NOW }),
    refreshState: emptyRefreshState(),
    authorization: approved("anthropic", "openai-codex"),
    ...overrides,
  };
}

/** A classifier model that always answers `tier`. */
function answering(tier: string, kindOfWork = "implement") {
  const prompts: string[] = [];
  const call = async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ tier, risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork, why: `fake classifier says ${tier}` });
  };
  return { call, prompts };
}

interface Harness {
  readonly agentDir: string;
  readonly projectDir: string;
  readonly stateDir: string;
  records(): RoutingRecord[];
  cleanup(): void;
}

function harness(routing: unknown, extra: Record<string, unknown> = {}): Harness {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-router-"));
  const agentDir = join(home, "agent"), projectDir = join(home, "project"), stateDir = join(home, "state");
  mkdirSync(agentDir);
  mkdirSync(projectDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ orchestrator: { routing, ...extra } }));
  // pi-subagents' agent discovery also reads `~/.agents`: a throwaway home
  // keeps the owner's agents out of the test. `PI_OFFLINE=1` stops it running
  // `npm root -g` and reading agents from the global npm packages.
  process.env.HOME = home;
  process.env.PI_OFFLINE = "1";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ORCHESTRATOR_STATE_DIR = stateDir;
  return {
    agentDir,
    projectDir,
    stateDir,
    records: () => readRoutingRecords(join(stateDir, "routing")),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface LoadedRouter {
  readonly ctx: ExtensionContext;
  toolCall(input: Record<string, unknown>, toolCallId?: string): Promise<unknown>;
}

const SESSION_MODEL = { provider: "anthropic", id: "claude-haiku-4-5" };

// Each synthetic pi load is an isolated module instance, as a separate test
// process would be. Within one test, reuse a factory to check process-wide state.
let isolatedModule = 0;
function startFreshProcess(): void {
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-orchestrator.router.disabled-line-reported")];
}
async function isolatedRouterExtension(): Promise<typeof createRouterExtension> {
  startFreshProcess();
  return (await import(`./extension.ts?seam-1=${++isolatedModule}`)).createRouterExtension;
}

async function loadRouter(h: Harness, deps: Partial<RouterDependencies> = {}, model = SESSION_MODEL): Promise<LoadedRouter> {
  return loadRouterWith(h, { classifierCall: () => answering("mechanical").call, ...deps }, model, fakeSessionRegistry([]));
}

/** The router with the classifier call it would use in pi (unless `deps`
 *  replaces it): the in-session call over `modelRegistry`. */
async function loadRouterWith(h: Harness, deps: Partial<RouterDependencies>, model: typeof SESSION_MODEL | undefined, modelRegistry: SessionModelRegistry): Promise<LoadedRouter> {
  const handlers = new Map<string, Handler>();
  const createIsolatedRouterExtension = await isolatedRouterExtension();
  const factory = createIsolatedRouterExtension({
    evidence: () => () => evidenceOf(),
    now: () => NOW,
    ...deps,
  });
  await factory({ on(event: string, handler: Handler) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
  const ctx: ExtensionContext = {
    cwd: h.projectDir,
    hasUI: false,
    model,
    modelRegistry,
    sessionManager: { getSessionId: () => "session-27" },
  };
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
  return {
    ctx,
    toolCall: async (input, toolCallId = "call-1") => handlers.get("tool_call")?.({ type: "tool_call", toolCallId, toolName: "subagent", input }, ctx),
  };
}

/** Everything written to stderr while `run` runs. */
async function stderrOf(run: () => Promise<unknown>): Promise<string> {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stderr.write;
  try { await run(); } finally { process.stderr.write = original; }
  // The fresh-install notice is covered by init/setup.test.ts.
  output = output.split("\n").filter((line) => !line.startsWith("pi-orchestrator: not set up:")).join("\n");
  return output;
}

const CLASSIFIER = { model: `${HAIKU}:low`, timeoutMs: 1_000 };
const LIVE = { enabled: true, mode: "live", classifier: CLASSIFIER, tiers: TEST_TIERS };
const SHADOW = { enabled: true, mode: "shadow", classifier: CLASSIFIER, tiers: TEST_TIERS };

// ---------------------------------------------------------------------------
// Checkbox 1 (stories 38, 39): a named model wins and is recorded as explicit
// ---------------------------------------------------------------------------

test("a subagent call naming a model is left unchanged and recorded as explicit", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouter(h);
    const input = { agent: "worker", task: "Rename the helper in src/util.ts", model: "anthropic/claude-opus-5-5:high" };
    assert.equal(await router.toolCall(input), undefined);
    assert.deepEqual(input, { agent: "worker", task: "Rename the helper in src/util.ts", model: "anthropic/claude-opus-5-5:high" });
    assert.deepEqual(h.records(), [{
      recordType: "explicit",
      schemaVersion: "decision-record/2",
      delegationId: "call-1",
      timestamp: "2026-09-26T12:00:00.000Z",
      cause: "explicit",
      mode: "live",
      slot: "model",
      model: "anthropic/claude-opus-5-5:high",
      taskTextPrefix: "Rename the helper in src/util.ts",
      agentRole: "worker",
    }]);
  } finally { h.cleanup(); }
});

/** The fields of a record that say what was decided, for compact assertions. */
function summary(record: RoutingRecord): Record<string, unknown> {
  if (record.recordType === "explicit") return { recordType: record.recordType, delegationId: record.delegationId, mode: record.mode, slot: record.slot, model: record.model };
  if (record.recordType !== "decision") return { recordType: record.recordType, delegationId: record.delegationId };
  return {
    recordType: record.recordType,
    delegationId: record.delegationId,
    mode: record.mode,
    tier: record.classification.tier,
    cause: record.classification.cause,
    route: record.route.outcome === "chosen" ? record.route.rung.rung : `refused: ${record.route.removed.map((removed) => `${removed.rung} (${removed.reason})`).join("; ")}`,
    ...(record.handPickedModel === undefined ? {} : { handPickedModel: record.handPickedModel }),
  };
}

test("a model in tasks[1] is left alone and recorded as explicit while tasks[0], which names none, is routed", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouter(h);
    const input = { tasks: [
      { agent: "worker", task: "Fix the typo in README.md" },
      { agent: "reviewer", task: "Review the typo fix", model: "anthropic/claude-opus-5-5:high" },
    ] };
    assert.equal(await router.toolCall(input), undefined);
    assert.deepEqual(input, { tasks: [
      { agent: "worker", task: "Fix the typo in README.md", model: "anthropic/claude-haiku-4-5:low" },
      { agent: "reviewer", task: "Review the typo fix", model: "anthropic/claude-opus-5-5:high" },
    ] });
    assert.deepEqual(h.records().map(summary), [
      { recordType: "decision", delegationId: "call-1:tasks[0]", mode: "live", tier: "mechanical", cause: "model:anthropic/claude-haiku-4-5:low", route: "anthropic/claude-haiku-4-5:low" },
      { recordType: "explicit", delegationId: "call-1:tasks[1]", mode: "live", slot: "tasks[1].model", model: "anthropic/claude-opus-5-5:high" },
    ]);
  } finally { h.cleanup(); }
});

test("a model named at the top level covers the nested tasks, which are not routed", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouter(h);
    const input = { model: "anthropic/claude-opus-5-5:high", tasks: [{ agent: "worker", task: "Fix the typo in README.md" }] };
    await router.toolCall(input);
    assert.deepEqual(input, { model: "anthropic/claude-opus-5-5:high", tasks: [{ agent: "worker", task: "Fix the typo in README.md" }] });
    assert.deepEqual(h.records().map(summary), [
      { recordType: "explicit", delegationId: "call-1", mode: "live", slot: "model", model: "anthropic/claude-opus-5-5:high" },
    ]);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Checkbox 2 (story 40) and checkbox 3's seam-1 half (story 41)
// ---------------------------------------------------------------------------

test("in shadow mode a call with no model proceeds unchanged and the record shows the router's rung against the session model", async () => {
  const h = harness(SHADOW);
  try {
    const router = await loadRouter(h, { classifierCall: () => answering("standard").call });
    const input = { agent: "worker", task: "Add a retry option to the fetch helper" };
    assert.equal(await router.toolCall(input), undefined);
    assert.deepEqual(input, { agent: "worker", task: "Add a retry option to the fetch helper" });
    assert.deepEqual(h.records().map(summary), [
      { recordType: "decision", delegationId: "call-1", mode: "shadow", tier: "standard", cause: "model:anthropic/claude-haiku-4-5:low", route: "anthropic/claude-sonnet-5:medium", handPickedModel: "anthropic/claude-haiku-4-5" },
    ]);
    const record = h.records()[0];
    assert.equal(record?.recordType === "decision" && record.ranOn, HAIKU);
  } finally { h.cleanup(); }
});

test("in live mode the same call runs on the router's rung, written into its model field", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouter(h, { classifierCall: () => answering("standard").call });
    const input = { agent: "worker", task: "Add a retry option to the fetch helper" };
    assert.equal(await router.toolCall(input), undefined);
    assert.deepEqual(input, { agent: "worker", task: "Add a retry option to the fetch helper", model: "anthropic/claude-sonnet-5:medium" });
    assert.deepEqual(h.records().map(summary), [
      { recordType: "decision", delegationId: "call-1", mode: "live", tier: "standard", cause: "model:anthropic/claude-haiku-4-5:low", route: "anthropic/claude-sonnet-5:medium" },
    ]);
    const record = h.records()[0];
    assert.equal(record?.recordType === "decision" && record.ranOn, "anthropic/claude-sonnet-5:medium");
  } finally { h.cleanup(); }
});

test("chain steps and workflow steps with no model are routed the same way (story 39)", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouter(h);
    const input = {
      chain: [{ agent: "scout", task: "List the files under docs/" }],
      workflow: { steps: [{ agent: "worker", task: "Fix the typo in README.md" }] },
    };
    await router.toolCall(input);
    assert.deepEqual(input, {
      chain: [{ agent: "scout", task: "List the files under docs/", model: "anthropic/claude-haiku-4-5:low" }],
      workflow: { steps: [{ agent: "worker", task: "Fix the typo in README.md", model: "anthropic/claude-haiku-4-5:low" }] },
    });
    assert.deepEqual(h.records().map((record) => record.delegationId), ["call-1:chain[0]", "call-1:workflow.steps[0]"]);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// An agent definition's own model is a pin (story 38): pi-subagents resolves
// a call's model, else the agent definition's, else the session model
// (`resolveEffectiveSubagentModel`). A `subagents.defaultModel` in settings
// is a global default, not a pin, so routing replaces it.
// ---------------------------------------------------------------------------

function writeAgent(h: Harness, name: string, model?: string): void {
  mkdirSync(join(h.agentDir, "agents"), { recursive: true });
  writeFileSync(join(h.agentDir, "agents", `${name}.md`), [
    "---",
    `name: ${name}`,
    "description: A throwaway agent for the router's tests",
    ...(model === undefined ? [] : [`model: ${model}`]),
    "---",
    "",
    "Do the task.",
    "",
  ].join("\n"));
}

for (const routing of [LIVE, SHADOW]) {
  test(`with mode ${routing.mode}, a call naming an agent whose definition sets a model is left unchanged and recorded as explicit`, async () => {
    const h = harness(routing);
    try {
      writeAgent(h, "pinned-reviewer", "anthropic/claude-opus-5");
      const router = await loadRouter(h);
      const input = { agent: "pinned-reviewer", task: "Review the typo fix in README.md" };
      assert.equal(await router.toolCall(input), undefined);
      assert.deepEqual(input, { agent: "pinned-reviewer", task: "Review the typo fix in README.md" });
      assert.deepEqual(h.records().map(summary), [
        { recordType: "explicit", delegationId: "call-1", mode: routing.mode, slot: "agent:pinned-reviewer.model", model: "anthropic/claude-opus-5" },
      ]);
    } finally { h.cleanup(); }
  });
}

test("a subagents.defaultModel in settings is routed over: the rung is written when mode is live, and shadow records that default as the hand-picked model", async () => {
  for (const routing of [LIVE, SHADOW]) {
    const h = harness(routing);
    try {
      writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ subagents: { defaultModel: "anthropic/claude-sonnet-5:high" }, orchestrator: { routing } }));
      writeAgent(h, "plain-worker");
      const router = await loadRouter(h);
      const input: Record<string, unknown> = { agent: "plain-worker", task: "Fix the typo in README.md" };
      await router.toolCall(input);
      assert.equal(input.model, routing.mode === "live" ? `${HAIKU}:low` : undefined);
      assert.deepEqual(h.records().map(summary), [
        {
          recordType: "decision", delegationId: "call-1", mode: routing.mode, tier: "mechanical", cause: `model:${HAIKU}:low`, route: `${HAIKU}:low`,
          ...(routing.mode === "shadow" ? { handPickedModel: "anthropic/claude-sonnet-5" } : {}),
        },
      ]);
      const record = h.records()[0];
      assert.equal(record?.recordType === "decision" && record.ranOn, routing.mode === "shadow" ? "anthropic/claude-sonnet-5" : `${HAIKU}:low`);
    } finally { h.cleanup(); }
  }
});

test("agent discovery that throws at hook time: the call proceeds unchanged and one disabled line is printed", async () => {
  const h = harness(LIVE);
  try {
    // pi-subagents reads `subagents` strictly and throws on a malformed key.
    writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ subagents: { disableBuiltins: "yes" }, orchestrator: { routing: LIVE } }));
    assert.match(await assertFailsOpen(h), /disableBuiltins/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Checkbox 4 (story 41): switched off, the hook writes nothing
// ---------------------------------------------------------------------------

for (const [label, routing] of [["enabled: false", { ...LIVE, enabled: false }], ["no enabled key", { mode: "live", classifier: CLASSIFIER, tiers: TEST_TIERS }]] as const) {
  test(`with ${label} the hook changes nothing, records nothing and prints nothing`, async () => {
    const h = harness(routing);
    try {
      const input = { agent: "worker", task: "Fix the typo in README.md" };
      const stderr = await stderrOf(async () => {
        const router = await loadRouter(h);
        assert.equal(await router.toolCall(input), undefined);
      });
      assert.deepEqual(input, { agent: "worker", task: "Fix the typo in README.md" });
      assert.equal(existsSync(h.stateDir), false);
      assert.equal(stderr, "");
    } finally { h.cleanup(); }
  });
}

// ---------------------------------------------------------------------------
// Checkbox 5 (story 42): fail open with exactly one line
// ---------------------------------------------------------------------------

async function assertFailsOpen(h: Harness, deps: Partial<RouterDependencies> = {}): Promise<string> {
  const input = { agent: "worker", task: "Fix the typo in README.md" };
  const results: unknown[] = [];
  const stderr = await stderrOf(async () => {
    const router = await loadRouter(h, deps);
    results.push(await router.toolCall(input, "call-1"));
    results.push(await router.toolCall(input, "call-2"));
  });
  assert.deepEqual(results, [undefined, undefined], "the call is never blocked");
  assert.deepEqual(input, { agent: "worker", task: "Fix the typo in README.md" });
  const lines = stderr.split("\n").filter((line) => line.length > 0);
  assert.equal(lines.length, 1, stderr);
  assert.match(lines[0]!, /^pi-orchestrator router disabled: /);
  return lines[0]!;
}

test("an unreadable settings file: the call proceeds unchanged and one disabled line is printed", async () => {
  const h = harness(LIVE);
  try {
    rmSync(join(h.agentDir, "settings.json"));
    mkdirSync(join(h.agentDir, "settings.json"));
    assert.match(await assertFailsOpen(h), /cannot read settings file/);
  } finally { h.cleanup(); }
});

test("a classifier model name that does not exist: the call proceeds unchanged and one disabled line is printed", async () => {
  const h = harness({ ...LIVE, classifier: { model: "anthropic/claude-haiku-9-9:low" } });
  try {
    assert.match(await assertFailsOpen(h), /classifier rung 'anthropic\/claude-haiku-9-9:low' names a model pi does not have/);
  } finally { h.cleanup(); }
});

test("a router that throws: the call proceeds unchanged and one disabled line is printed", async () => {
  const h = harness(LIVE);
  try {
    // The approved-recipient filter is the router's last hard filter; a store
    // that throws when read makes `routeTier` itself throw.
    const throwing = { schemaVersion: 1, get recipients(): never { throw new Error("recipient store exploded"); } };
    const line = await assertFailsOpen(h, { evidence: () => () => evidenceOf({ authorization: throwing }) });
    assert.match(line, /recipient store exploded/);
    assert.equal(existsSync(join(h.stateDir, "routing")), false, "nothing was recorded");
  } finally { h.cleanup(); }
});

test("an unwritable record folder: the call proceeds unchanged and one disabled line is printed", async () => {
  const h = harness(LIVE);
  try {
    mkdirSync(h.stateDir);
    writeFileSync(join(h.stateDir, "routing"), "a file where the record folder should be\n");
    assert.match(await assertFailsOpen(h), /EEXIST|ENOTDIR/);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Classifier input: task text, agent role and the paths the task names
// ---------------------------------------------------------------------------

test("the classifier sees the slot's task, its agent role and the file paths the task text names", async () => {
  const h = harness(SHADOW);
  try {
    const classifier = answering("mechanical");
    const router = await loadRouter(h, { classifierCall: () => classifier.call });
    await router.toolCall({ agent: "worker", task: "Fix `src/math.ts` and README.md, e.g. the add() typo; see https://example.com/issues/3 and (docs/specs/auto-routing.md)." });
    assert.equal(classifier.prompts.length, 1);
    assert.ok(classifier.prompts[0]!.endsWith([
      "Agent role: worker",
      "Named file paths:",
      "- src/math.ts",
      "- README.md",
      "- docs/specs/auto-routing.md",
    ].join("\n")), classifier.prompts[0]!.slice(-400));
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// providerUsage, derived from ticket 08's observations (README, ticket 24):
// any model of a provider known to have nothing left makes the provider out of
// usage, until its `resetsAt` passes or for five hours after `asOf` when it
// names no reset; a throttling observation of any model of a provider holds
// for its `retryAfterSeconds`, or five minutes when it gives none.
// ---------------------------------------------------------------------------

function withThrottling(...observations: ThrottlingObservation[]): RefreshState {
  return { ...emptyRefreshState(), throttling: observations };
}

function headroom(model: string, value: UsageHeadroom, asOf: string): Partial<RoutingEvidence> {
  return { catalog: withUsageHeadroom(evidenceOf().catalog, { [model]: value }, { asOf }) };
}

const USAGE_CASES: ReadonlyArray<readonly [string, Partial<RoutingEvidence>, string, readonly string[]]> = [
  ["no observation", {}, `${HAIKU}:low`, []],
  ["a routed model with 0 requests left an hour ago", headroom(HAIKU, { kind: "requests", remaining: 0 }, "2026-09-26T11:00:00.000Z"), "openai-codex/gpt-6-luna:low", ["provider out of usage"]],
  ["another model of the provider with $0 left an hour ago", headroom("anthropic/claude-opus-5", { kind: "metered", remainingUsd: 0 }, "2026-09-26T11:00:00.000Z"), "openai-codex/gpt-6-luna:low", ["provider out of usage"]],
  ["0 left, observed five and a half hours ago", headroom(HAIKU, { kind: "requests", remaining: 0 }, "2026-09-26T06:30:00.000Z"), `${HAIKU}:low`, []],
  ["0 left with a reset that has passed", headroom(HAIKU, { kind: "requests", remaining: 0, resetsAt: "2026-09-26T11:30:00.000Z" }, "2026-09-26T11:00:00.000Z"), `${HAIKU}:low`, []],
  ["0 left with a reset still ahead, observed six hours ago", headroom(HAIKU, { kind: "requests", remaining: 0, resetsAt: "2026-09-26T13:00:00.000Z" }, "2026-09-26T06:00:00.000Z"), "openai-codex/gpt-6-luna:low", ["provider out of usage"]],
  ["3 requests left", headroom(HAIKU, { kind: "requests", remaining: 3 }, "2026-09-26T11:00:00.000Z"), `${HAIKU}:low`, []],
  ["a throttle three minutes ago with no retry-after", { refreshState: withThrottling({ model: "anthropic/claude-sonnet-5", observedAt: "2026-09-26T11:57:00.000Z" }) }, "openai-codex/gpt-6-luna:low", ["provider throttled"]],
  ["a throttle six minutes ago with no retry-after", { refreshState: withThrottling({ model: "anthropic/claude-sonnet-5", observedAt: "2026-09-26T11:54:00.000Z" }) }, `${HAIKU}:low`, []],
  ["a throttle a minute ago whose 30 s retry-after has passed", { refreshState: withThrottling({ model: HAIKU, observedAt: "2026-09-26T11:59:00.000Z", retryAfterSeconds: 30 }) }, `${HAIKU}:low`, []],
  ["a throttle ten minutes ago with a 20-minute retry-after", { refreshState: withThrottling({ model: HAIKU, observedAt: "2026-09-26T11:50:00.000Z", retryAfterSeconds: 1_200 }) }, "openai-codex/gpt-6-luna:low", ["provider throttled"]],
  [
    "0 left and a throttle a minute ago on the same provider: out of usage wins",
    { ...headroom(HAIKU, { kind: "requests", remaining: 0 }, "2026-09-26T11:00:00.000Z"), refreshState: withThrottling({ model: "anthropic/claude-sonnet-5", observedAt: "2026-09-26T11:59:00.000Z" }) },
    "openai-codex/gpt-6-luna:low",
    ["provider out of usage"],
  ],
];

for (const [label, overrides, rung, reasons] of USAGE_CASES) {
  test(`provider usage from ticket 08's observations: ${label}`, async () => {
    const h = harness(LIVE);
    try {
      const router = await loadRouter(h, { evidence: () => () => evidenceOf(overrides) });
      const input: Record<string, unknown> = { agent: "worker", task: "Fix the typo in README.md" };
      await router.toolCall(input);
      assert.equal(input.model, rung);
      const [record] = h.records();
      assert.equal(record?.recordType, "decision");
      if (record?.recordType === "decision") assert.deepEqual(record.route.removed.map((removed) => removed.reason), reasons);
    } finally { h.cleanup(); }
  });
}

// ---------------------------------------------------------------------------
// Refusals and calls the router does not route: the call is never changed
// ---------------------------------------------------------------------------

test("a router refusal leaves the call unchanged in live mode and is recorded", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouter(h, { evidence: () => () => evidenceOf({ authorization: emptyAuthorization() }) });
    const input = { agent: "worker", task: "Fix the typo in README.md" };
    assert.equal(await router.toolCall(input), undefined);
    assert.deepEqual(input, { agent: "worker", task: "Fix the typo in README.md" });
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.route.outcome, "refused");
    if (record?.recordType === "decision") {
      assert.equal(record.ranOn, HAIKU);
      assert.deepEqual(record.route.tiersTried, ["mechanical", "standard", "elevated", "critical"]);
      assert.deepEqual([...new Set(record.route.removed.map((removed) => removed.reason))], ["unapproved recipient"]);
    }
  } finally { h.cleanup(); }
});

test("a live refusal without a session model reports the missing model without claiming shadow mode", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouterWith(h, {
      classifierCall: () => answering("mechanical").call,
      evidence: () => () => evidenceOf({ authorization: emptyAuthorization() }),
    }, undefined, fakeSessionRegistry([]));
    const input = { agent: "worker", task: "Fix the typo in README.md" };
    const stderr = await stderrOf(async () => { await router.toolCall(input); });
    assert.match(stderr, /pi-orchestrator router disabled: pi supplied no session model for a live refusal/);
    assert.doesNotMatch(stderr, /shadow mode/);
    assert.deepEqual(input, { agent: "worker", task: "Fix the typo in README.md" });
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

/** Every model metered at a price no $5 session allowance can cover. */
function unaffordable(catalog: ModelCatalog): ModelCatalog {
  const price = { inputUsdPerMTok: 1_000_000_000, outputUsdPerMTok: 1_000_000_000 };
  const entries = Object.fromEntries(Object.entries(catalog.entries).map(([model, entry]) => [model, {
    ...entry,
    routeBilling: known("metered" as const, "operator-configured", NOW.toISOString()),
    effectiveBilledCost: known(price, "operator-configured", NOW.toISOString()),
  }]));
  return { ...catalog, entries };
}

test("with the session allowance unable to cover any rung the route refuses on the allowance, the call proceeds unchanged and it is recorded", async () => {
  const h = harness(LIVE);
  try {
    const router = await loadRouter(h, { evidence: () => () => evidenceOf({ catalog: unaffordable(evidenceOf().catalog) }) });
    const input = { agent: "worker", task: "Fix the typo in README.md" };
    assert.equal(await router.toolCall(input), undefined);
    assert.deepEqual(input, { agent: "worker", task: "Fix the typo in README.md" });
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.route.outcome, "refused");
    if (record?.recordType === "decision") {
      assert.deepEqual([...new Set(record.route.removed.map((removed) => removed.reason))], ["allowance preflight"]);
      assert.match(record.route.allowanceApplied, /^task allowance 'router-session:session-27'/);
    }
  } finally { h.cleanup(); }
});

for (const [label, input] of [
  ["a workflowScript call", { workflowScript: "return await runs.run({ agent: 'worker', task: 'Fix the typo in README.md' });" }],
  ["a named workflow", { workflow: "release-notes" }],
  ["a management call", { action: "list" }],
] as const) {
  test(`${label} passes through unchanged and writes nothing`, async () => {
    const h = harness(LIVE);
    try {
      const router = await loadRouter(h);
      const call = structuredClone(input) as Record<string, unknown>;
      assert.equal(await router.toolCall(call), undefined);
      assert.deepEqual(call, input);
      assert.equal(existsSync(h.stateDir), false);
    } finally { h.cleanup(); }
  });
}

// ---------------------------------------------------------------------------
// The real evidence source reads the state folder named at session start
// ---------------------------------------------------------------------------

test("the state folder's approved-recipients store decides whether a rung survives, and nothing is written under the checkout's src/state", async () => {
  const worktreeState = defaultStateDir();
  const before = existsSync(worktreeState) ? readdirSync(worktreeState) : [];
  const h = harness(LIVE);
  try {
    const fakes = { evidence: stateFolderEvidence, classifierCall: () => answering("mechanical").call };
    const withoutStore = await loadRouter(h, fakes);
    const first: Record<string, unknown> = { agent: "worker", task: "Fix the typo in README.md" };
    await withoutStore.toolCall(first, "call-1");
    assert.equal(first.model, undefined, "no store: every rung is an unapproved recipient");

    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approved("anthropic"));
    const withStore = await loadRouter(h, fakes);
    const second: Record<string, unknown> = { agent: "worker", task: "Fix the typo in README.md" };
    await withStore.toolCall(second, "call-2");
    assert.equal(second.model, `${HAIKU}:low`);
    assert.deepEqual(h.records().map((record) => record.delegationId), ["call-1", "call-2"]);
  } finally { h.cleanup(); }
  assert.deepEqual(existsSync(worktreeState) ? readdirSync(worktreeState) : [], before);
});

// ---------------------------------------------------------------------------
// Checkbox 6 (story 42): the router never blocks; refusing is the guard's job.
// The installed entries in a throwaway agent dir are loaded and their
// `tool_call` handlers run the way pi's runner runs them: in load order, and
// the first `{ block: true }` ends the call (extensions/runner.js:852). pi
// loads the extensions directory in `readdirSync` order (loader.js:571),
// which is not guaranteed, so both orders are run.
// ---------------------------------------------------------------------------

async function runInstalledEntries(agentDir: string, order: readonly string[], input: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown> {
  const handlers = new Map<string, Handler[]>();
  const pi = { on(event: string, handler: Handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); } } as unknown as ExtensionAPI;
  assert.deepEqual([...readdirSync(join(agentDir, "extensions"))].sort(), [...order].sort(), "the order names every installed entry");
  for (const name of order) {
    const entry = await import(pathToFileURL(join(agentDir, "extensions", name)).href) as { default: (api: ExtensionAPI) => Promise<void> };
    await entry.default(pi);
  }
  for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ctx);
  let result: unknown;
  for (const handler of handlers.get("tool_call") ?? []) {
    const outcome = await handler({ type: "tool_call", toolCallId: "call-banned", toolName: "subagent", input }, ctx) as { block?: boolean } | undefined;
    if (outcome) {
      result = outcome;
      if (outcome.block) return outcome;
    }
  }
  return result;
}

const BANNED_CASES: ReadonlyArray<readonly [label: string, installGuard: boolean, order: readonly string[]]> = [
  ["with the guard loaded first reaches the guard, which refuses it before the router sees it", true, [GUARD_ENTRY_NAME, ROUTER_ENTRY_NAME]],
  ["with the router loaded first is recorded as explicit and let through by the router, then refused by the guard", true, [ROUTER_ENTRY_NAME, GUARD_ENTRY_NAME]],
  ["with the guard uninstalled is recorded as explicit and let through", false, [ROUTER_ENTRY_NAME]],
];

for (const [label, installGuard, order] of BANNED_CASES) {
  test(`a call naming a banned model ${label}`, async () => {
    const agent = createGuardedAgentDir({ installGuard });
    const stateDir = join(agent.home, "state");
    const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, stateDir: process.env.PI_ORCHESTRATOR_STATE_DIR, offline: process.env.PI_OFFLINE };
    try {
      writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({ orchestrator: { ...OWNER_BAN_LIST_SETTINGS, routing: LIVE } }));
      installRouterEntry(agent.dir);
      process.env.PI_CODING_AGENT_DIR = agent.dir;
      process.env.PI_ORCHESTRATOR_STATE_DIR = stateDir;
      process.env.PI_OFFLINE = "1";
      const ctx: ExtensionContext = { cwd: agent.home, hasUI: false, model: { provider: "anthropic", id: "claude-haiku-4-5" }, modelRegistry: fakeSessionRegistry([]), sessionManager: { getSessionId: () => "session-27" } };
      const input = { agent: "worker", task: "say hello", model: "anthropic/claude-fable-5" };
      const result = await runInstalledEntries(agent.dir, order, input, ctx);
      assert.deepEqual(input, { agent: "worker", task: "say hello", model: "anthropic/claude-fable-5" }, "nobody changed the call");
      const records = readRoutingRecords(join(stateDir, "routing")).map(summary);
      const explicit = [{ recordType: "explicit", delegationId: "call-banned", mode: "live", slot: "model", model: "anthropic/claude-fable-5" }];
      if (installGuard) {
        assert.deepEqual(result, { block: true, reason: "pi-orchestrator guard: prohibited model: anthropic/claude-fable-5" });
        // An explicit record says the router saw the call, not that it ran.
        assert.deepEqual(records, order[0] === ROUTER_ENTRY_NAME ? explicit : []);
      } else {
        assert.equal(result, undefined, "the router does not block");
        assert.deepEqual(records, explicit);
      }
    } finally {
      for (const [name, value] of [["PI_CODING_AGENT_DIR", previous.agentDir], ["PI_ORCHESTRATOR_STATE_DIR", previous.stateDir], ["PI_OFFLINE", previous.offline]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetBanLists();
      agent.cleanup();
    }
  });
}

// ---------------------------------------------------------------------------
// Checkbox 8 (story 44): added latency per call, seam 1. The classifier is a
// fake with a fixed answer, so this is the router's own time (settings are
// read at session start; each call reads evidence, classifies, routes and
// appends a record), without the classifier model call.
// ---------------------------------------------------------------------------

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

test("added latency over ten hook calls in shadow and ten in live mode, with the classifier faked", async () => {
  const lines: string[] = [];
  for (const routing of [SHADOW, LIVE]) {
    const h = harness(routing);
    try {
      const router = await loadRouter(h, { classifierCall: () => answering("standard").call });
      const times: number[] = [];
      for (let call = 0; call < 10; call += 1) {
        const input = { agent: "worker", task: "Add a retry option to the fetch helper in src/fetch.ts" };
        const started = performance.now();
        await router.toolCall(input, `latency-${call}`);
        times.push(performance.now() - started);
      }
      assert.equal(h.records().length, 10);
      lines.push(`${routing.mode}: median ${median(times).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms`);
    } finally { h.cleanup(); }
  }
  // Printed only when asked for, as the router's own probe lines are.
  if (originalEnv.PI_ORCHESTRATOR_ROUTER_PROBE === "1") {
    process.stderr.write(`router hook latency over ten calls, classifier faked (seam 1): ${lines.join("; ")}\n`);
  }
});

test("under PI_ORCHESTRATOR_ROUTER_PROBE=1 the router says it loaded and prints each hook call's wall time", async () => {
  const h = harness(LIVE);
  process.env.PI_ORCHESTRATOR_ROUTER_PROBE = "1";
  try {
    const stderr = await stderrOf(async () => {
      const router = await loadRouter(h);
      await router.toolCall({ agent: "worker", task: "Fix the typo in README.md" });
    });
    const lines = stderr.split("\n").filter((line) => line.length > 0);
    assert.equal(lines[0], "pi-orchestrator router: loaded");
    assert.equal(lines[1], `pi-orchestrator router: routing enabled, mode live, records ${join(h.stateDir, "routing")}`);
    assert.match(lines[2]!, /^pi-orchestrator router: hook \d+\.\d ms for 1 slot\(s\), mode live$/);
    assert.equal(lines.length, 3, stderr);
  } finally {
    delete process.env.PI_ORCHESTRATOR_ROUTER_PROBE;
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The classifier runs inside the session (ADR 0004): with no classifier call
// injected, the router streams through the session's model registry.
// ---------------------------------------------------------------------------

function classifierAnswer(tier: string): string {
  return JSON.stringify({ tier, risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: `session classifier says ${tier}` });
}

async function loadAutoProvider(h: Harness, registry: SessionModelRegistry, deps: Partial<RouterDependencies> = {}): Promise<AutoStream> {
  let provider: ProviderConfigInput | undefined;
  const handlers = new Map<string, Handler>();
  const createIsolatedRouterExtension = await isolatedRouterExtension();
  createIsolatedRouterExtension({ classifierCall: () => answering("mechanical").call, evidence: () => () => evidenceOf(), now: () => NOW, ...deps })({
    registerProvider(name: string, config: ProviderConfigInput) { assert.equal(name, "orchestrator"); provider = config; },
    on(event: string, handler: Handler) { handlers.set(event, handler); },
  } as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
    cwd: h.projectDir, hasUI: false, model: SESSION_MODEL, modelRegistry: registry, thinkingLevel: "medium",
    sessionManager: { getSessionId: () => "parent" },
  });
  assert.equal(provider?.models?.[0]?.id, "auto");
  assert.ok(provider.streamSimple);
  return provider.streamSimple;
}

async function autoEvents(stream: AutoStream, messages: unknown[], sessionId?: string) {
  const events = [];
  for await (const event of stream(AUTO_MODEL, { messages } as unknown as Parameters<AutoStream>[1], { sessionId })) events.push(event);
  return events;
}

test("the main session exports its model and effort at startup", async () => {
  const h = harness(LIVE);
  try {
    delete process.env.PI_ORCHESTRATOR_SESSION_MODEL;
    const registry = fakeSessionRegistry([]);
    await loadAutoProvider(h, registry);
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, `${HAIKU}:medium`);
  } finally { h.cleanup(); }
});

test("model selections update the session model, but auto and delegated sessions cannot replace it", async () => {
  const h = harness(LIVE);
  try {
    const handlers = new Map<string, Handler>();
    createRouterExtension()({ on(event: string, handler: Handler) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
    const ctx = { cwd: h.projectDir, hasUI: false, model: SESSION_MODEL, thinkingLevel: "low" as const, modelRegistry: fakeSessionRegistry([]) };
    const select = handlers.get("model_select");
    assert.ok(select);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:low`;
    await select({ type: "model_select", model: { provider: "anthropic", id: "claude-sonnet-5" }, source: "set" }, { ...ctx, thinkingLevel: "high" });
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-sonnet-5:high");
    await select({ type: "model_select", model: AUTO_MODEL, source: "set" }, ctx);
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-sonnet-5:high");
    const thinkingSelect = handlers.get("thinking_level_select");
    assert.ok(thinkingSelect);
    await thinkingSelect({ type: "thinking_level_select", level: "low", previousLevel: "high" }, { ...ctx, model: { provider: "anthropic", id: "claude-sonnet-5" }, thinkingLevel: "low" });
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-sonnet-5:low");
    await thinkingSelect({ type: "thinking_level_select", level: "medium", previousLevel: "low" }, { ...ctx, model: AUTO_MODEL, thinkingLevel: "medium" });
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-sonnet-5:low");
    process.env.PI_SUBAGENT_CHILD = "1";
    await thinkingSelect({ type: "thinking_level_select", level: "high", previousLevel: "medium" }, { ...ctx, model: { provider: "anthropic", id: "claude-opus-5" }, thinkingLevel: "high" });
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-sonnet-5:low");
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { ...ctx, model: AUTO_MODEL });
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-sonnet-5:low");
  } finally { delete process.env.PI_SUBAGENT_CHILD; h.cleanup(); }
});

test("a refused route runs on the session model with its effort and records ranOn", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("fallback") }]);
    const stream = await loadAutoProvider(h, registry, { evidence: () => () => evidenceOf({ authorization: emptyAuthorization() }) });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    const events = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "refused-worker");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    assert.equal(registry.calls[0]?.options?.reasoning, "high");
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.route.outcome, "refused");
    assert.equal(record?.recordType === "decision" && record.ranOn, "anthropic/claude-sonnet-5:high");
  } finally { h.cleanup(); }
});

test("shadow mode runs on the session model but records the chosen rung", async () => {
  const h = harness(SHADOW);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("shadow") }]);
    const stream = await loadAutoProvider(h, registry);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    assert.equal((await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "shadow-worker")).at(-1)?.type, "done");
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.route.outcome === "chosen" && record.route.rung.rung, `${HAIKU}:low`);
    assert.equal(record?.recordType === "decision" && record.handPickedModel, "anthropic/claude-sonnet-5");
    assert.equal(record?.recordType === "decision" && record.ranOn, "anthropic/claude-sonnet-5:high");
  } finally { h.cleanup(); }
});

test("when routing is not enabled the auto model runs on the session model without a record", async () => {
  const h = harness({ ...LIVE, enabled: false });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("unrouted") }]);
    const stream = await loadAutoProvider(h, registry);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:medium";
    assert.equal((await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "off-worker")).at(-1)?.type, "done");
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    assert.equal(registry.calls[0]?.options?.reasoning, "medium");
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("the auto model fails with a reason and forwards nothing when the session model is missing or banned", async () => {
  const h = harness(LIVE, { subagentBanList: ["sonnet"] });
  try {
    const registry = fakeSessionRegistry([]);
    const stream = await loadAutoProvider(h, registry, { evidence: () => () => evidenceOf({ authorization: emptyAuthorization() }) });
    delete process.env.PI_ORCHESTRATOR_SESSION_MODEL;
    const missing = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "missing-worker");
    assert.equal(missing.at(-1)?.type, "error");
    const missingFinal = missing.at(-1);
    if (missingFinal?.type === "error") assert.match(missingFinal.error.errorMessage ?? "", /PI_ORCHESTRATOR_SESSION_MODEL.*missing/);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    const banned = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "banned-worker");
    assert.equal(banned.at(-1)?.type, "error");
    const bannedFinal = banned.at(-1);
    if (bannedFinal?.type === "error") assert.match(bannedFinal.error.errorMessage ?? "", /subagent ban list.*sonnet/);
    assert.equal(registry.calls.length, 0);
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("an internal routing failure disables routing once and later workers still run on the session model", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("first") }, { events: answerEvents("second") }]);
    const stream = await loadAutoProvider(h, registry, { evidence: () => () => { throw new Error("evidence exploded"); } });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    const stderr = await stderrOf(async () => {
      for (const id of ["failed-one", "failed-two"]) {
        const events = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], id);
        assert.equal(events.at(-1)?.type, "done");
      }
    });
    assert.deepEqual(stderr.split("\n").filter(Boolean), ["pi-orchestrator router disabled: evidence exploded"]);
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-sonnet-5", "high"], ["claude-sonnet-5", "high"]]);
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("provider, startup and hook failures across extension instances print one disabled line per process", async () => {
  const first = harness(LIVE);
  const second = harness({ ...LIVE, classifier: { model: "anthropic/unknown:low" } });
  const third = harness(LIVE);
  try {
    startFreshProcess();
    const setup = async (h: Harness, failure: "provider" | "startup" | "hook") => {
      // pi gives every load its own module copy; the line is still once per process.
      const { createRouterExtension: fresh } = await import(`./extension.ts?disable-process-${failure}-${++isolatedModule}`);
      process.env.PI_CODING_AGENT_DIR = h.agentDir;
      process.env.PI_ORCHESTRATOR_STATE_DIR = h.stateDir;
      const handlers = new Map<string, Handler>();
      let provider: ProviderConfigInput | undefined;
      fresh({ classifierCall: () => answering("mechanical").call,
        evidence: () => () => { if (failure !== "startup") throw new Error(`${failure} evidence exploded`); return evidenceOf(); }, now: () => NOW })({
        on(event: string, handler: Handler) { handlers.set(event, handler); },
        registerProvider(_name: string, config: ProviderConfigInput) { provider = config; },
      } as unknown as ExtensionAPI);
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
        cwd: h.projectDir, hasUI: false, model: SESSION_MODEL, thinkingLevel: "medium", modelRegistry: fakeSessionRegistry([{ events: answerEvents("ok") }]),
        sessionManager: { getSessionId: () => "parent" },
      });
      return { stream: provider?.streamSimple, toolCall: handlers.get("tool_call") };
    };
    const stderr = await stderrOf(async () => {
      const provider = await setup(first, "provider");
      assert.ok(provider.stream);
      assert.equal((await autoEvents(provider.stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "provider-failure")).at(-1)?.type, "done");
      await setup(second, "startup");
      const hook = await setup(third, "hook");
      await hook.toolCall?.({ type: "tool_call", toolName: "subagent", toolCallId: "hook-failure", input: { agent: "worker", task: "Fix README.md" } }, {
        cwd: third.projectDir, hasUI: false, model: SESSION_MODEL,
      });
    });
    assert.deepEqual(stderr.split("\n").filter(Boolean), ["pi-orchestrator router disabled: provider evidence exploded"]);
  } finally { first.cleanup(); second.cleanup(); third.cleanup(); }
});

test("a startup routing failure still forwards the auto model to the session model", async () => {
  const h = harness({ ...LIVE, classifier: { model: "anthropic/unknown:low" } });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("startup fallback") }]);
    let stream!: AutoStream;
    const stderr = await stderrOf(async () => {
      stream = await loadAutoProvider(h, registry);
      const events = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "startup-failed-worker");
      assert.equal(events.at(-1)?.type, "done");
    });
    assert.match(stderr, /pi-orchestrator router disabled: classifier rung/);
    assert.equal(registry.calls[0]?.model.id, "claude-haiku-4-5");
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("the auto model reads the agent role from system prompt sections and text parts", async () => {
  const h = harness(LIVE);
  try {
    const classifier = answering("mechanical");
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), { classifierCall: () => classifier.call });
    await autoEvents(stream, [
      { role: "system", content: [{ type: "text", text: "ordinary prompt" }], sections: { preamble: "instructions", addendum: '<active_agent name="reviewer"/>' }, timestamp: 0 },
      { role: "user", content: "Review README.md", timestamp: 0 },
    ], "sections-worker");
    assert.match(classifier.prompts[0]!, /Agent role: reviewer/);
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.agentRole, "reviewer");
  } finally { h.cleanup(); }
});

test("the auto model reads the agent role from system text parts", async () => {
  const h = harness(LIVE);
  try {
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]));
    await autoEvents(stream, [
      { role: "system", content: [{ type: "text", text: '<active_agent name="worker"/>' }], timestamp: 0 },
      { role: "user", content: "Fix README.md", timestamp: 0 },
    ], "text-parts-worker");
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.agentRole, "worker");
  } finally { h.cleanup(); }
});

test("the auto model sends no reasoning option for an off rung", async () => {
  const h = harness({ ...LIVE, tiers: { ...TEST_TIERS, mechanical: [`${HAIKU}:off`] } });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry);
    await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "off-worker");
    assert.equal(Object.hasOwn(registry.calls[0]?.options ?? {}, "reasoning"), false);
  } finally { h.cleanup(); }
});

test("the auto model clamps the rung's effort to the current model's supported levels", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const currentRegistry: SessionModelRegistry = { ...registry, find(provider, id) {
      const model = registry.find(provider, id);
      return model?.id === "claude-haiku-4-5" ? { ...model, reasoning: false } : model;
    } };
    const stream = await loadAutoProvider(h, currentRegistry);
    await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "clamped-worker");
    assert.equal(Object.hasOwn(registry.calls[0]?.options ?? {}, "reasoning"), false);
  } finally { h.cleanup(); }
});

async function autoScenario(h: Harness) {
  const classifier = answering("mechanical");
  const real = { provider: "anthropic", model: "claude-haiku-4-5", api: "anthropic-messages" };
  const usage = { input: 12, output: 8, cacheRead: 1, cacheWrite: 0, totalTokens: 21, cost: { total: 0.007 } };
  const registry = fakeSessionRegistry([
    { events: [{ type: "start", partial: assistantMessage({ ...real, usage }) } as never, ...answerEvents("hello", { ...real, usage }).slice(1)] },
    { events: errorEvents("rung failed") },
  ], INSTALLED_MODEL_INFO.map((entry) => ({ ...entry, api: "anthropic-messages" })));
  const stream = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
  const previous = { ...assistantMessage({ content: [{ type: "thinking", thinking: "old" }] }), ...AUTO_MODEL, model: "auto" };
  const context = [{ role: "system", content: '<active_agent name="worker"/>', timestamp: 0 },
    { role: "user", content: "Fix README.md", timestamp: 0 }];
  const signal = new AbortController().signal;
  const onPayload = () => {};
  const onResponse = () => {};
  const options = { sessionId: "worker-1", apiKey: "wrong", headers: { Authorization: "wrong" }, reasoning: "high" as const, signal, onPayload, onResponse };
  const first = [];
  for await (const event of stream(AUTO_MODEL, { messages: context } as unknown as Parameters<AutoStream>[1], options)) first.push(event);
  const second = [];
  for await (const event of stream(AUTO_MODEL, { messages: [...context, previous] } as unknown as Parameters<AutoStream>[1], options)) second.push(event);
  return { classifier, real, usage, registry, previous, signal, onPayload, onResponse, options, first, second };
}

test("a worker on the auto model forwards with the rung's effort and credentials", async () => {
  const h = harness(LIVE);
  try {
    const { registry, signal, onPayload, onResponse, options } = await autoScenario(h);
    assert.equal(registry.calls[0]?.model.provider, "anthropic");
    assert.equal(registry.calls[0]?.model.id, "claude-haiku-4-5");
    assert.equal(registry.calls[0]?.options?.reasoning, "low");
    assert.equal(registry.calls[0]?.options?.signal, signal);
    assert.equal((registry.calls[0]?.options as typeof options).onPayload, onPayload);
    assert.equal((registry.calls[0]?.options as typeof options).onResponse, onResponse);
    assert.equal("apiKey" in (registry.calls[0]?.options ?? {}), false);
    assert.equal("headers" in (registry.calls[0]?.options ?? {}), false);
  } finally { h.cleanup(); }
});

test("later requests keep the session pin without classifying again", async () => {
  const h = harness(LIVE);
  try {
    const { classifier, registry } = await autoScenario(h);
    assert.equal(classifier.prompts.length, 1);
    assert.match(classifier.prompts[0]!, /Agent role: worker/);
    assert.equal(registry.calls.length, 2);
    assert.deepEqual(registry.calls.map((call) => call.model.id), ["claude-haiku-4-5", "claude-haiku-4-5"]);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("auto model relabels earlier replies inward and streamed replies outward without losing usage", async () => {
  const h = harness(LIVE);
  try {
    const { real, usage, registry, previous, first, second } = await autoScenario(h);
    assert.deepEqual(registry.calls[1]?.context.messages[2], { ...previous, ...real });
    assert.deepEqual((first[0] as { partial?: unknown }).partial, { ...assistantMessage({ ...real, usage }), provider: "orchestrator", model: "auto", api: "orchestrator-auto" });
    assert.deepEqual(first.at(-1), { type: "done", reason: "stop", message: { ...assistantMessage({ ...real, usage, content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "hello" }] }), provider: "orchestrator", model: "auto", api: "orchestrator-auto" } });
    assert.deepEqual(second.at(-1), { type: "error", reason: "error", error: { ...assistantMessage({ stopReason: "error", errorMessage: "rung failed" }), provider: "orchestrator", model: "auto", api: "orchestrator-auto" } });
  } finally { h.cleanup(); }
});

test("the classified session has one decision-record/3 with ranOn equal to its rung", async () => {
  const h = harness(LIVE);
  try {
    await autoScenario(h);
    const [record] = h.records();
    assert.equal(h.records().length, 1);
    assert.equal(record?.recordType, "decision");
    assert.equal(record.schemaVersion, "decision-record/3");
    assert.equal(record.delegationId, "worker-1");
    assert.equal(record.recordType === "decision" && record.ranOn, `${HAIKU}:low`);
  } finally { h.cleanup(); }
});

test("a registry exception is returned as an error labelled orchestrator/auto", async () => {
  const h = harness(LIVE);
  try {
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ throws: "rung connection lost" }]));
    const events = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "throwing-worker");
    const last = events.at(-1);
    assert.equal(last?.type, "error");
    if (last?.type === "error") {
      assert.equal(last.error.errorMessage, "rung connection lost");
      assert.deepEqual([last.error.provider, last.error.model, last.error.api], ["orchestrator", "auto", "orchestrator-auto"]);
    }
  } finally { h.cleanup(); }
});

test("an auto model request without a session id returns a clear labelled error", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([]);
    const stream = await loadAutoProvider(h, registry);
    const events = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }]);
    const last = events.at(-1);
    assert.equal(last?.type, "error");
    if (last?.type === "error") {
      assert.match(last.error.errorMessage ?? "", /no sessionId/);
      assert.deepEqual([last.error.provider, last.error.model, last.error.api], ["orchestrator", "auto", "orchestrator-auto"]);
    }
    assert.equal(registry.calls.length, 0);
    assert.equal(h.records().length, 0);
  } finally { h.cleanup(); }
});

test("an inner stream without a final event returns a labelled error and settles result", async () => {
  const h = harness(LIVE);
  try {
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ events: [{ type: "start" }] }]));
    const request = stream(AUTO_MODEL, { messages: [{ role: "user", content: "Fix README.md", timestamp: 0 }] } as unknown as Parameters<AutoStream>[1], { sessionId: "unfinished-worker" });
    const events = [];
    for await (const event of request) events.push(event);
    const final = await request.result();
    assert.equal(events.at(-1)?.type, "error");
    assert.match(final.errorMessage ?? "", /without a final message/);
    assert.deepEqual([final.provider, final.model, final.api], ["orchestrator", "auto", "orchestrator-auto"]);
  } finally { h.cleanup(); }
});

test("the auto model declares the largest context window and output limit among the tier map's rungs", async () => {
  const h = harness(LIVE);
  try {
    const limits: Record<string, { contextWindow: number; maxTokens: number }> = {
      "anthropic/claude-haiku-4-5": { contextWindow: 200_000, maxTokens: 64_000 },
      "anthropic/claude-sonnet-5": { contextWindow: 1_000_000, maxTokens: 64_000 },
      "anthropic/claude-opus-5": { contextWindow: 200_000, maxTokens: 128_000 },
      "openai-codex/gpt-6-sol": { contextWindow: 400_000, maxTokens: 100_000 },
      // Not a rung of the tier map: its larger limits must not count.
      "anthropic/claude-fable-5": { contextWindow: 2_000_000, maxTokens: 256_000 },
    };
    const registry = fakeSessionRegistry([], INSTALLED_MODEL_INFO.map((entry) => ({ ...entry, ...limits[entry.fullId] })));
    const registered: ProviderConfigInput[] = [];
    const handlers = new Map<string, Handler>();
    createRouterExtension({ classifierCall: () => answering("mechanical").call, evidence: () => () => evidenceOf(), now: () => NOW })({
      registerProvider(name: string, config: ProviderConfigInput) { assert.equal(name, "orchestrator"); registered.push(config); },
      on(event: string, handler: Handler) { handlers.set(event, handler); },
    } as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
      cwd: h.projectDir, hasUI: false, model: SESSION_MODEL, modelRegistry: registry, sessionManager: { getSessionId: () => "parent" },
    });
    const [auto] = registered.at(-1)?.models ?? [];
    assert.equal(auto?.id, "auto");
    assert.deepEqual([auto?.contextWindow, auto?.maxTokens], [1_000_000, 128_000]);
  } finally { h.cleanup(); }
});

test("an overflow error from the rung comes back labelled orchestrator/auto with its message unchanged, and the retry stays on the rung", async () => {
  const h = harness(LIVE);
  try {
    // pi compacts and retries only when the error matches pi-ai's overflow
    // patterns (isContextOverflow, pi-ai 0.87.1 dist/utils/overflow.js) and
    // the reply's provider and model equal the session model's
    // (AgentSession._checkCompaction, pi-coding-agent 0.87.1). This is
    // Anthropic's overflow message as pi-ai documents it.
    const overflow = "prompt is too long: 213462 tokens > 200000 maximum";
    const real = { provider: "anthropic", model: "claude-haiku-4-5", api: "anthropic-messages" };
    const classifier = answering("mechanical");
    const registry = fakeSessionRegistry([
      { events: [{ type: "error", reason: "error", error: assistantMessage({ ...real, stopReason: "error", errorMessage: overflow }) } as never] },
      { events: answerEvents("done after compaction") },
    ]);
    const stream = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
    const failed = await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "long-worker");
    assert.deepEqual(failed.at(-1), { type: "error", reason: "error", error: { ...assistantMessage({ stopReason: "error", errorMessage: overflow }), provider: "orchestrator", model: "auto", api: "orchestrator-auto" } });
    await autoEvents(stream, [{ role: "user", content: "Fix README.md after compaction", timestamp: 0 }], "long-worker");
    assert.deepEqual(registry.calls.map((call) => `${call.model.provider}/${call.model.id}:${call.options?.reasoning}`), [`${HAIKU}:low`, `${HAIKU}:low`]);
    assert.equal(classifier.prompts.length, 1);
  } finally { h.cleanup(); }
});

test("a compaction summary request with a new session id is classified and recorded as a first request", async () => {
  const h = harness(LIVE);
  try {
    const classifier = answering("mechanical");
    const registry = fakeSessionRegistry([{ events: answerEvents("working") }, { events: answerEvents("## Goal") }]);
    const stream = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
    await autoEvents(stream, [
      { role: "system", content: '<active_agent name="worker"/>', timestamp: 0 },
      { role: "user", content: "Fix README.md", timestamp: 0 },
    ], "worker-before-compaction");
    // The request pi's compaction sends (generateSummaryWithRequest, pi-coding-agent
    // 0.87.1): its own system prompt and one user message wrapping the conversation.
    const summaryPrompt = "<conversation>\n[User]: Fix README.md\n[Assistant]: working\n</conversation>\n\n"
      + "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.";
    const request = stream(AUTO_MODEL, {
      systemPrompt: "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.",
      messages: [{ role: "user", content: [{ type: "text", text: summaryPrompt }], timestamp: 0 }],
    } as unknown as Parameters<AutoStream>[1], { sessionId: "compaction-summary" });
    for await (const _event of request) { /* consume */ }
    assert.equal((await request.result()).stopReason, "stop");
    assert.equal(classifier.prompts.length, 2);
    assert.match(classifier.prompts[1]!, /conversation to summarize/);
    const records = h.records();
    assert.deepEqual(records.map((record) => record.delegationId), ["worker-before-compaction", "compaction-summary"]);
    const summary = records[1];
    assert.equal(summary?.recordType, "decision");
    if (summary?.recordType === "decision") {
      assert.equal(summary.agentRole, "unknown");
      assert.ok(summaryPrompt.startsWith(summary.taskTextPrefix));
      assert.equal(summary.ranOn, `${HAIKU}:low`);
    }
  } finally { h.cleanup(); }
});

test("the auto model probe reports the rung, pin and time for each request", async () => {
  const h = harness(LIVE);
  process.env.PI_ORCHESTRATOR_ROUTER_PROBE = "1";
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("first") }, { events: answerEvents("second") }]);
    let provider: ProviderConfigInput | undefined;
    const handlers = new Map<string, Handler>();
    const lines = await stderrOf(async () => {
      createRouterExtension({ classifierCall: () => answering("mechanical").call, evidence: () => () => evidenceOf(), now: () => NOW })({
        registerProvider(_name: string, config: ProviderConfigInput) { provider = config; },
        on(event: string, handler: Handler) { handlers.set(event, handler); },
      } as unknown as ExtensionAPI);
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
        cwd: h.projectDir, hasUI: false, model: SESSION_MODEL, modelRegistry: registry,
        sessionManager: { getSessionId: () => "parent" },
      });
      const stream = provider?.streamSimple;
      assert.ok(stream);
      const model = { provider: "orchestrator", id: "auto", api: "orchestrator-auto" } as Parameters<typeof stream>[0];
      const context = { messages: [{ role: "user", content: "Fix README.md", timestamp: 0 }] } as unknown as Parameters<typeof stream>[1];
      for (let i = 0; i < 2; i++) for await (const _event of stream(model, context, { sessionId: "worker-probe" })) { /* consume */ }
    });
    const probes = lines.split("\n").filter((line) => line.includes("request worker-probe"));
    assert.equal(probes.length, 2, lines);
    assert.match(probes[0]!, /rung anthropic\/claude-haiku-4-5:low, pin new, \d+\.\d ms$/);
    assert.match(probes[1]!, /rung anthropic\/claude-haiku-4-5:low, pin reused, \d+\.\d ms$/);
  } finally { delete process.env.PI_ORCHESTRATOR_ROUTER_PROBE; h.cleanup(); }
});

test("by default the router classifies through the session's model registry, not a pi child, and writes the chosen rung", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents(classifierAnswer("mechanical")) }]);
    const stderr = await stderrOf(async () => {
      const router = await loadRouterWith(h, {}, SESSION_MODEL, registry);
      const input: Record<string, unknown> = { agent: "worker", task: "Fix the typo in README.md" };
      assert.equal(await router.toolCall(input), undefined);
      assert.equal(input.model, `${HAIKU}:low`);
    });
    assert.doesNotMatch(stderr, /pi-orchestrator router disabled/, stderr);
    assert.equal(registry.calls.length, 1, "one classifier request through the session registry");
    assert.deepEqual(registry.calls[0]?.context.messages.length, 1);
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.classification.cause, `model:${HAIKU}:low`);
    assert.deepEqual(record?.recordType === "decision" && record.classification.hops.map((hop) => [hop.hop, hop.outcome, hop.allowance?.settlement]), [[`${HAIKU}:low`, "decided", "settled"]]);
  } finally { h.cleanup(); }
});

test("a failing in-session classifier request is a recorded hop failure: the router stays enabled and the call is routed on keywords", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([
      { events: errorEvents("You're out of extra usage.") },
      { events: answerEvents(classifierAnswer("mechanical")) },
    ]);
    const stderr = await stderrOf(async () => {
      const router = await loadRouterWith(h, {}, SESSION_MODEL, registry);
      assert.equal(await router.toolCall({ agent: "worker", task: "Fix the typo in README.md" }, "call-1"), undefined);
      assert.equal(await router.toolCall({ agent: "worker", task: "Fix the typo in README.md" }, "call-2"), undefined);
    });
    assert.doesNotMatch(stderr, /pi-orchestrator router disabled/, stderr);
    const [first, second] = h.records();
    assert.deepEqual(first?.recordType === "decision" && first.classification.hops.map((hop) => [hop.hop, hop.outcome]), [[`${HAIKU}:low`, "out-of-usage"], ["keywords", "decided"]]);
    assert.equal(first?.recordType === "decision" && first.classification.cause, "keywords");
    assert.equal(second?.recordType === "decision" && second.classification.cause, `model:${HAIKU}:low`, "the next call still classifies in the session");
  } finally { h.cleanup(); }
});

test("under PI_ORCHESTRATOR_ROUTER_PROBE=1 the in-session classifier prints its time to first token, total time, tokens and reported cost", async () => {
  const h = harness(LIVE);
  process.env.PI_ORCHESTRATOR_ROUTER_PROBE = "1";
  try {
    const usage = { input: 900, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 980, cost: { total: 0.0012 } };
    const registry = fakeSessionRegistry([{ events: answerEvents(classifierAnswer("mechanical"), { usage }) }, { events: errorEvents("socket hang up") }]);
    const stderr = await stderrOf(async () => {
      const router = await loadRouterWith(h, {}, SESSION_MODEL, registry);
      await router.toolCall({ agent: "worker", task: "Fix the typo in README.md" }, "call-1");
      await router.toolCall({ agent: "worker", task: "Fix the typo in README.md" }, "call-2");
    });
    const classifierLines = stderr.split("\n").filter((line) => line.startsWith("pi-orchestrator router: classifier "));
    assert.equal(classifierLines.length, 2, stderr);
    assert.match(
      classifierLines[0]!,
      /^pi-orchestrator router: classifier anthropic\/claude-haiku-4-5:low first token \d+\.\d ms, total \d+\.\d ms, tokens 980, reported cost \$0\.00120$/,
    );
    assert.match(classifierLines[1]!, /^pi-orchestrator router: classifier anthropic\/claude-haiku-4-5:low failed after \d+\.\d ms: pi classifier call ended with error: socket hang up$/);
  } finally {
    delete process.env.PI_ORCHESTRATOR_ROUTER_PROBE;
    h.cleanup();
  }
});
