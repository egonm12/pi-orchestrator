import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { stateFolderEvidence } from "./evidence.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, type RecipientAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, writeDecisionRecord, type RoutingRecord } from "../routing/decision-record.ts";
import { fixtureClassification, fixtureRoute, fixtureTierMap } from "../fixtures/routing-decision.ts";
import { answerEvents, errorEvents, fakeSessionRegistry, assistantMessage } from "../fixtures/session-model-registry.ts";
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext as ExtensionContext } from "../fixtures/extension-context.ts";
import type { SessionModelRegistry } from "../routing/model-stream.ts";
import { createRouterExtension, type RouterDependencies, type RoutingEvidence } from "./extension.ts";
import { setRoutingConstraints } from "./auto-provider.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

type ProviderConfigInput = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>;
type AutoStream = NonNullable<ProviderConfigInput["streamSimple"]>;
const AUTO_MODEL = { provider: "orchestrator", id: "auto", api: "orchestrator-auto" } as Parameters<AutoStream>[0];

useOwnerBanLists();

// Seam 1 (ADR 0006, "Testing decisions"): the router extension as pi loads it.
// A fake ExtensionAPI records the registered provider and the event handlers;
// a test calls the provider's `streamSimple` with a worker's request, as pi
// does. The fakes sit at the system boundaries only: the session model
// registry, the classifier model call, the evidence source (catalog, ticket 08
// refresh state, approved recipients), the clock, settings files in a
// throwaway agent dir and project dir, and the environment. Assertions read
// what pi or the owner can observe: the returned events, the request forwarded
// to the rung, the records in the state folder and printed lines.

const originalEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_ORCHESTRATOR_STATE_DIR: process.env.PI_ORCHESTRATOR_STATE_DIR,
  PI_ORCHESTRATOR_ROUTER_PROBE: process.env.PI_ORCHESTRATOR_ROUTER_PROBE,
  PI_ORCHESTRATOR_SESSION_MODEL: process.env.PI_ORCHESTRATOR_SESSION_MODEL,
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  PI_SUBAGENTS_HERDR_BRIDGE: process.env.PI_SUBAGENTS_HERDR_BRIDGE,
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
  // A throwaway home keeps the owner's files out of the test.
  process.env.HOME = home;
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

/** The handlers a fake ExtensionAPI collects, run the way pi's runner runs
 *  them (extensions/runner.js emit): every handler for the event, in
 *  registration order. `get` returns undefined when none is registered. */
function piHandlers() {
  const lists = new Map<string, Handler[]>();
  return {
    on(event: string, handler: Handler) { lists.set(event, [...(lists.get(event) ?? []), handler]); },
    get(event: string): Handler | undefined {
      const handlers = lists.get(event);
      if (handlers === undefined) return undefined;
      return async (payload, ctx) => {
        let result: unknown;
        for (const handler of handlers) result = await handler(payload, ctx) ?? result;
        return result;
      };
    },
  };
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

/** Everything written to stderr while `run` runs. */
async function stderrOf(run: () => Promise<unknown>): Promise<string> {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stderr.write;
  try { await run(); } finally { process.stderr.write = original; }
  // Fresh-install guidance has its own router extension test.
  output = output.split("\n").filter((line) => !line.startsWith("pi-orchestrator: not set up:") && !line.startsWith("pi-orchestrator: make orchestrator/auto")).join("\n");
  return output;
}

const CLASSIFIER = { model: `${HAIKU}:low`, timeoutMs: 1_000 };
const LIVE = { enabled: true, mode: "live", classifier: CLASSIFIER, tiers: TEST_TIERS };
const SHADOW = { enabled: true, mode: "shadow", classifier: CLASSIFIER, tiers: TEST_TIERS };


function classifierAnswer(tier: string): string {
  return JSON.stringify({ tier, risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: `session classifier says ${tier}` });
}

async function loadAutoProvider(h: Harness, registry: SessionModelRegistry, deps: Partial<RouterDependencies> = {},
  session: { readonly cwd?: string } = {}): Promise<AutoStream> {
  return loadAutoProviderWith(h, registry, { classifierCall: () => answering("mechanical").call, ...deps }, session);
}

/** The router extension as pi loads it, with the classifier call it would use
 *  in pi unless `deps` replaces it: the in-session call over the registry. */
async function loadAutoProviderWith(h: Harness, registry: SessionModelRegistry, deps: Partial<RouterDependencies>,
  session: { readonly cwd?: string } = {}): Promise<AutoStream> {
  let provider: ProviderConfigInput | undefined;
  const handlers = piHandlers();
  const createIsolatedRouterExtension = await isolatedRouterExtension();
  createIsolatedRouterExtension({ evidence: () => () => evidenceOf(), now: () => NOW, ...deps })({
    registerProvider(name: string, config: ProviderConfigInput) { assert.equal(name, "orchestrator"); provider = config; },
    on(event: string, handler: Handler) { handlers.on(event, handler); },
  } as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
    cwd: session.cwd ?? h.projectDir, hasUI: false, model: SESSION_MODEL, modelRegistry: registry, thinkingLevel: "medium",
    sessionManager: { getSessionId: () => "parent" },
  });
  assert.equal(provider?.models?.[0]?.id, "auto");
  assert.ok(provider.streamSimple);
  return provider.streamSimple;
}

async function autoEvents(stream: AutoStream, messages: unknown[], sessionId?: string, options: Partial<Parameters<AutoStream>[2]> = {}) {
  const events = [];
  for await (const event of stream(AUTO_MODEL, { messages } as unknown as Parameters<AutoStream>[1], { ...options, sessionId })) events.push(event);
  return events;
}

const FIX_README = [{ role: "user", content: "Fix the typo in README.md", timestamp: 0 }];

// context-mode's pi adapter appends this as a plain user message through the
// `context` hook, after the delegated prompt and before the first reply.
const CONTEXT_MODE_ANCHOR = "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search. " +
  "Stats → ctx_stats. Doctor → ctx_doctor. Upgrade → ctx_upgrade. Purge → ctx_purge.";

test("text another extension appends after the delegated prompt sets no keyword floor", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry);
    await autoEvents(stream, [...FIX_README, { role: "user", content: CONTEXT_MODE_ANCHOR }], "injected-worker");
    const [record] = h.records();
    assert.ok(record?.recordType === "decision");
    assert.deepEqual(record.classification.floorSignals, []);
    assert.equal(record.classification.tier, "mechanical");
    assert.equal(record.ranOn, `${HAIKU}:low`);
  } finally { h.cleanup(); }
});

test("the router extension's fresh-install notice names what is missing", async () => {
  const h = harness(undefined);
  try {
    const notices: string[] = [];
    const handlers = piHandlers();
    createRouterExtension()({
      registerProvider() {},
      on(event: string, handler: Handler) { handlers.on(event, handler); },
    } as unknown as ExtensionAPI);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
      cwd: h.projectDir, hasUI: true, model: SESSION_MODEL, thinkingLevel: "medium",
      ui: { notify: (message: string) => { notices.push(message); } },
    } as ExtensionContext);
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /no tier map/);
    assert.match(notices[0]!, /\/pi-orchestrator init/);
  } finally { h.cleanup(); }
});

for (const marker of ["PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"]) {
  test(`the fresh-install notice is not shown in a child process (${marker}=1)`, async () => {
    const h = harness(undefined);
    process.env[marker] = "1";
    try {
      const notices: string[] = [];
      const handlers = piHandlers();
      createRouterExtension()({
        registerProvider() {},
        on(event: string, handler: Handler) { handlers.on(event, handler); },
      } as unknown as ExtensionAPI);
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
        cwd: h.projectDir, hasUI: true, model: SESSION_MODEL, thinkingLevel: "medium",
        ui: { notify: (message: string) => { notices.push(message); } },
      } as ExtensionContext);
      assert.deepEqual(notices, []);
    } finally { delete process.env[marker]; h.cleanup(); }
  });
}

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

/** The `/pi-orchestrator` command the router extension registers. */
function orchestratorCommand(): Command {
  const commands = new Map<string, Command>();
  createRouterExtension()({
    registerProvider() {},
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    on() {},
  } as unknown as ExtensionAPI);
  const command = commands.get("pi-orchestrator");
  assert.ok(command, JSON.stringify([...commands.keys()]));
  return command;
}

/** Runs `/pi-orchestrator <args>` and returns what it printed to stderr. */
async function runWithoutUI(command: Command, args: string): Promise<string> {
  let written = "";
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written += chunk; return true; }) as typeof process.stderr.write;
  try { await command.handler(args, { hasUI: false } as never); } finally { process.stderr.write = write; }
  return written;
}

test("/pi-orchestrator dispatches init and prints the usage for an unknown subcommand", async () => {
  const h = harness(undefined);
  try {
    const command = orchestratorCommand();
    assert.match(command.description ?? "", /^pi-orchestrator: init \(/);
    const notices: { message: string; type?: string }[] = [];
    await command.handler("frobnicate", { hasUI: true, ui: { notify: (message: string, type?: string) => { notices.push({ message, type }); } } } as never);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.type, "warning");
    assert.match(notices[0]!.message, /^pi-orchestrator: unknown subcommand 'frobnicate'\.\nusage: \/pi-orchestrator <subcommand>\n {2}init: /);
    assert.equal(await runWithoutUI(command, "init"), "pi-orchestrator: /pi-orchestrator init asks for approvals and needs an interactive session; nothing was written.\n");
    assert.equal(await runWithoutUI(command, "init extra"), "usage: /pi-orchestrator init\n", "init keeps refusing extra arguments");
    assert.equal(readFileSync(join(h.agentDir, "settings.json"), "utf8"), JSON.stringify({ orchestrator: {} }), "personal settings are unchanged");
    assert.equal(existsSync(h.stateDir), false, "nothing was written");
  } finally { h.cleanup(); }
});

test("the router extension registers no tool_call handler", async () => {
  const h = harness(LIVE);
  try {
    const events: string[] = [];
    const createIsolatedRouterExtension = await isolatedRouterExtension();
    createIsolatedRouterExtension({ classifierCall: () => answering("mechanical").call, evidence: () => () => evidenceOf(), now: () => NOW })({
      registerProvider() {},
      on(event: string) { events.push(event); },
    } as unknown as ExtensionAPI);
    assert.ok(events.includes("session_start"), JSON.stringify(events));
    assert.equal(events.includes("tool_call"), false, JSON.stringify(events));
  } finally { h.cleanup(); }
});

test("the classifier sees the worker's task, its agent role and the file paths the task text names", async () => {
  const h = harness(SHADOW);
  try {
    const classifier = answering("mechanical");
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), { classifierCall: () => classifier.call });
    await autoEvents(stream, [
      { role: "system", content: '<active_agent name="worker"/>', timestamp: 0 },
      { role: "user", content: "Fix `src/math.ts` and README.md, e.g. the add() typo; see https://example.com/issues/3 and (docs/specs/auto-routing.md).", timestamp: 0 },
    ], "paths-worker");
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
      const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
      const stream = await loadAutoProvider(h, registry, { evidence: () => () => evidenceOf(overrides) });
      await autoEvents(stream, FIX_README, "usage-worker");
      assert.equal(`${registry.calls[0]?.model.provider}/${registry.calls[0]?.model.id}:${registry.calls[0]?.options?.reasoning}`, rung);
      const [record] = h.records();
      assert.equal(record?.recordType === "decision" && record.ranOn, rung);
      if (record?.recordType === "decision") assert.deepEqual(record.route.removed.map((removed) => removed.reason), reasons);
    } finally { h.cleanup(); }
  });
}

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

test("with the session allowance unable to cover any rung the route refuses on the allowance, the worker runs on the session model and it is recorded", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry, { evidence: () => () => evidenceOf({ catalog: unaffordable(evidenceOf().catalog) }) });
    assert.equal((await autoEvents(stream, FIX_README, "unaffordable-worker")).at(-1)?.type, "done");
    assert.equal(registry.calls[0]?.options?.reasoning, "medium", "the session model's effort");
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.route.outcome, "refused");
    if (record?.recordType === "decision") {
      assert.equal(record.ranOn, `${HAIKU}:medium`);
      assert.deepEqual([...new Set(record.route.removed.map((removed) => removed.reason))], ["allowance preflight"]);
      assert.match(record.route.allowanceApplied, /^task allowance 'router-session:parent'/);
    }
  } finally { h.cleanup(); }
});

test("an unwritable record folder disables routing with one line and the worker runs on the session model", async () => {
  const h = harness(LIVE);
  try {
    mkdirSync(h.stateDir);
    writeFileSync(join(h.stateDir, "routing"), "a file where the record folder should be\n");
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stderr = await stderrOf(async () => {
      const stream = await loadAutoProvider(h, registry);
      assert.equal((await autoEvents(stream, FIX_README, "unrecorded-worker")).at(-1)?.type, "done");
    });
    const lines = stderr.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, stderr);
    assert.match(lines[0]!, /^pi-orchestrator router disabled: .*(EEXIST|ENOTDIR)/);
    assert.equal(registry.calls[0]?.options?.reasoning, "medium", "the session model's effort");
  } finally { h.cleanup(); }
});

test("the state folder's approved-recipients store decides whether a rung survives, and nothing is written under the checkout's src/state", async () => {
  const worktreeState = defaultStateDir();
  const before = existsSync(worktreeState) ? readdirSync(worktreeState) : [];
  const h = harness(LIVE);
  try {
    const fakes = { evidence: stateFolderEvidence, classifierCall: () => answering("mechanical").call };
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), fakes), FIX_README, "worker-without-store");
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approved("anthropic"));
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), fakes), FIX_README, "worker-with-store");
    assert.deepEqual(h.records().map((record) => [record.delegationId, record.recordType === "decision" && record.route.outcome, record.recordType === "decision" && record.ranOn]), [
      ["worker-without-store", "refused", `${HAIKU}:medium`],
      ["worker-with-store", "chosen", `${HAIKU}:low`],
    ], "no store: every rung is an unapproved recipient");
  } finally { h.cleanup(); }
  assert.deepEqual(existsSync(worktreeState) ? readdirSync(worktreeState) : [], before);
});

test("under PI_ORCHESTRATOR_ROUTER_PROBE=1 the router says it loaded and that routing is enabled", async () => {
  const h = harness(LIVE);
  process.env.PI_ORCHESTRATOR_ROUTER_PROBE = "1";
  try {
    const stderr = await stderrOf(async () => { await loadAutoProvider(h, fakeSessionRegistry([])); });
    assert.deepEqual(stderr.split("\n").filter(Boolean), [
      "pi-orchestrator router: loaded",
      `pi-orchestrator router: routing enabled, mode live, records ${join(h.stateDir, "routing")}`,
    ]);
  } finally {
    delete process.env.PI_ORCHESTRATOR_ROUTER_PROBE;
    h.cleanup();
  }
});

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
    const handlers = piHandlers();
    createRouterExtension()({ on(event: string, handler: Handler) { handlers.on(event, handler); } } as unknown as ExtensionAPI);
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

async function seedDecision(h: Harness, id: string, at: Date, mode: "live" | "shadow", provider: "anthropic" | "openai-codex" = "anthropic", tier: "mechanical" | "standard" = "mechanical"): Promise<void> {
  const map = fixtureTierMap();
  const route = fixtureRoute(tier, map, provider === "anthropic" ? { "openai-codex": { state: "out-of-usage" } } : { anthropic: { state: "out-of-usage" } });
  assert.ok(route.ok);
  const common = { delegationId: id, at, taskText: "Fix README.md", agentRole: "worker",
    classification: await fixtureClassification("Fix README.md", tier), tierMap: map, route };
  writeDecisionRecord(join(h.stateDir, "routing"), mode === "shadow"
    ? { ...common, mode, handPickedModel: "anthropic/claude-sonnet-5", ranOn: "anthropic/claude-sonnet-5:high" }
    : { ...common, mode, ranOn: route.rung.rung });
}

test("balanced routing counts only pinned decisions inside the rolling five hours across sessions and projects", async () => {
  const h = harness(LIVE);
  try {
    await seedDecision(h, "older-project", new Date(NOW.getTime() - 5 * 60 * 60 * 1000 - 1), "live");
    await seedDecision(h, "future-session", new Date(NOW.getTime() + 1), "live");
    await seedDecision(h, "other-session", new Date(NOW.getTime() - 5 * 60 * 60 * 1000), "live");
    await seedDecision(h, "other-tier", NOW, "live", "anthropic", "standard");
    const otherProject = projectWithMechanicalTier(h, "other-project", [`${HAIKU}:low`]);
    const other = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("other") }]), {}, { cwd: otherProject });
    await autoEvents(other, FIX_README, "other-project-worker");
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]));
    await autoEvents(stream, FIX_README, "current-session");
    const record = h.records().find((entry) => entry.delegationId === "current-session");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.equal(record.route.rung.model.split("/")[0], "openai-codex");
    assert.equal(record.route.tierOrder, "balanced");
    assert.deepEqual(record.route.providerCounts, { anthropic: 3, "openai-codex": 0 });
  } finally { h.cleanup(); }
});

test("an ordered project tier pins its first surviving rung even when another provider has fewer pins", async () => {
  const h = harness(LIVE);
  try {
    await seedDecision(h, "previous", NOW, "live");
    const project = join(h.projectDir, "ordered-project");
    mkdirSync(join(project, ".pi"), { recursive: true });
    writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ orchestrator: { routing: {
      tiers: { mechanical: { order: "ordered", rungs: TEST_TIERS.mechanical } },
    } } }));
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), {}, { cwd: project });
    await autoEvents(stream, FIX_README, "ordered-worker");
    const record = h.records().find((entry) => entry.delegationId === "ordered-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.equal(record.route.rung.model, HAIKU);
    assert.equal(record.route.tierOrder, "ordered");
    assert.equal(record.route.providerCounts, undefined);
    assert.equal(record.tierMap.orders?.mechanical, "ordered");
  } finally { h.cleanup(); }
});

test("shadow recommendations do not change a live balanced choice", async () => {
  const h = harness(LIVE);
  try {
    await seedDecision(h, "shadow-other-session", NOW, "shadow");
    const stream = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("ok") }]));
    await autoEvents(stream, FIX_README, "live-worker");
    const record = h.records().find((entry) => entry.delegationId === "live-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.equal(record.route.rung.model, HAIKU);
    assert.deepEqual(record.route.providerCounts, { anthropic: 0, "openai-codex": 0 });
  } finally { h.cleanup(); }
});

test("parallel fan-out pins distinct providers and the second record sees the first", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("one") }, { events: answerEvents("two") }]);
    const stream = await loadAutoProvider(h, registry);
    await Promise.all([autoEvents(stream, FIX_README, "fanout-one"), autoEvents(stream, FIX_README, "fanout-two")]);
    const records = h.records().filter((entry) => entry.recordType === "decision");
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.route.outcome === "chosen" && record.route.rung.model.split("/")[0]), ["anthropic", "openai-codex"]);
    assert.deepEqual(records.map((record) => record.route.outcome === "chosen" && record.route.providerCounts), [
      { anthropic: 0, "openai-codex": 0 }, { anthropic: 1, "openai-codex": 0 },
    ]);
  } finally { h.cleanup(); }
});

test("parallel fan-out across separate worker providers reserves each choice in the shared state folder", async () => {
  const h = harness(LIVE);
  try {
    let arrivals = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const classifierCall = () => async () => {
      if (++arrivals === 2) release();
      await together;
      return classifierAnswer("mechanical");
    };
    const firstRegistry = fakeSessionRegistry([{ events: answerEvents("one") }]);
    const secondRegistry = fakeSessionRegistry([{ events: answerEvents("two") }]);
    const [first, second] = await Promise.all([
      loadAutoProvider(h, firstRegistry, { classifierCall }),
      loadAutoProvider(h, secondRegistry, { classifierCall }),
    ]);
    const events = await Promise.all([
      autoEvents(first, FIX_README, "separate-fanout-one"),
      autoEvents(second, FIX_README, "separate-fanout-two"),
    ]);
    assert.deepEqual(events.map((stream) => stream.at(-1)?.type), ["done", "done"]);
    assert.deepEqual([firstRegistry.calls[0]?.model.provider, secondRegistry.calls[0]?.model.provider].sort(), ["anthropic", "openai-codex"]);
    const records = h.records().filter((record) => record.recordType === "decision");
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.route.outcome === "chosen" && record.route.providerCounts), [
      { anthropic: 0, "openai-codex": 0 }, { anthropic: 1, "openai-codex": 0 },
    ]);
  } finally { h.cleanup(); }
});

test("a rung missing from the registry never counts as a pinned delegation", async () => {
  const h = harness({ ...LIVE, tiers: { ...TEST_TIERS, mechanical: ["anthropic/claude-sonnet-5:low", "openai-codex/gpt-6-luna:low"] } });
  try {
    const missing = fakeSessionRegistry([]);
    let unavailable = false;
    const registry = { ...missing, find: (provider: string, id: string) =>
      unavailable && id === "claude-sonnet-5" ? undefined : missing.find(provider, id) };
    const first = await loadAutoProvider(h, registry, { classifierCall: () => answering("mechanical").call });
    unavailable = true;
    const failed = await autoEvents(first, FIX_README, "missing-rung-worker");
    assert.equal(failed.at(-1)?.type, "error");
    assert.equal(missing.calls.length, 0);
    assert.deepEqual(h.records(), [], "a failed lookup made no provider request");

    const restored = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const second = await loadAutoProvider(h, restored);
    assert.equal((await autoEvents(second, FIX_README, "after-missing-rung")).at(-1)?.type, "done");
    assert.equal(restored.calls[0]?.model.provider, "anthropic", "a failed lookup cannot skew balancing");
    const record = h.records().find((entry) => entry.delegationId === "after-missing-rung");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.deepEqual(record.route.providerCounts, { anthropic: 0, "openai-codex": 0 });
  } finally { h.cleanup(); }
});

test("a provider request that fails to start does not reserve a balanced choice", async () => {
  const h = harness(LIVE);
  try {
    const failedRegistry = fakeSessionRegistry([{ throws: "could not start request" }]);
    const first = await loadAutoProvider(h, failedRegistry);
    assert.equal((await autoEvents(first, FIX_README, "cannot-start")).at(-1)?.type, "error");
    assert.deepEqual(h.records(), []);
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const second = await loadAutoProvider(h, registry);
    assert.equal((await autoEvents(second, FIX_README, "after-cannot-start")).at(-1)?.type, "done");
    assert.equal(registry.calls[0]?.model.provider, "anthropic");
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

test("provider and startup failures across extension instances print one disabled line per process", async () => {
  const first = harness(LIVE);
  const second = harness({ ...LIVE, classifier: { model: "anthropic/unknown:low" } });
  try {
    startFreshProcess();
    const setup = async (h: Harness, failure: "provider" | "startup") => {
      // pi gives every load its own module copy; the line is still once per process.
      const { createRouterExtension: fresh } = await import(`./extension.ts?disable-process-${failure}-${++isolatedModule}`);
      process.env.PI_CODING_AGENT_DIR = h.agentDir;
      process.env.PI_ORCHESTRATOR_STATE_DIR = h.stateDir;
      const handlers = piHandlers();
      let provider: ProviderConfigInput | undefined;
      fresh({ classifierCall: () => answering("mechanical").call,
        evidence: () => () => { if (failure !== "startup") throw new Error(`${failure} evidence exploded`); return evidenceOf(); }, now: () => NOW })({
        on(event: string, handler: Handler) { handlers.on(event, handler); },
        registerProvider(_name: string, config: ProviderConfigInput) { provider = config; },
      } as unknown as ExtensionAPI);
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
        cwd: h.projectDir, hasUI: false, model: SESSION_MODEL, thinkingLevel: "medium", modelRegistry: fakeSessionRegistry([{ events: answerEvents("ok") }]),
        sessionManager: { getSessionId: () => "parent" },
      });
      return { stream: provider?.streamSimple };
    };
    const stderr = await stderrOf(async () => {
      const provider = await setup(first, "provider");
      assert.ok(provider.stream);
      assert.equal((await autoEvents(provider.stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "provider-failure")).at(-1)?.type, "done");
      await setup(second, "startup");
    });
    assert.deepEqual(stderr.split("\n").filter(Boolean), ["pi-orchestrator router disabled: provider evidence exploded"]);
  } finally { first.cleanup(); second.cleanup(); }
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

// pi-subagents puts the agent's thinking level on the requested model, so
// the caller passes `reasoning`; the rung's effort replaces it (ADR 0006).
test("the auto model sends no reasoning option for an off rung, whatever the caller asked", async () => {
  const h = harness({ ...LIVE, tiers: { ...TEST_TIERS, mechanical: [`${HAIKU}:off`] } });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry);
    await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "off-worker", { reasoning: "high" });
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
    await autoEvents(stream, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "clamped-worker", { reasoning: "low" });
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

// ---------------------------------------------------------------------------
// The main thread stays on the model picked in /model (ADR 0006): a user's
// selection of orchestrator/auto is undone with one line, a session that
// starts on it, as a worker does, is left alone.
// ---------------------------------------------------------------------------

const OPUS_MODEL = { provider: "anthropic", id: "claude-opus-5" };

async function loadMainThread(h: Harness, hasUI: boolean) {
  const handlers = piHandlers();
  const setModelCalls: unknown[] = [];
  const notices: string[] = [];
  createRouterExtension({ classifierCall: () => answering("mechanical").call, evidence: () => () => evidenceOf(), now: () => NOW })({
    registerProvider() {},
    on(event: string, handler: Handler) { handlers.on(event, handler); },
    // pi's setModel emits its own model_select, source set (agent-session.js).
    async setModel(model: unknown) {
      setModelCalls.push(model);
      await handlers.get("model_select")?.({ type: "model_select", model, previousModel: AUTO_MODEL, source: "set" }, ctx);
      return true;
    },
  } as unknown as ExtensionAPI);
  const ctx: ExtensionContext = { cwd: h.projectDir, hasUI, model: SESSION_MODEL, thinkingLevel: "high", modelRegistry: fakeSessionRegistry([]),
    sessionManager: { getSessionId: () => "main" }, ui: { notify: (message) => { notices.push(message); } } };
  const select = (model: unknown, previousModel: unknown, source: string) =>
    handlers.get("model_select")?.({ type: "model_select", model, previousModel, source }, ctx);
  return { handlers, ctx, setModelCalls, notices, select };
}

for (const source of ["set", "cycle"]) {
  test(`selecting orchestrator/auto for the main thread (source ${source}) restores the previous model with one line`, async () => {
    const h = harness(LIVE);
    try {
      const main = await loadMainThread(h, true);
      await main.select(AUTO_MODEL, SESSION_MODEL, source);
      assert.deepEqual(main.setModelCalls, [SESSION_MODEL]);
      assert.deepEqual(main.notices, ["pi-orchestrator router: orchestrator/auto is for workers; restored anthropic/claude-haiku-4-5 for the main thread."]);
    } finally { h.cleanup(); }
  });
}

test("after the refusal the orchestrator's model names the restored model, never orchestrator/auto", async () => {
  const h = harness(LIVE);
  try {
    const main = await loadMainThread(h, true);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:low";
    await main.select(AUTO_MODEL, OPUS_MODEL, "set");
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-opus-5:high");
  } finally { delete process.env.PI_ORCHESTRATOR_SESSION_MODEL; h.cleanup(); }
});

test("without a UI the orchestrator/auto refusal line goes to stderr", async () => {
  const h = harness(LIVE);
  try {
    const main = await loadMainThread(h, false);
    const stderr = await stderrOf(async () => { await main.select(AUTO_MODEL, OPUS_MODEL, "set"); });
    assert.deepEqual(main.setModelCalls, [OPUS_MODEL]);
    assert.equal(stderr, "pi-orchestrator router: orchestrator/auto is for workers; restored anthropic/claude-opus-5 for the main thread.\n");
    assert.deepEqual(main.notices, []);
  } finally { h.cleanup(); }
});

test("when the previous model cannot be restored the refusal line asks for another model", async () => {
  const h = harness(LIVE);
  try {
    const main = await loadMainThread(h, true);
    await main.select(AUTO_MODEL, undefined, "set");
    assert.deepEqual(main.setModelCalls, []);
    assert.deepEqual(main.notices, ["pi-orchestrator router: orchestrator/auto is for workers; pick another model in /model for the main thread."]);
  } finally { h.cleanup(); }
});

/** What pi does on "set as default" in /model, with pi's own SettingsManager:
 *  it queues a write of the default to the agent dir's settings.json before
 *  it emits model_select. Returns pi's in-memory settings for later saves. */
function piSavesDefault(h: Harness, provider: string, id: string): SettingsManager {
  const settings = SettingsManager.create(h.projectDir, h.agentDir);
  settings.setDefaultModelAndProvider(provider, id);
  return settings;
}

test("setting orchestrator/auto as the default in /model restores the previous model as the default too", async () => {
  const h = harness(LIVE, { sessionBanList: ["opus"] });
  try {
    const main = await loadMainThread(h, true);
    const piSettings = piSavesDefault(h, "orchestrator", "auto");
    await main.select(AUTO_MODEL, SESSION_MODEL, "set");
    // A later save by pi writes only its own field over the file.
    piSettings.setDefaultThinkingLevel("high");
    await piSettings.flush();
    assert.deepEqual(main.setModelCalls, [SESSION_MODEL]);
    assert.deepEqual(main.notices, ["pi-orchestrator router: orchestrator/auto is for workers; restored anthropic/claude-haiku-4-5 for the main thread and as the default model."]);
    const settings = JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8"));
    assert.deepEqual([settings.defaultProvider, settings.defaultModel, settings.defaultThinkingLevel], ["anthropic", "claude-haiku-4-5", "high"]);
    assert.deepEqual(settings.orchestrator, { routing: LIVE, sessionBanList: ["opus"] });
  } finally { h.cleanup(); }
});

test("a saved default other than orchestrator/auto is left alone by the refusal", async () => {
  const h = harness(LIVE);
  try {
    const main = await loadMainThread(h, true);
    piSavesDefault(h, "anthropic", "claude-opus-5");
    await main.select(AUTO_MODEL, SESSION_MODEL, "set");
    assert.deepEqual(main.notices, ["pi-orchestrator router: orchestrator/auto is for workers; restored anthropic/claude-haiku-4-5 for the main thread."]);
    const settings = JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8"));
    assert.deepEqual([settings.defaultProvider, settings.defaultModel], ["anthropic", "claude-opus-5"]);
  } finally { h.cleanup(); }
});

test("when no model can be restored a saved orchestrator/auto default is named in the one line", async () => {
  const h = harness(LIVE);
  try {
    const main = await loadMainThread(h, true);
    piSavesDefault(h, "orchestrator", "auto");
    await main.select(AUTO_MODEL, undefined, "set");
    assert.deepEqual(main.notices, ["pi-orchestrator router: orchestrator/auto is for workers; pick another model in /model for the main thread; the saved default is still orchestrator/auto, set another default in /model."]);
    const settings = JSON.parse(readFileSync(join(h.agentDir, "settings.json"), "utf8"));
    assert.deepEqual([settings.defaultProvider, settings.defaultModel], ["orchestrator", "auto"]);
  } finally { h.cleanup(); }
});

test("a session that starts or is restored on orchestrator/auto is left on it", async () => {
  const h = harness(LIVE);
  try {
    const main = await loadMainThread(h, false);
    const stderr = await stderrOf(async () => {
      await main.handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, { ...main.ctx, model: AUTO_MODEL });
      await main.select(AUTO_MODEL, SESSION_MODEL, "restore");
    });
    assert.deepEqual(main.setModelCalls, []);
    assert.doesNotMatch(stderr, /for workers/);
    assert.deepEqual(main.notices, []);
  } finally { h.cleanup(); }
});

test("selecting any other model for the main thread is not affected", async () => {
  const h = harness(LIVE);
  try {
    const main = await loadMainThread(h, true);
    for (const source of ["set", "cycle", "restore"]) await main.select(OPUS_MODEL, SESSION_MODEL, source);
    assert.deepEqual(main.setModelCalls, []);
    assert.deepEqual(main.notices, []);
  } finally { h.cleanup(); }
});

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

test("shadow mode classifies rather than restoring an earlier live pin", async () => {
  const h = harness(LIVE);
  try {
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("live") }])), messages, "mode-changed-worker");
    writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ orchestrator: { routing: SHADOW } }));
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("shadow") }]);
    const stream = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    assert.equal((await autoEvents(stream, messages, "mode-changed-worker")).at(-1)?.type, "done");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    assert.deepEqual(h.records().map((record) => record.recordType === "decision" && record.mode), ["live", "shadow"]);
  } finally { h.cleanup(); }
});

test("a resumed worker reuses its recorded rung without classifying or writing a record", async () => {
  const h = harness(LIVE);
  try {
    const first = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }]));
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    await autoEvents(first, messages, "resumed-worker");
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("resumed") }]);
    const resumed = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
    await autoEvents(resumed, messages, "resumed-worker");
    assert.equal(registry.calls[0]?.model.id, "claude-haiku-4-5");
    assert.equal(registry.calls[0]?.options?.reasoning, "low");
    assert.equal(classifier.prompts.length, 0);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a resumed worker reuses a rung written in settings with different case", async () => {
  const mixedCase = { ...TEST_TIERS, mechanical: ["Anthropic/Claude-Haiku-4-5:low", "openai-codex/gpt-6-luna:low"] };
  const h = harness({ ...LIVE, tiers: mixedCase });
  try {
    const first = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }]));
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    await autoEvents(first, messages, "mixed-case-worker");
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("resumed") }]);
    const resumed = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
    await autoEvents(resumed, messages, "mixed-case-worker");
    assert.equal(registry.calls[0]?.model.id, "claude-haiku-4-5");
    assert.equal(classifier.prompts.length, 0);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a damaged decision-record day file does not stop a new worker from classifying", async () => {
  const h = harness(LIVE);
  try {
    const folder = join(h.stateDir, "routing");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "2026-09-25.jsonl"), "{broken json\n");
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("classified") }]);
    const stream = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
    const events = await autoEvents(stream, [{ role: "user", content: "Add a retry option", timestamp: 0 }], "damaged-record-worker");
    assert.equal(events.at(-1)?.type, "done");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    const file = join(folder, "2026-09-26.jsonl");
    const record = JSON.parse(readFileSync(file, "utf8")) as { delegationId: string };
    assert.equal(record.delegationId, "damaged-record-worker");
  } finally { h.cleanup(); }
});

test("a resumed worker accepts a legacy /2 decision record", async () => {
  const h = harness(LIVE);
  try {
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }])), messages, "legacy-worker");
    const file = join(h.stateDir, "routing", "2026-09-26.jsonl");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    record.schemaVersion = "decision-record/2";
    delete record.ranOn;
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("resumed") }]);
    await autoEvents(await loadAutoProvider(h, registry, { classifierCall: () => classifier.call }), messages, "legacy-worker");
    assert.equal(registry.calls[0]?.model.id, "claude-haiku-4-5");
    assert.equal(classifier.prompts.length, 0);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a shadow decision cannot pin a resumed worker to its hypothetical rung", async () => {
  const h = harness(LIVE);
  try {
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }])), messages, "shadow-worker");
    const file = join(h.stateDir, "routing", "2026-09-26.jsonl");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    record.mode = "shadow";
    record.ranOn = HAIKU;
    record.handPickedModel = HAIKU;
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    assert.equal(h.records()[0]?.recordType, "decision", "the shadow fixture must be readable");
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("resumed") }]);
    await autoEvents(await loadAutoProvider(h, registry, { classifierCall: () => classifier.call }), messages, "shadow-worker");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    assert.equal(h.records().length, 2);
  } finally { h.cleanup(); }
});

test("a live decision whose ranOn differs from its rung cannot restore a pin", async () => {
  const h = harness(LIVE);
  try {
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }])), messages, "fallback-worker");
    const file = join(h.stateDir, "routing", "2026-09-26.jsonl");
    const record = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    record.ranOn = HAIKU;
    writeFileSync(file, `${JSON.stringify(record)}\n`);
    assert.equal(h.records()[0]?.recordType, "decision", "the fallback fixture must be readable");
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("resumed") }]);
    await autoEvents(await loadAutoProvider(h, registry, { classifierCall: () => classifier.call }), messages, "fallback-worker");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    assert.equal(h.records().length, 2);
  } finally { h.cleanup(); }
});

test("a resumed worker whose rung fails a hard filter is classified and recorded again", async () => {
  const h = harness(LIVE);
  try {
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    const first = await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }]));
    await autoEvents(first, messages, "filtered-worker");
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("new rung") }]);
    const resumed = await loadAutoProvider(h, registry, {
      classifierCall: () => classifier.call,
      evidence: () => () => evidenceOf({ authorization: approved("openai-codex") }),
    });
    await autoEvents(resumed, messages, "filtered-worker");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(registry.calls[0]?.model.id, "gpt-6-sol");
    assert.deepEqual(h.records().map((record) => record.recordType === "decision" && record.route.outcome === "chosen" && record.route.rung.rung),
      [`${HAIKU}:low`, "openai-codex/gpt-6-sol:medium"]);
  } finally { h.cleanup(); }
});

test("a worker without a recorded decision is classified as a first request", async () => {
  const h = harness(LIVE);
  try {
    const classifier = answering("standard");
    const registry = fakeSessionRegistry([{ events: answerEvents("first") }]);
    const stream = await loadAutoProvider(h, registry, { classifierCall: () => classifier.call });
    await autoEvents(stream, [{ role: "user", content: "Add a retry option", timestamp: 0 }], "unrecorded-worker");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(registry.calls[0]?.model.id, "claude-sonnet-5");
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a resumed worker uses the latest decision for its delegation id", async () => {
  const h = harness(LIVE);
  try {
    const messages = [{ role: "user", content: "Fix README.md", timestamp: 0 }];
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }])), messages, "latest-worker");
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("second") }]), {
      evidence: () => () => evidenceOf({ authorization: approved("openai-codex") }),
    }), messages, "latest-worker");
    const classifier = answering("critical");
    const registry = fakeSessionRegistry([{ events: answerEvents("third") }]);
    await autoEvents(await loadAutoProvider(h, registry, { classifierCall: () => classifier.call }), messages, "latest-worker");
    assert.equal(registry.calls[0]?.model.id, "gpt-6-luna");
    assert.equal(classifier.prompts.length, 0);
    assert.equal(h.records().length, 2);
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
    const handlers = piHandlers();
    createRouterExtension({ classifierCall: () => answering("mechanical").call, evidence: () => () => evidenceOf(), now: () => NOW })({
      registerProvider(name: string, config: ProviderConfigInput) { assert.equal(name, "orchestrator"); registered.push(config); },
      on(event: string, handler: Handler) { handlers.on(event, handler); },
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
      assert.equal(summary.ranOn, "openai-codex/gpt-6-luna:low");
    }
  } finally { h.cleanup(); }
});

test("the auto model probe reports the rung, pin and time for each request", async () => {
  const h = harness(LIVE);
  process.env.PI_ORCHESTRATOR_ROUTER_PROBE = "1";
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("first") }, { events: answerEvents("second") }]);
    let provider: ProviderConfigInput | undefined;
    const handlers = piHandlers();
    const lines = await stderrOf(async () => {
      createRouterExtension({ classifierCall: () => answering("mechanical").call, evidence: () => () => evidenceOf(), now: () => NOW })({
        registerProvider(_name: string, config: ProviderConfigInput) { provider = config; },
        on(event: string, handler: Handler) { handlers.on(event, handler); },
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

test("by default the router classifies through the session's model registry, not a pi child, and forwards to the chosen rung", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents(classifierAnswer("mechanical")) }, { events: answerEvents("fixed") }]);
    const stderr = await stderrOf(async () => {
      const stream = await loadAutoProviderWith(h, registry, {});
      assert.equal((await autoEvents(stream, FIX_README, "in-session-worker")).at(-1)?.type, "done");
    });
    assert.doesNotMatch(stderr, /pi-orchestrator router disabled/, stderr);
    assert.equal(registry.calls.length, 2, "one classifier request through the session registry, then the worker's request");
    assert.deepEqual(registry.calls[0]?.context.messages.length, 1);
    assert.equal(`${registry.calls[1]?.model.provider}/${registry.calls[1]?.model.id}:${registry.calls[1]?.options?.reasoning}`, `${HAIKU}:low`);
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.classification.cause, `model:${HAIKU}:low`);
    assert.deepEqual(record?.recordType === "decision" && record.classification.hops.map((hop) => [hop.hop, hop.outcome, hop.allowance?.settlement]), [[`${HAIKU}:low`, "decided", "settled"]]);
  } finally { h.cleanup(); }
});

test("a failing in-session classifier request is a recorded hop failure: the router stays enabled and the worker is routed on keywords", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([
      { events: errorEvents("You're out of extra usage.") },
      { events: answerEvents("first") },
      { events: answerEvents(classifierAnswer("mechanical")) },
      { events: answerEvents("second") },
    ]);
    const stderr = await stderrOf(async () => {
      const stream = await loadAutoProviderWith(h, registry, {});
      assert.equal((await autoEvents(stream, FIX_README, "worker-1")).at(-1)?.type, "done");
      assert.equal((await autoEvents(stream, FIX_README, "worker-2")).at(-1)?.type, "done");
    });
    assert.doesNotMatch(stderr, /pi-orchestrator router disabled/, stderr);
    const [first, second] = h.records();
    assert.deepEqual(first?.recordType === "decision" && first.classification.hops.map((hop) => [hop.hop, hop.outcome]), [[`${HAIKU}:low`, "out-of-usage"], ["keywords", "decided"]]);
    assert.equal(first?.recordType === "decision" && first.classification.cause, "keywords");
    assert.equal(second?.recordType === "decision" && second.classification.cause, `model:${HAIKU}:low`, "the next worker still classifies in the session");
  } finally { h.cleanup(); }
});

test("under PI_ORCHESTRATOR_ROUTER_PROBE=1 the in-session classifier prints its time to first token, total time, tokens and reported cost", async () => {
  const h = harness(LIVE);
  process.env.PI_ORCHESTRATOR_ROUTER_PROBE = "1";
  try {
    const usage = { input: 900, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 980, cost: { total: 0.0012 } };
    const registry = fakeSessionRegistry([
      { events: answerEvents(classifierAnswer("mechanical"), { usage }) },
      { events: answerEvents("first") },
      { events: errorEvents("socket hang up") },
      { events: answerEvents("second") },
    ]);
    const stderr = await stderrOf(async () => {
      const stream = await loadAutoProviderWith(h, registry, {});
      await autoEvents(stream, FIX_README, "worker-1");
      await autoEvents(stream, FIX_README, "worker-2");
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

// ---------------------------------------------------------------------------
// Per-worker routing constraints: set for one worker before its first request
// ---------------------------------------------------------------------------

test("a minimum tier routes the worker at that tier, above its classified tier, and the record names it", async () => {
  const h = harness(LIVE);
  const clear = setRoutingConstraints("min-tier-worker", { minimumTier: "elevated" });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry);
    assert.equal((await autoEvents(stream, FIX_README, "min-tier-worker")).at(-1)?.type, "done");
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-opus-5", "high"]]);
    const [record] = h.records();
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.equal(record.classification.tier, "mechanical");
    assert.equal(record.route.startedAtTier, "elevated");
    assert.equal(record.route.tier, "elevated");
    assert.deepEqual(record.route.tiersTried, ["elevated"]);
    assert.deepEqual(record.constraints, { minimumTier: "elevated" });
  } finally { clear(); h.cleanup(); }
});

test("a classified tier above the minimum tier is kept", async () => {
  const h = harness(LIVE);
  const clear = setRoutingConstraints("above-min-worker", { minimumTier: "standard" });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry, { classifierCall: () => answering("critical").call });
    assert.equal((await autoEvents(stream, FIX_README, "above-min-worker")).at(-1)?.type, "done");
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-opus-5", "xhigh"]]);
    const [record] = h.records();
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.deepEqual([record.classification.tier, record.route.startedAtTier, record.route.tier], ["critical", "critical", "critical"]);
    assert.deepEqual(record.constraints, { minimumTier: "standard" });
  } finally { clear(); h.cleanup(); }
});

test("a minimum tier whose rungs the hard filters remove escalates as usual, never below the minimum", async () => {
  const tiers = { ...TEST_TIERS, elevated: ["openai-codex/gpt-6-sol:high"] };
  const h = harness({ ...LIVE, tiers });
  const clear = setRoutingConstraints("min-tier-escalated", { minimumTier: "elevated" });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry, { evidence: () => () => evidenceOf({ authorization: approved("anthropic") }) });
    assert.equal((await autoEvents(stream, FIX_README, "min-tier-escalated")).at(-1)?.type, "done");
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-opus-5", "xhigh"]]);
    const [record] = h.records();
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.equal(record.route.startedAtTier, "elevated");
    assert.equal(record.route.tier, "critical");
    assert.deepEqual(record.route.tiersTried, ["elevated", "critical"]);
    assert.deepEqual(record.route.removed.map((removed) => [removed.tier, removed.rung, removed.reason]), [
      ["elevated", "openai-codex/gpt-6-sol:high", "unapproved recipient"],
      ["critical", "openai-codex/gpt-6-sol:xhigh", "unapproved recipient"],
    ]);
  } finally { clear(); h.cleanup(); }
});

test("an excluded rung is never chosen, in its own tier or after escalation, while its model at another effort still is", async () => {
  const tiers = { ...TEST_TIERS, elevated: ["anthropic/claude-opus-5:high"], critical: ["anthropic/claude-opus-5:high", "anthropic/claude-opus-5:xhigh"] };
  const h = harness({ ...LIVE, tiers });
  const clear = setRoutingConstraints("excluding-worker", { excludedRung: { model: "anthropic/claude-opus-5", effort: "high" } });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const stream = await loadAutoProvider(h, registry, { classifierCall: () => answering("elevated").call });
    assert.equal((await autoEvents(stream, FIX_README, "excluding-worker")).at(-1)?.type, "done");
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-opus-5", "xhigh"]]);
    const [record] = h.records();
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.equal(record.route.rung.rung, "anthropic/claude-opus-5:xhigh");
    assert.deepEqual(record.route.tiersTried, ["elevated", "critical"]);
    assert.deepEqual(record.route.removed.map((removed) => [removed.tier, removed.rung, removed.reason]), [
      ["elevated", "anthropic/claude-opus-5:high", "excluded rung"],
      ["critical", "anthropic/claude-opus-5:high", "excluded rung"],
    ]);
    assert.deepEqual(record.constraints, { excludedRung: "anthropic/claude-opus-5:high" });
  } finally { clear(); h.cleanup(); }
});

/** An effort the ladder generated: sonnet is listed at medium only. */
const FORCED_SONNET_HIGH = { tier: "standard", rung: { rung: "anthropic/claude-sonnet-5:high", model: "anthropic/claude-sonnet-5", effort: "high", origin: "personal" } } as const;

test("a forced rung that passes the hard filters is pinned without a tier choice, and the record names it", async () => {
  const h = harness(LIVE);
  const clear = setRoutingConstraints("forced-worker", { forcedRung: FORCED_SONNET_HIGH });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("first") }, { events: answerEvents("second") }]);
    const stream = await loadAutoProvider(h, registry);
    for (let request = 0; request < 2; request++) assert.equal((await autoEvents(stream, FIX_README, "forced-worker")).at(-1)?.type, "done");
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-sonnet-5", "high"], ["claude-sonnet-5", "high"]]);
    const records = h.records();
    assert.equal(records.length, 1);
    const [record] = records;
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.equal(record.classification.tier, "mechanical");
    assert.deepEqual([record.route.startedAtTier, record.route.tier, record.route.tiersTried], ["standard", "standard", ["standard"]]);
    assert.equal(record.route.rung.rung, "anthropic/claude-sonnet-5:high");
    assert.deepEqual(record.route.survivors.map((rung) => rung.rung), ["anthropic/claude-sonnet-5:high"]);
    assert.deepEqual(record.route.removed, []);
    assert.equal(record.ranOn, "anthropic/claude-sonnet-5:high");
    assert.deepEqual(record.constraints, { forcedRung: { tier: "standard", rung: "anthropic/claude-sonnet-5:high" } });
  } finally { clear(); h.cleanup(); }
});

test("a forced rung that fails a hard filter is a refusal with the reason: no other rung is tried and the worker runs on the session model", async () => {
  const h = harness(LIVE);
  const forced = { tier: "elevated", rung: { rung: "openai-codex/gpt-6-sol:high", model: "openai-codex/gpt-6-sol", effort: "high", origin: "personal" } } as const;
  const clear = setRoutingConstraints("refused-forced-worker", { forcedRung: forced });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("fallback") }]);
    const stream = await loadAutoProvider(h, registry, { evidence: () => () => evidenceOf({ authorization: approved("anthropic") }) });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:medium";
    assert.equal((await autoEvents(stream, FIX_README, "refused-forced-worker")).at(-1)?.type, "done");
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-sonnet-5", "medium"]]);
    const [record] = h.records();
    assert.ok(record?.recordType === "decision" && record.route.outcome === "refused");
    assert.match(record.route.message, /forced rung openai-codex\/gpt-6-sol:high \(elevated\) fails unapproved recipient: .*No other rung was tried/);
    assert.deepEqual(record.route.tiersTried, ["elevated"]);
    assert.deepEqual(record.route.removed.map((removed) => [removed.tier, removed.rung, removed.reason]), [["elevated", "openai-codex/gpt-6-sol:high", "unapproved recipient"]]);
    assert.equal(record.ranOn, "anthropic/claude-sonnet-5:medium");
    assert.deepEqual(record.constraints, { forcedRung: { tier: "elevated", rung: "openai-codex/gpt-6-sol:high" } });
  } finally { clear(); h.cleanup(); }
});

test("routing constraints bind only their worker's session id, and removing them restores the usual routing", async () => {
  const h = harness(LIVE);
  const clear = setRoutingConstraints("constrained-worker", { minimumTier: "critical" });
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("other") }, { events: answerEvents("cleared") }]);
    const stream = await loadAutoProvider(h, registry);
    await autoEvents(stream, FIX_README, "other-worker");
    clear();
    await autoEvents(stream, FIX_README, "constrained-worker");
    assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-haiku-4-5", "low"], ["gpt-6-luna", "low"]]);
    const records = h.records();
    assert.deepEqual(records.map((record) => record.delegationId), ["other-worker", "constrained-worker"]);
    for (const record of records) assert.equal("constraints" in record, false, "an unconstrained decision record has no constraints field");
  } finally { clear(); h.cleanup(); }
});

test("a recorded decision pins a constrained worker again only when it was made under the same constraints", async () => {
  const h = harness(LIVE);
  let clear = () => {};
  try {
    // Recorded without constraints, on a mechanical rung that still passes the hard filters.
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: answerEvents("first") }])), FIX_README, "restored-worker");
    clear = setRoutingConstraints("restored-worker", { minimumTier: "elevated" });
    const classifier = answering("mechanical");
    const rerouted = fakeSessionRegistry([{ events: answerEvents("rerouted") }]);
    await autoEvents(await loadAutoProvider(h, rerouted, { classifierCall: () => classifier.call }), FIX_README, "restored-worker");
    assert.equal(classifier.prompts.length, 1, "classified again");
    assert.deepEqual(rerouted.calls.map((call) => [call.model.id, call.options?.reasoning]), [["gpt-6-sol", "high"]]);

    // Recorded under these constraints: restored without classifying.
    const again = answering("critical");
    const restored = fakeSessionRegistry([{ events: answerEvents("restored") }]);
    await autoEvents(await loadAutoProvider(h, restored, { classifierCall: () => again.call }), FIX_README, "restored-worker");
    assert.equal(again.prompts.length, 0, "not classified");
    assert.deepEqual(restored.calls.map((call) => [call.model.id, call.options?.reasoning]), [["gpt-6-sol", "high"]]);
    assert.equal(h.records().length, 2);
  } finally { clear(); h.cleanup(); }
});

test("a worker whose fallback would be the rung its constraints exclude fails with the reason after a live refusal, and runs on that rung in shadow mode and with routing off", async () => {
  const excluded = { model: "anthropic/claude-sonnet-5", effort: "high" };
  const cases = [
    { name: "shadow", routing: SHADOW, deps: {}, runs: true },
    // Only anthropic is approved, and the one anthropic rung per tier is removed by the recipient filter or the exclusion.
    { name: "refused", routing: { ...LIVE, tiers: { mechanical: ["openai-codex/gpt-6-luna:low"], standard: ["openai-codex/gpt-6-sol:medium"],
      elevated: ["anthropic/claude-sonnet-5:high"], critical: ["openai-codex/gpt-6-sol:xhigh"] } },
      deps: { evidence: () => () => evidenceOf({ authorization: approved("anthropic") }) }, runs: false },
    { name: "off", routing: { ...LIVE, enabled: false }, deps: {}, runs: true },
  ] as const;
  for (const { name, routing, deps, runs } of cases) {
    const h = harness(routing);
    const id = `excluded-fallback-${name}`;
    const clear = setRoutingConstraints(id, { minimumTier: "elevated", excludedRung: excluded });
    try {
      const registry = fakeSessionRegistry([{ events: answerEvents("same rung") }, { events: answerEvents("other effort") }]);
      const stream = await loadAutoProvider(h, registry, deps);
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
      const events = await autoEvents(stream, FIX_README, id);
      const final = events.at(-1);
      if (runs) {
        // A same-rung review (ADR 0010): no other rung can be chosen, so the reviewer runs on the excluded one.
        assert.equal(final?.type, "done", name);
        assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-sonnet-5", "high"]], name);
        const records = h.records();
        if (name === "shadow") {
          const [record] = records;
          assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen", name);
          assert.notEqual(record.route.rung.rung, "anthropic/claude-sonnet-5:high", "the would-be rung is still another");
          assert.equal(record.ranOn, "anthropic/claude-sonnet-5:high");
          assert.equal(record.constraints?.excludedRung, "anthropic/claude-sonnet-5:high");
        } else assert.deepEqual(records, [], "routing off records nothing");
        continue;
      }
      assert.equal(final?.type, "error", name);
      if (final?.type === "error") {
        assert.equal(final.error.errorMessage, "no other rung is left: this worker would fall back to the orchestrator session model " +
          "anthropic/claude-sonnet-5:high, which its routing constraints exclude", name);
      }
      assert.equal(registry.calls.length, 0, `${name}: nothing is forwarded`);
      assert.deepEqual(h.records(), [], `${name}: no decision is recorded for a worker that did not run`);
      // The same session model at another effort is not excluded.
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:medium";
      const other = `${id}-other-effort`;
      const clearOther = setRoutingConstraints(other, { minimumTier: "elevated", excludedRung: excluded });
      try {
        assert.equal((await autoEvents(stream, FIX_README, other)).at(-1)?.type, "done", name);
        assert.deepEqual(registry.calls.map((call) => [call.model.id, call.options?.reasoning]), [["claude-sonnet-5", "medium"]], name);
      } finally { clearOther(); }
    } finally { clear(); h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Usage observations (PRD cml8, "Usage observations" and "Signals"): a
// worker's usage-limit or rate-limit error marks the provider of its rung in
// the usage store in the state folder, and every later routing, from any
// session or project, reads it before the hard filters.
// ---------------------------------------------------------------------------

const CODEX_FIRST = { ...TEST_TIERS, mechanical: ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`] };
const CODEX_USAGE_LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";

/** The rungs a registry forwarded to, as `provider/model:effort`. */
function forwardedRungs(registry: ReturnType<typeof fakeSessionRegistry>): string[] {
  return registry.calls.map((call) => `${call.model.provider}/${call.model.id}:${call.options?.reasoning}`);
}

/** The removed rungs of `delegationId`'s decision, with reason and detail. */
function removedRungs(h: Harness, delegationId: string): [string, string, string][] {
  const record = h.records().find((entry) => entry.delegationId === delegationId);
  assert.ok(record?.recordType === "decision", `a decision for ${delegationId}`);
  return record.route.removed.map((removed) => [removed.rung, removed.reason, removed.detail]);
}

test("a Codex usage-limit error marks openai-codex exhausted until the stated reset, and the next routing from another session and project avoids it", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const failing = fakeSessionRegistry([{ events: errorEvents(CODEX_USAGE_LIMIT) }]);
    const failed = await autoEvents(await loadAutoProvider(h, failing), FIX_README, "limited-worker");
    assert.deepEqual(forwardedRungs(failing), ["openai-codex/gpt-6-luna:low"]);
    const final = failed.at(-1);
    assert.ok(final?.type === "error");
    assert.equal(final.error.errorMessage, CODEX_USAGE_LIMIT, "the worker still gets the provider's error");

    const otherProject = join(h.projectDir, "..", "other-project");
    mkdirSync(otherProject);
    const next = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    await autoEvents(await loadAutoProvider(h, next, {}, { cwd: otherProject }), FIX_README, "next-worker");
    assert.deepEqual(forwardedRungs(next), [`${HAIKU}:low`]);
    const [removed] = removedRungs(h, "next-worker");
    assert.deepEqual(removed?.slice(0, 2), ["openai-codex/gpt-6-luna:low", "provider out of usage"]);
    assert.match(removed?.[2] ?? "", /exhausted until 2026-09-26T12:42:00\.000Z/);

    const afterReset = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    await autoEvents(await loadAutoProvider(h, afterReset, { now: () => new Date("2026-09-26T12:42:00.000Z") }), FIX_README, "after-reset-worker");
    assert.deepEqual(forwardedRungs(afterReset), ["openai-codex/gpt-6-luna:low"]);
  } finally { h.cleanup(); }
});

const LIMIT_ERROR_CASES = [
  { label: "a Codex usage limit without a reset", tiers: CODEX_FIRST, error: "You have hit your ChatGPT usage limit (pro plan).",
    limited: "openai-codex/gpt-6-luna:low", other: `${HAIKU}:low`, reason: "provider out of usage", holdsUntil: "2026-09-26T17:00:00.000Z" },
  // pi-ai prefixes a WebSocket error event with "Codex error: "; the message after it is a stand-in until the live check captures one.
  { label: "a Codex usage limit on the WebSocket path", tiers: CODEX_FIRST, error: "Codex error: The usage limit has been reached",
    limited: "openai-codex/gpt-6-luna:low", other: `${HAIKU}:low`, reason: "provider out of usage", holdsUntil: "2026-09-26T17:00:00.000Z" },
  { label: "Anthropic out of extra usage", tiers: TEST_TIERS, error: "You're out of extra usage.",
    limited: `${HAIKU}:low`, other: "openai-codex/gpt-6-luna:low", reason: "provider out of usage", holdsUntil: "2026-09-26T17:00:00.000Z" },
  { label: "an Anthropic 429 rate limit", tiers: TEST_TIERS,
    error: '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}',
    limited: `${HAIKU}:low`, other: "openai-codex/gpt-6-luna:low", reason: "provider throttled", holdsUntil: "2026-09-26T12:05:00.000Z" },
  // A stand-in text too: pi-ai turns a Codex HTTP 429 into the usage-limit text above.
  { label: "a rate limit that says when to try again", tiers: CODEX_FIRST, error: "Codex error: Rate limit reached. Please try again in 20s.",
    limited: "openai-codex/gpt-6-luna:low", other: `${HAIKU}:low`, reason: "provider throttled", holdsUntil: "2026-09-26T12:00:20.000Z" },
] as const;

for (const { label, tiers, error, limited, other, reason, holdsUntil } of LIMIT_ERROR_CASES) {
  test(`${label} keeps the provider out of routing until ${holdsUntil}`, async () => {
    const h = harness({ ...LIVE, tiers });
    try {
      const failing = fakeSessionRegistry([{ events: errorEvents(error) }]);
      await autoEvents(await loadAutoProvider(h, failing), FIX_README, "limited-worker");
      assert.deepEqual(forwardedRungs(failing), [limited]);

      const justBefore = new Date(Date.parse(holdsUntil) - 1_000);
      const avoided = fakeSessionRegistry([{ events: answerEvents("ok") }]);
      await autoEvents(await loadAutoProvider(h, avoided, { now: () => justBefore }), FIX_README, "before-worker");
      assert.deepEqual(forwardedRungs(avoided), [other]);
      assert.deepEqual(removedRungs(h, "before-worker").map(([rung, why]) => [rung, why]), [[limited, reason]]);
      assert.match(removedRungs(h, "before-worker")[0]?.[2] ?? "", new RegExp(`until ${holdsUntil.replaceAll(".", "\\.")}`));

      const back = fakeSessionRegistry([{ events: answerEvents("ok") }]);
      await autoEvents(await loadAutoProvider(h, back, { now: () => new Date(holdsUntil) }), FIX_README, "after-worker");
      assert.deepEqual(forwardedRungs(back), [limited]);
    } finally { h.cleanup(); }
  });
}

test("an error that is no limit leaves the provider in routing", async () => {
  const h = harness(LIVE);
  try {
    const failing = fakeSessionRegistry([{ events: errorEvents('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}') }]);
    await autoEvents(await loadAutoProvider(h, failing), FIX_README, "failed-worker");
    const next = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    await autoEvents(await loadAutoProvider(h, next), FIX_README, "next-worker");
    assert.deepEqual(forwardedRungs(next), ["openai-codex/gpt-6-luna:low"]);
    assert.deepEqual(removedRungs(h, "next-worker"), []);
  } finally { h.cleanup(); }
});

/** A project folder next to the harness project whose settings replace the mechanical tier. */
function projectWithMechanicalTier(h: Harness, name: string, rungs: readonly string[]): string {
  const dir = join(h.projectDir, "..", name);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ orchestrator: { routing: { tiers: { mechanical: rungs } } } }));
  return dir;
}

const BOTH_EXHAUSTED = "anthropic: exhausted until 2026-09-26T17:00:00.000Z (no reset stated), from a limit error at 2026-09-26T12:00:00.000Z; " +
  "openai-codex: exhausted until 2026-09-26T12:42:00.000Z, from a limit error at 2026-09-26T12:00:00.000Z";

/** Two sessions in two projects hit a usage limit at once, each on its own provider. */
async function exhaustBothProviders(h: Harness): Promise<void> {
  const codex = fakeSessionRegistry([{ events: errorEvents(CODEX_USAGE_LIMIT) }]);
  const anthropic = fakeSessionRegistry([{ events: errorEvents("You're out of extra usage.") }]);
  const codexStream = await loadAutoProvider(h, codex, {}, { cwd: projectWithMechanicalTier(h, "codex-project", ["openai-codex/gpt-6-luna:low"]) });
  const anthropicStream = await loadAutoProvider(h, anthropic, {}, { cwd: projectWithMechanicalTier(h, "anthropic-project", [`${HAIKU}:low`]) });
  await Promise.all([autoEvents(codexStream, FIX_README, "codex-worker"), autoEvents(anthropicStream, FIX_README, "anthropic-worker")]);
  assert.deepEqual([...forwardedRungs(codex), ...forwardedRungs(anthropic)], ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`]);
}

test("with every provider exhausted a worker is refused with the reset times, and nothing is forwarded or recorded for it", async () => {
  const h = harness(LIVE);
  try {
    await exhaustBothProviders(h);
    const nothing = fakeSessionRegistry([]);
    const refused = await autoEvents(await loadAutoProvider(h, nothing), FIX_README, "refused-worker");
    const final = refused.at(-1);
    assert.ok(final?.type === "error");
    assert.equal(final.error.errorMessage, "routing refused this worker, and its fallback, the orchestrator session model " +
      `anthropic/claude-haiku-4-5:medium, is on anthropic, which is out of usage. Usage limits: ${BOTH_EXHAUSTED}. No request was sent to any provider.`);
    assert.equal(nothing.calls.length, 0);
    assert.equal(h.records().some((record) => record.delegationId === "refused-worker"), false);
  } finally { h.cleanup(); }
});

test("after a refusal the session-model fallback runs only while its provider is not exhausted", async () => {
  const codexOnly = { mechanical: ["openai-codex/gpt-6-luna:low"], standard: ["openai-codex/gpt-6-sol:medium"],
    elevated: ["openai-codex/gpt-6-sol:high"], critical: ["openai-codex/gpt-6-sol:xhigh"] };
  const h = harness({ ...LIVE, tiers: codexOnly });
  try {
    await autoEvents(await loadAutoProvider(h, fakeSessionRegistry([{ events: errorEvents(CODEX_USAGE_LIMIT) }])), FIX_README, "codex-worker");

    const fallback = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    assert.equal((await autoEvents(await loadAutoProvider(h, fallback), FIX_README, "fallback-worker")).at(-1)?.type, "done");
    assert.deepEqual(forwardedRungs(fallback), [`${HAIKU}:medium`], "the anthropic session model still has usage");
    const record = h.records().find((entry) => entry.delegationId === "fallback-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "refused");
    assert.deepEqual([...new Set(record.route.removed.map((removed) => removed.reason))], ["provider out of usage"]);
    assert.equal(record.ranOn, `${HAIKU}:medium`);

    const nothing = fakeSessionRegistry([]);
    const stream = await loadAutoProvider(h, nothing);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "openai-codex/gpt-6-sol:medium";
    const final = (await autoEvents(stream, FIX_README, "skipped-fallback-worker")).at(-1);
    assert.ok(final?.type === "error");
    assert.equal(final.error.errorMessage, "routing refused this worker, and its fallback, the orchestrator session model openai-codex/gpt-6-sol:medium, " +
      "is on openai-codex, which is out of usage. Usage limits: openai-codex: exhausted until 2026-09-26T12:42:00.000Z, " +
      "from a limit error at 2026-09-26T12:00:00.000Z. No request was sent to any provider.");
    assert.equal(nothing.calls.length, 0);
  } finally { h.cleanup(); }
});
