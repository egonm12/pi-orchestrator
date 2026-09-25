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
import { readRoutingRecords, type RoutingRecord } from "../routing/decision-record.ts";
import { answerEvents, errorEvents, fakeSessionRegistry, assistantMessage } from "../fixtures/session-model-registry.ts";
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext as ExtensionContext } from "../fixtures/extension-context.ts";
import type { SessionModelRegistry } from "../routing/model-stream.ts";
import { createRouterExtension, type RouterDependencies, type RoutingEvidence } from "./extension.ts";
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
  // The fresh-install notice is covered by init/setup.test.ts.
  output = output.split("\n").filter((line) => !line.startsWith("pi-orchestrator: not set up:")).join("\n");
  return output;
}

const CLASSIFIER = { model: `${HAIKU}:low`, timeoutMs: 1_000 };
const LIVE = { enabled: true, mode: "live", classifier: CLASSIFIER, tiers: TEST_TIERS };
const SHADOW = { enabled: true, mode: "shadow", classifier: CLASSIFIER, tiers: TEST_TIERS };


function classifierAnswer(tier: string): string {
  return JSON.stringify({ tier, risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: `session classifier says ${tier}` });
}

async function loadAutoProvider(h: Harness, registry: SessionModelRegistry, deps: Partial<RouterDependencies> = {}): Promise<AutoStream> {
  return loadAutoProviderWith(h, registry, { classifierCall: () => answering("mechanical").call, ...deps });
}

/** The router extension as pi loads it, with the classifier call it would use
 *  in pi unless `deps` replaces it: the in-session call over the registry. */
async function loadAutoProviderWith(h: Harness, registry: SessionModelRegistry, deps: Partial<RouterDependencies>): Promise<AutoStream> {
  let provider: ProviderConfigInput | undefined;
  const handlers = piHandlers();
  const createIsolatedRouterExtension = await isolatedRouterExtension();
  createIsolatedRouterExtension({ evidence: () => () => evidenceOf(), now: () => NOW, ...deps })({
    registerProvider(name: string, config: ProviderConfigInput) { assert.equal(name, "orchestrator"); provider = config; },
    on(event: string, handler: Handler) { handlers.on(event, handler); },
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

const FIX_README = [{ role: "user", content: "Fix the typo in README.md", timestamp: 0 }];

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
