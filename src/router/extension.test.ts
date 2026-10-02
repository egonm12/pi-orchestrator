import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { buildRoutingReport } from "../routing/routing-report.ts";
import { answerEvents, errorEvents, fakeSessionRegistry, assistantMessage } from "../fixtures/session-model-registry.ts";
import { SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext as ExtensionContext } from "../fixtures/extension-context.ts";
import type { SessionModelRegistry } from "../routing/model-stream.ts";
import { createRouterExtension, type RouterDependencies, type RoutingEvidence } from "./extension.ts";
import { requestFailover, setRoutingConstraints } from "./auto-model.ts";
import { readUsageObservations, recordUsageObservation, usageObservationsPath, type UsageObservation } from "./usage-observations.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

type VirtualModel = Parameters<ExtensionAPI["registerVirtualModel"]>[0];
type RouteRequest = Parameters<VirtualModel["route"]>[0];
type RoutedModel = RouteRequest["model"];
const AUTO_MODEL = { provider: "orchestrator", id: "auto", api: "pi-virtual" };

useOwnerBanLists();

// The route seam (ADR 0014, spec 23b3 "Testing decisions"): the router
// extension as pi loads it. A fake ExtensionAPI records the registered
// virtual model and the event handlers; a test calls the virtual model's
// `route` with requests built as pi builds them, one per request reason, with
// the router state, `previous` and `failed` pi would pass. The fakes sit at
// the system boundaries only: the session model registry, the classifier
// model call, the evidence source (catalog, ticket 08 refresh state, approved
// recipients), the clock, settings files in a throwaway agent dir and project
// dir, and the environment. Assertions read what pi or the owner can observe:
// the physical model and thinking level a request is routed to, the records
// in the state folder, the usage store and printed lines.

const originalEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_ORCHESTRATOR_STATE_DIR: process.env.PI_ORCHESTRATOR_STATE_DIR,
  PI_ORCHESTRATOR_ROUTER_PROBE: process.env.PI_ORCHESTRATOR_ROUTER_PROBE,
  PI_ORCHESTRATOR_SESSION_MODEL: process.env.PI_ORCHESTRATOR_SESSION_MODEL,
  PI_ORCHESTRATOR_SESSION_VIRTUAL_MODEL: process.env.PI_ORCHESTRATOR_SESSION_VIRTUAL_MODEL,
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
  delete process.env.PI_ORCHESTRATOR_SESSION_VIRTUAL_MODEL;
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

const FIX_README = [{ role: "user", content: "Fix the typo in README.md", timestamp: 0 }];

/** One request as the auto model routed it: the physical model and thinking
 *  level pi sends it with, as `provider/id:level`, and the state it returned. */
interface Routed {
  readonly rung: string;
  readonly model: RoutedModel;
  readonly thinkingLevel: string;
  readonly state: unknown;
}

/** A worker's requests on the auto model, carrying what pi would pass:
 *  the router state last returned on the branch, `previous` once a request
 *  answered, and `failed` on a retry. */
interface WorkerRequests {
  /** The first request after a message the user wrote: the task, a steer or a follow-up. */
  user(): Promise<Routed>;
  /** A request after tool results or extension messages. */
  continuation(): Promise<Routed>;
  /** The latest request ends with `errorMessage`, having produced `output`
   *  first when given: the worker's message_end handlers see the failed
   *  response, as pi runs them before it retries or the worker fails. */
  fail(errorMessage: string, output?: string): Promise<void>;
  /** The latest request fails as `fail` says, and pi retries it automatically. */
  retry(errorMessage: string, output?: string): Promise<Routed>;
  /** The latest request fails as `fail` says with an error pi does not
   *  retry, and the worker runtime asks for a failover and continues the
   *  session once: the next request is reason user with the same state. */
  continueAfter(errorMessage: string): Promise<Routed>;
  /** A request outside the agent loop, such as a compaction summary: no state. */
  direct(): Promise<Routed>;
  /** The latest request answered: later requests carry it as `previous`. */
  answered(): void;
  /** The router state pi keeps on the branch. */
  readonly state: unknown;
  /** Every request's routed rung, in order. */
  readonly rungs: readonly string[];
}

/** The auto model as pi loaded it in a session whose model registry is `registry`. */
interface AutoModel {
  /** Every registration of the virtual model, in order. */
  readonly registered: readonly VirtualModel[];
  readonly handlers: ReturnType<typeof piHandlers>;
  /** Routes one request of the worker session `sessionId` through the latest
   *  registration, as pi does before it sends it: reason user and no state
   *  unless `request` says otherwise. `branch` is the session branch route's
   *  context exposes. */
  route(sessionId: string | undefined, messages?: readonly unknown[], request?: Partial<RouteRequest>, branch?: readonly unknown[]): Promise<Routed>;
  /** A worker session on the auto model, whose requests carry state and previous as pi passes them.
   *  `state` is the router state its branch already holds, as in a resumed session. */
  worker(sessionId: string, messages?: readonly unknown[], state?: unknown): WorkerRequests;
}

async function loadAutoModel(h: Harness, registry: SessionModelRegistry, deps: Partial<RouterDependencies> = {},
  session: { readonly cwd?: string } = {}): Promise<AutoModel> {
  return loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call, ...deps }, session);
}

/** A worker's context as pi hands it to route and to the worker's handlers:
 *  its session model is the auto model, which names no provider that answered. */
function workerContext(h: Harness, sessionId: string | undefined, registry: SessionModelRegistry, branch: readonly unknown[] = []): ExtensionContext {
  return { cwd: h.projectDir, hasUI: false, model: { provider: "orchestrator", id: "auto" }, modelRegistry: registry, thinkingLevel: "medium",
    sessionManager: { getSessionId: () => sessionId, getBranch: () => branch } } as unknown as ExtensionContext;
}

/** The router extension as pi loads it, with the classifier call it would use
 *  in pi unless `deps` replaces it: the in-session call over the registry. */
async function loadRouterWith(h: Harness, registry: SessionModelRegistry, deps: Partial<RouterDependencies>,
  session: { readonly cwd?: string } = {}): Promise<AutoModel> {
  const registered: VirtualModel[] = [];
  const handlers = piHandlers();
  const createIsolatedRouterExtension = await isolatedRouterExtension();
  createIsolatedRouterExtension({ evidence: () => () => evidenceOf(), now: () => NOW, ...deps })({
    registerProvider() { assert.fail("the router extension registers no provider"); },
    registerVirtualModel(definition: VirtualModel) { registered.push(definition); },
    on(event: string, handler: Handler) { handlers.on(event, handler); },
  } as unknown as ExtensionAPI);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
    cwd: session.cwd ?? h.projectDir, hasUI: false, model: SESSION_MODEL, modelRegistry: registry, thinkingLevel: "medium",
    sessionManager: { getSessionId: () => "parent" },
  });
  assert.deepEqual(registered.map((definition) => `${definition.provider}/${definition.id}`).at(-1), "orchestrator/auto");
  const route = async (sessionId: string | undefined, messages: readonly unknown[] = FIX_README, request: Partial<RouteRequest> = {},
    branch: readonly unknown[] = []): Promise<Routed> => {
    const routed = await registered.at(-1)!.route({ model: AUTO_MODEL, thinkingLevel: "medium", reason: "user", messages, ...request } as RouteRequest,
      workerContext({ ...h, projectDir: session.cwd ?? h.projectDir }, sessionId, registry, branch) as never);
    return { rung: `${routed.model.provider}/${routed.model.id}:${routed.thinkingLevel}`, model: routed.model, thinkingLevel: routed.thinkingLevel,
      state: routed.state };
  };
  const worker = (sessionId: string, messages: readonly unknown[] = FIX_README, saved?: unknown): WorkerRequests => {
    let state: unknown = saved;
    let previous: RouteRequest["previous"];
    let latest: Routed | undefined;
    const rungs: string[] = [];
    const send = async (reason: RouteRequest["reason"], extra: Partial<RouteRequest> = {}) => {
      const routed = await route(sessionId, messages, { reason, ...(reason === "direct" ? {} : { state }), ...(previous ? { previous } : {}), ...extra });
      // pi stores returned state before it sends the request, except for a direct request's.
      if (reason !== "direct" && routed.state !== undefined && routed.state !== state) state = routed.state;
      latest = routed;
      rungs.push(routed.rung);
      return routed;
    };
    const failure = (errorMessage: string, output?: string) => {
      assert.ok(latest, "a failure follows a request");
      return { ...assistantMessage({ stopReason: "error", errorMessage, content: output === undefined ? [] : [{ type: "text", text: output }] }),
        provider: latest.model.provider, model: latest.model.id };
    };
    const fail = async (errorMessage: string, output?: string) => {
      await handlers.get("message_end")?.({ type: "message_end", message: failure(errorMessage, output) },
        workerContext({ ...h, projectDir: session.cwd ?? h.projectDir }, sessionId, registry));
    };
    return {
      user: () => send("user"),
      continuation: () => send("continuation"),
      direct: () => send("direct"),
      fail,
      async retry(errorMessage, output) {
        await fail(errorMessage, output);
        const message = failure(errorMessage, output);
        return send("retry", { failed: { model: latest!.model, thinkingLevel: latest!.thinkingLevel, message } } as Partial<RouteRequest>);
      },
      async continueAfter(errorMessage) {
        await fail(errorMessage);
        const withdraw = requestFailover(sessionId, { model: `${latest!.model.provider}/${latest!.model.id}`, errorMessage });
        try { return await send("user"); } finally { withdraw(); }
      },
      answered() {
        assert.ok(latest, "an answer follows a request");
        previous = { model: latest.model, thinkingLevel: latest.thinkingLevel } as RouteRequest["previous"];
      },
      get state() { return state; },
      rungs,
    };
  };
  return { registered, handlers, route, worker };
}

/** A worker's first request: reason user, no router state and no previous response. */
async function firstRequest(auto: AutoModel, messages: readonly unknown[], sessionId: string): Promise<Routed> {
  return auto.route(sessionId, messages);
}

// context-mode's pi adapter appends this as a plain user message through the
// `context` hook, after the delegated prompt and before the first reply.
const CONTEXT_MODE_ANCHOR = "context-mode active. Hierarchy: ctx_batch_execute > ctx_execute > ctx_execute_file > ctx_search. " +
  "Stats → ctx_stats. Doctor → ctx_doctor. Upgrade → ctx_upgrade. Purge → ctx_purge.";

test("text another extension appends after the delegated prompt does not reach the classifier", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([{ events: answerEvents("ok") }]);
    const classifier = answering("mechanical");
    const auto = await loadAutoModel(h, registry, { classifierCall: () => classifier.call });
    await firstRequest(auto, [...FIX_README, { role: "user", content: CONTEXT_MODE_ANCHOR }], "injected-worker");
    assert.equal(classifier.prompts.length, 1);
    assert.doesNotMatch(classifier.prompts[0]!, /context-mode active|ctx_purge/);
    const [record] = h.records();
    assert.ok(record?.recordType === "decision");
    assert.doesNotMatch(record.taskTextPrefix, /ctx_purge/);
    assert.equal(record.classification.tier, "mechanical");
    assert.equal(record.ranOn, `${HAIKU}:low`);
  } finally { h.cleanup(); }
});

test("on a pi host without registerVirtualModel the router extension fails to load with an error naming pi v0.99", () => {
  const registered: string[] = [];
  const handlers = piHandlers();
  assert.throws(() => createRouterExtension()({
    registerProvider(name: string) { registered.push(name); },
    on(event: string, handler: Handler) { handlers.on(event, handler); },
  } as unknown as ExtensionAPI), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /requires pi v0\.99 or later/);
    assert.match(error.message, /registerVirtualModel/);
    return true;
  });
  // It fails before it registers anything.
  assert.deepEqual(registered, []);
  assert.equal(handlers.get("session_start"), undefined);
});

test("the router extension's fresh-install notice names what is missing", async () => {
  const h = harness(undefined);
  try {
    const notices: string[] = [];
    const handlers = piHandlers();
    createRouterExtension()({
      registerProvider() {},
      registerVirtualModel() {},
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
        registerVirtualModel() {},
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
    registerVirtualModel() {},
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
      registerVirtualModel() {},
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), { classifierCall: () => classifier.call });
    await firstRequest(auto, [
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
      const auto = await loadAutoModel(h, registry, { evidence: () => () => evidenceOf(overrides) });
      assert.equal((await firstRequest(auto, FIX_README, "usage-worker")).rung, rung);
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
    const auto = await loadAutoModel(h, registry, { evidence: () => () => evidenceOf({ catalog: unaffordable(evidenceOf().catalog) }) });
    assert.equal((await firstRequest(auto, FIX_README, "unaffordable-worker")).rung, `${HAIKU}:medium`, "the session model at its effort");
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
    let routed: Routed | undefined;
    const stderr = await stderrOf(async () => {
      const auto = await loadAutoModel(h, registry);
      routed = await firstRequest(auto, FIX_README, "unrecorded-worker");
    });
    const lines = stderr.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, stderr);
    assert.match(lines[0]!, /^pi-orchestrator router disabled: .*(EEXIST|ENOTDIR)/);
    assert.equal(routed?.rung, `${HAIKU}:medium`, "the session model at its effort");
  } finally { h.cleanup(); }
});

test("the state folder's approved-recipients store decides whether a rung survives, and nothing is written under the checkout's src/state", async () => {
  const worktreeState = defaultStateDir();
  const before = existsSync(worktreeState) ? readdirSync(worktreeState) : [];
  const h = harness(LIVE);
  try {
    const fakes = { evidence: stateFolderEvidence, classifierCall: () => answering("mechanical").call };
    await firstRequest(await loadAutoModel(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), fakes), FIX_README, "worker-without-store");
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approved("anthropic"));
    await firstRequest(await loadAutoModel(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), fakes), FIX_README, "worker-with-store");
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
    const stderr = await stderrOf(async () => { await loadAutoModel(h, fakeSessionRegistry([])); });
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
    await loadAutoModel(h, registry);
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, `${HAIKU}:medium`);
  } finally { h.cleanup(); }
});

test("model selections update the session model, but auto and delegated sessions cannot replace it", async () => {
  const h = harness(LIVE);
  try {
    const handlers = piHandlers();
    createRouterExtension()({ registerVirtualModel() {}, on(event: string, handler: Handler) { handlers.on(event, handler); } } as unknown as ExtensionAPI);
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
    const auto = await loadAutoModel(h, registry, { evidence: () => () => evidenceOf({ authorization: emptyAuthorization() }) });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    const routed = await firstRequest(auto, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "refused-worker");
    assert.equal(routed.rung, "anthropic/claude-sonnet-5:high");
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.route.outcome, "refused");
    assert.equal(record?.recordType === "decision" && record.ranOn, "anthropic/claude-sonnet-5:high");
  } finally { h.cleanup(); }
});

test("shadow mode runs on the orchestrator's physical session model, records the rung live routing would choose, and stays there", async () => {
  const h = harness(SHADOW);
  try {
    const registry = fakeSessionRegistry([]);
    const auto = await loadAutoModel(h, registry);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    const worker = auto.worker("shadow-worker", [{ role: "user", content: "Fix README.md", timestamp: 0 }]);
    assert.equal((await worker.user()).rung, "anthropic/claude-sonnet-5:high");
    worker.answered();
    // The orchestrator moves on; its worker keeps the model it started on.
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-opus-5:low";
    assert.equal((await worker.continuation()).rung, "anthropic/claude-sonnet-5:high");
    assert.equal((await worker.user()).rung, "anthropic/claude-sonnet-5:high");
    assert.equal(h.records().length, 1);
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.route.outcome === "chosen" && record.route.rung.rung, `${HAIKU}:low`);
    assert.equal(record?.recordType === "decision" && record.handPickedModel, "anthropic/claude-sonnet-5");
    assert.equal(record?.recordType === "decision" && record.ranOn, "anthropic/claude-sonnet-5:high");
  } finally { h.cleanup(); }
});

// Another extension's router, such as pi's jev example: a virtual model the
// orchestrator may run on. A worker's route cannot return it.
const OTHER_VIRTUAL_MODEL = { provider: "jev", id: "auto", api: "pi-virtual" };

/** The orchestrator's context on another extension's virtual model, with the session branch `branch`. */
function virtualOrchestrator(h: Harness, registry: SessionModelRegistry, branch: readonly unknown[] = []): ExtensionContext {
  return { cwd: h.projectDir, hasUI: false, model: OTHER_VIRTUAL_MODEL, thinkingLevel: "medium", modelRegistry: registry,
    sessionManager: { getSessionId: () => "parent", getBranch: () => branch } } as unknown as ExtensionContext;
}

/** A response the orchestrator got from a physical model its virtual model routed to. */
function physicalAnswer(model: string, thinkingLevel: string, stopReason = "stop") {
  const slash = model.indexOf("/");
  return { ...assistantMessage({ stopReason, ...(stopReason === "error" ? { errorMessage: "overloaded" } : {}) }),
    api: "fake-physical", provider: model.slice(0, slash), model: model.slice(slash + 1), thinkingLevel };
}

test("shadow mode with the orchestrator on another virtual model that has not answered yet refuses the worker with the reason", async () => {
  const h = harness(SHADOW);
  try {
    const registry = fakeSessionRegistry([]);
    const auto = await loadAutoModel(h, registry);
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, `${HAIKU}:medium`);
    const orchestrator = virtualOrchestrator(h, registry);
    await auto.handlers.get("model_select")?.({ type: "model_select", model: OTHER_VIRTUAL_MODEL, source: "set" }, orchestrator);
    // A failed response names no physical model that answered.
    await auto.handlers.get("message_end")?.({ type: "message_end", message: physicalAnswer("anthropic/claude-sonnet-5", "high", "error") }, orchestrator);
    await assert.rejects(auto.worker("virtual-shadow-worker").user(), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "the orchestrator runs on virtual model jev/auto, which has not answered yet; shadow mode needs a physical model to run this worker on");
      return true;
    });
    assert.deepEqual(h.records(), [], "no worker request was sent, so no decision is recorded");
  } finally { h.cleanup(); }
});

test("shadow mode with the orchestrator on another virtual model runs the worker on the physical model that last answered it and records the rung live routing would choose", async () => {
  const h = harness(SHADOW);
  try {
    const registry = fakeSessionRegistry([]);
    const auto = await loadAutoModel(h, registry);
    const orchestrator = virtualOrchestrator(h, registry);
    await auto.handlers.get("model_select")?.({ type: "model_select", model: OTHER_VIRTUAL_MODEL, source: "set" }, orchestrator);
    await auto.handlers.get("message_end")?.({ type: "message_end", message: physicalAnswer("openai-codex/gpt-6-sol", "medium") }, orchestrator);
    await auto.handlers.get("message_end")?.({ type: "message_end", message: physicalAnswer("anthropic/claude-sonnet-5", "high") }, orchestrator);
    const worker = auto.worker("virtual-shadow-worker");
    assert.equal((await worker.user()).rung, "anthropic/claude-sonnet-5:high", "the worker runs on the latest answer's physical model and level");
    const [record] = h.records();
    assert.ok(record?.recordType === "decision");
    assert.equal(record.mode, "shadow");
    assert.equal(record.route.outcome === "chosen" && record.route.rung.rung, `${HAIKU}:low`);
    assert.equal(record.handPickedModel, "anthropic/claude-sonnet-5");
    assert.equal(record.ranOn, "anthropic/claude-sonnet-5:high");
  } finally { h.cleanup(); }
});

test("a refused live route with the orchestrator on another virtual model that has not answered yet refuses the worker with the reason", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([]);
    const auto = await loadAutoModel(h, registry, { evidence: () => () => evidenceOf({ authorization: emptyAuthorization() }) });
    await auto.handlers.get("model_select")?.({ type: "model_select", model: OTHER_VIRTUAL_MODEL, source: "set" }, virtualOrchestrator(h, registry));
    await assert.rejects(auto.worker("refused-virtual-worker").user(),
      { message: "the orchestrator runs on virtual model jev/auto, which has not answered yet; the fallback needs a physical model to run this worker on" });
  } finally { h.cleanup(); }
});

test("an orchestrator resumed on another virtual model takes the physical model that last answered on its branch", async () => {
  const h = harness(SHADOW);
  try {
    const registry = fakeSessionRegistry([]);
    const auto = await loadAutoModel(h, registry);
    const branch = [
      { type: "message", message: physicalAnswer("anthropic/claude-sonnet-5", "low") },
      { type: "message", message: physicalAnswer("openai-codex/gpt-6-sol", "high", "error") },
    ];
    await auto.handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, virtualOrchestrator(h, registry, branch));
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, "anthropic/claude-sonnet-5:low");
    assert.equal((await auto.worker("resumed-virtual-worker").user()).rung, "anthropic/claude-sonnet-5:low");
    // Back on a physical model, the orchestrator's selection is the session model again.
    await auto.handlers.get("model_select")?.({ type: "model_select", model: SESSION_MODEL, source: "set" },
      { ...virtualOrchestrator(h, registry, branch), model: SESSION_MODEL, thinkingLevel: "high" } as ExtensionContext);
    assert.equal((await auto.worker("physical-worker").user()).rung, `${HAIKU}:high`);
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
    const other = await loadAutoModel(h, fakeSessionRegistry([{ events: answerEvents("other") }]), {}, { cwd: otherProject });
    await firstRequest(other, FIX_README, "other-project-worker");
    const auto = await loadAutoModel(h, fakeSessionRegistry([{ events: answerEvents("ok") }]));
    await firstRequest(auto, FIX_README, "current-session");
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([{ events: answerEvents("ok") }]), {}, { cwd: project });
    await firstRequest(auto, FIX_README, "ordered-worker");
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([{ events: answerEvents("ok") }]));
    await firstRequest(auto, FIX_README, "live-worker");
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
    const auto = await loadAutoModel(h, registry);
    await Promise.all([firstRequest(auto, FIX_README, "fanout-one"), firstRequest(auto, FIX_README, "fanout-two")]);
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
      loadAutoModel(h, firstRegistry, { classifierCall }),
      loadAutoModel(h, secondRegistry, { classifierCall }),
    ]);
    const routed = await Promise.all([
      firstRequest(first, FIX_README, "separate-fanout-one"),
      firstRequest(second, FIX_README, "separate-fanout-two"),
    ]);
    assert.deepEqual(routed.map((request) => request.model.provider).sort(), ["anthropic", "openai-codex"]);
    const records = h.records().filter((record) => record.recordType === "decision");
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.route.outcome === "chosen" && record.route.providerCounts), [
      { anthropic: 0, "openai-codex": 0 }, { anthropic: 1, "openai-codex": 0 },
    ]);
  } finally { h.cleanup(); }
});

test("a worker's decision is recorded when its first request is routed, so the next worker routed spreads before the first answers", async () => {
  const h = harness(LIVE);
  try {
    const first = await loadAutoModel(h, fakeSessionRegistry([]));
    const second = await loadAutoModel(h, fakeSessionRegistry([]));
    assert.equal((await firstRequest(first, FIX_README, "routed-first")).model.provider, "anthropic");
    assert.deepEqual(h.records().map((record) => record.delegationId), ["routed-first"], "recorded before pi sends the request");
    assert.equal((await firstRequest(second, FIX_README, "routed-next")).model.provider, "openai-codex");
    const record = h.records().find((entry) => entry.delegationId === "routed-next");
    assert.equal(record?.recordType === "decision" && record.route.outcome === "chosen" && record.route.providerCounts?.anthropic, 1);
  } finally { h.cleanup(); }
});

test("a slower classifier sees a later worker's pin when it finally chooses", async () => {
  const h = harness(LIVE);
  let release!: () => void;
  let arrived!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { arrived = resolve; });
  try {
    let slowClock = NOW;
    const slow = await loadAutoModel(h, fakeSessionRegistry([]), {
      now: () => slowClock,
      classifierCall: () => async () => { arrived(); await wait; return classifierAnswer("mechanical"); },
    });
    const fast = await loadAutoModel(h, fakeSessionRegistry([]), { now: () => new Date(NOW.getTime() + 1_000) });
    const slowResult = firstRequest(slow, FIX_README, "slow-classifier");
    await entered;
    assert.equal((await firstRequest(fast, FIX_README, "fast-classifier")).model.provider, "anthropic");
    slowClock = new Date(NOW.getTime() + 2_000);
    release();
    assert.equal((await slowResult).model.provider, "openai-codex", "the choice uses the clock after classification");
    const slowRecord = h.records().find((record) => record.delegationId === "slow-classifier");
    assert.ok(slowRecord?.recordType === "decision" && slowRecord.route.outcome === "chosen");
    assert.deepEqual(slowRecord.route.providerCounts, { anthropic: 1, "openai-codex": 0 });
  } finally { release(); h.cleanup(); }
});

test("a corrupt pending-choice file cannot disable routing for later workers", async () => {
  const h = harness(LIVE);
  try {
    const dir = join(h.stateDir, "routing.choice-reservations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "torn.json"), "{not valid json");
    writeFileSync(join(dir, "null.json"), "null");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    assert.equal((await firstRequest(auto, FIX_README, "after-corrupt-reservation")).model.provider, "anthropic");
    const decision = h.records().find((record) => record.delegationId === "after-corrupt-reservation");
    assert.ok(decision?.recordType === "decision" && decision.mode === "live");
  } finally { h.cleanup(); }
});

test("a decision write failure disables the router with one line and the worker runs on the session model", async () => {
  const h = harness(LIVE);
  const dir = join(h.stateDir, "routing");
  try {
    // Classification and routing can read this folder, but appending the decision fails.
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    let routed: Routed | undefined;
    const output = await stderrOf(async () => {
      const auto = await loadAutoModel(h, fakeSessionRegistry([]));
      routed = await firstRequest(auto, FIX_README, "cannot-write-decision");
    });
    assert.match(output, /router disabled/);
    assert.equal(routed?.rung, `${HAIKU}:medium`, "no request goes out on a rung the records do not show");
    assert.equal(routed?.state, undefined, "a fallback after a failure pins nothing");
  } finally { if (existsSync(dir)) chmodSync(dir, 0o700); h.cleanup(); }
});

test("a rung missing from the registry fails the worker's request and never counts as a pinned delegation", async () => {
  const h = harness({ ...LIVE, tiers: { ...TEST_TIERS, mechanical: ["anthropic/claude-sonnet-5:low", "openai-codex/gpt-6-luna:low"] } });
  try {
    const missing = fakeSessionRegistry([]);
    let unavailable = false;
    const registry = { ...missing, find: (provider: string, id: string) =>
      unavailable && id === "claude-sonnet-5" ? undefined : missing.find(provider, id) };
    const first = await loadAutoModel(h, registry, { classifierCall: () => answering("mechanical").call });
    unavailable = true;
    await assert.rejects(firstRequest(first, FIX_README, "missing-rung-worker"), /pinned rung anthropic\/claude-sonnet-5 is missing from the session model registry/);
    assert.deepEqual(h.records(), [], "a failed lookup records nothing");

    const second = await loadAutoModel(h, fakeSessionRegistry([]));
    assert.equal((await firstRequest(second, FIX_README, "after-missing-rung")).model.provider, "anthropic", "a failed lookup cannot skew balancing");
    const record = h.records().find((entry) => entry.delegationId === "after-missing-rung");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.deepEqual(record.route.providerCounts, { anthropic: 0, "openai-codex": 0 });
  } finally { h.cleanup(); }
});

test("when routing is not enabled the auto model runs on the session model without a record", async () => {
  const h = harness({ ...LIVE, enabled: false });
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:medium";
    const routed = await firstRequest(auto, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "off-worker");
    assert.equal(routed.rung, "anthropic/claude-sonnet-5:medium");
    assert.equal(routed.state, undefined, "with routing off nothing is pinned, as before");
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("the auto model refuses the request with a reason when the session model is missing or banned", async () => {
  const h = harness(LIVE, { subagentBanList: ["sonnet"] });
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { evidence: () => () => evidenceOf({ authorization: emptyAuthorization() }) });
    delete process.env.PI_ORCHESTRATOR_SESSION_MODEL;
    await assert.rejects(firstRequest(auto, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "missing-worker"), /PI_ORCHESTRATOR_SESSION_MODEL.*missing/);
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    await assert.rejects(firstRequest(auto, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "banned-worker"), /subagent ban list.*sonnet/);
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("an internal routing failure disables routing once and later workers still run on the session model", async () => {
  const h = harness(LIVE);
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { evidence: () => () => { throw new Error("evidence exploded"); } });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    const rungs: string[] = [];
    const stderr = await stderrOf(async () => {
      for (const id of ["failed-one", "failed-two"]) rungs.push((await firstRequest(auto, [{ role: "user", content: "Fix README.md", timestamp: 0 }], id)).rung);
    });
    assert.deepEqual(stderr.split("\n").filter(Boolean), ["pi-orchestrator router disabled: evidence exploded"]);
    assert.deepEqual(rungs, ["anthropic/claude-sonnet-5:high", "anthropic/claude-sonnet-5:high"]);
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("routing and startup failures across extension instances print one disabled line per process", async () => {
  const first = harness(LIVE);
  const second = harness({ ...LIVE, classifier: { model: "anthropic/unknown:low" } });
  try {
    startFreshProcess();
    const setup = async (h: Harness, failure: "routing" | "startup") => {
      // pi gives every load its own module copy; the line is still once per process.
      const { createRouterExtension: fresh } = await import(`./extension.ts?disable-process-${failure}-${++isolatedModule}`);
      process.env.PI_CODING_AGENT_DIR = h.agentDir;
      process.env.PI_ORCHESTRATOR_STATE_DIR = h.stateDir;
      const handlers = piHandlers();
      let definition: VirtualModel | undefined;
      fresh({ classifierCall: () => answering("mechanical").call,
        evidence: () => () => { if (failure !== "startup") throw new Error(`${failure} evidence exploded`); return evidenceOf(); }, now: () => NOW })({
        on(event: string, handler: Handler) { handlers.on(event, handler); },
        registerVirtualModel(registered: VirtualModel) { definition = registered; },
      } as unknown as ExtensionAPI);
      const registry = fakeSessionRegistry([]);
      await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, {
        cwd: h.projectDir, hasUI: false, model: SESSION_MODEL, thinkingLevel: "medium", modelRegistry: registry,
        sessionManager: { getSessionId: () => "parent" },
      });
      return { definition, ctx: workerContext(h, "routing-failure", registry) };
    };
    const stderr = await stderrOf(async () => {
      const { definition, ctx } = await setup(first, "routing");
      assert.ok(definition);
      const routed = await definition.route({ model: AUTO_MODEL, thinkingLevel: "medium", reason: "user", messages: FIX_README } as unknown as RouteRequest, ctx as never);
      assert.equal(`${routed.model.provider}/${routed.model.id}`, HAIKU);
      await setup(second, "startup");
    });
    assert.deepEqual(stderr.split("\n").filter(Boolean), ["pi-orchestrator router disabled: routing evidence exploded"]);
  } finally { first.cleanup(); second.cleanup(); }
});

test("a startup routing failure still routes the auto model to the session model", async () => {
  const h = harness({ ...LIVE, classifier: { model: "anthropic/unknown:low" } });
  try {
    let routed: Routed | undefined;
    const stderr = await stderrOf(async () => {
      const auto = await loadAutoModel(h, fakeSessionRegistry([]));
      routed = await firstRequest(auto, [{ role: "user", content: "Fix README.md", timestamp: 0 }], "startup-failed-worker");
    });
    assert.match(stderr, /pi-orchestrator router disabled: classifier rung/);
    assert.equal(routed?.rung, `${HAIKU}:medium`);
    assert.deepEqual(h.records(), []);
  } finally { h.cleanup(); }
});

test("the auto model reads the agent role from system prompt sections and text parts", async () => {
  const h = harness(LIVE);
  try {
    const classifier = answering("mechanical");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    await firstRequest(auto, [
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    await firstRequest(auto, [
      { role: "system", content: [{ type: "text", text: '<active_agent name="worker"/>' }], timestamp: 0 },
      { role: "user", content: "Fix README.md", timestamp: 0 },
    ], "text-parts-worker");
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.agentRole, "worker");
  } finally { h.cleanup(); }
});

// pi-subagents puts the agent's thinking level on the requested model; the
// rung's effort replaces it (ADR 0006). pi clamps the returned level to the
// physical model (docs/virtual-models.md, "Route requests").
test("the auto model routes with the rung's effort, off included, whatever thinking level the worker selected", async () => {
  const h = harness({ ...LIVE, tiers: { ...TEST_TIERS, mechanical: [`${HAIKU}:off`] } });
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const routed = await auto.route("off-worker", [{ role: "user", content: "Fix README.md", timestamp: 0 }], { thinkingLevel: "high" });
    assert.equal(routed.rung, `${HAIKU}:off`);
  } finally { h.cleanup(); }
});

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
    registerVirtualModel() {},
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

// ---------------------------------------------------------------------------
// Request reasons (docs/virtual-models.md, "Route requests"): pi routes every
// request of a worker on the auto model. The first is classified, recorded
// and pinned in router state; the rest go to the pin by reason.
// ---------------------------------------------------------------------------

/** The session branch entry pi appends for router state the route returned. */
function stateEntry(state: unknown) {
  return { type: "custom", customType: "pi.virtual-model-state", id: "state", parentId: null, timestamp: NOW.toISOString(),
    data: { provider: "orchestrator", modelId: "auto", state } };
}

test("a worker's first request is classified, recorded and pinned; steers, follow-ups and continuations stay on the pin without classifying again", async () => {
  const h = harness(LIVE);
  try {
    const classifier = answering("mechanical");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    const worker = auto.worker("pinned-worker", [{ role: "system", content: '<active_agent name="worker"/>', timestamp: 0 }, ...FIX_README]);
    const first = await worker.user();
    assert.equal(first.rung, `${HAIKU}:low`);
    assert.ok(first.state !== undefined, "the pin is returned as router state");
    worker.answered();
    // A new worker would now be balanced onto the other provider.
    for (const request of [() => worker.continuation(), () => worker.user(), () => worker.continuation()]) {
      const next = await request();
      assert.equal(next.rung, `${HAIKU}:low`);
      assert.equal(next.state, first.state, "the stored state is kept, not replaced");
    }
    assert.equal(classifier.prompts.length, 1);
    assert.match(classifier.prompts[0]!, /Agent role: worker/);
    const records = h.records();
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record?.recordType, "decision");
    assert.equal(record.schemaVersion, "decision-record/3");
    assert.equal(record.delegationId, "pinned-worker");
    assert.equal(record.recordType === "decision" && record.ranOn, `${HAIKU}:low`);
  } finally { h.cleanup(); }
});

test("a pin in the branch's router state is kept in another process without classifying or recording, where routing would choose another rung", async () => {
  const h = harness(LIVE);
  try {
    const state = (await (await loadAutoModel(h, fakeSessionRegistry([]))).worker("state-worker").user()).state;
    const classifier = answering("critical");
    const later = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    for (const reason of ["user", "continuation"] as const) {
      const routed = await later.route("state-worker", FIX_README, { reason, state });
      assert.equal(routed.rung, `${HAIKU}:low`, reason);
    }
    assert.equal(classifier.prompts.length, 0);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("router state that is not a pin is ignored and the request is routed as a first request", async () => {
  const h = harness(LIVE);
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const routed = await auto.route("odd-state-worker", FIX_README, { state: { phase: "plan" } });
    assert.equal(routed.rung, `${HAIKU}:low`);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a direct request goes to the model that answered last, else to the pin the branch stores, without classifying or recording", async () => {
  const h = harness(LIVE);
  try {
    const classifier = answering("mechanical");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    const worker = auto.worker("direct-worker");
    const first = await worker.user();
    worker.answered();
    // A compaction summary: pi passes no state, only the latest response.
    const summary = await worker.direct();
    assert.equal(summary.rung, first.rung);
    assert.equal(summary.state, undefined);
    // Before any answer, the branch's router state names the pin.
    const early = await auto.route("direct-worker", FIX_README, { reason: "direct" }, [stateEntry(first.state)]);
    assert.equal(early.rung, first.rung);
    assert.equal(classifier.prompts.length, 1);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a direct request with no answer and no pin is routed as a first request and stores no state", async () => {
  const h = harness(LIVE);
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const routed = await auto.route("direct-first", [{ role: "user", content: "Summarize the conversation above", timestamp: 0 }], { reason: "direct" });
    assert.equal(routed.rung, `${HAIKU}:low`);
    assert.equal(routed.state, undefined, "pi ignores a direct request's state, so none is returned");
    assert.deepEqual(h.records().map((record) => record.delegationId), ["direct-first"]);
  } finally { h.cleanup(); }
});

test("a retry after an error that is no limit stays on the failed model, before and after output", async () => {
  const h = harness(LIVE);
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const worker = auto.worker("transient-worker");
    const first = await worker.user();
    assert.equal((await worker.retry("socket hang up")).rung, first.rung, "a first request that failed before output");
    assert.equal((await worker.retry("503 service unavailable", "partial")).rung, first.rung);
    worker.answered();
    assert.equal((await worker.continuation()).rung, first.rung);
    assert.equal((await worker.retry("overloaded")).rung, first.rung, "a later request");
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a retry of a worker with no pin stored stays on the model its request failed on", async () => {
  const h = harness({ ...LIVE, enabled: false });
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
    const worker = auto.worker("unpinned-worker");
    assert.equal((await worker.user()).rung, "anthropic/claude-sonnet-5:high");
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-opus-5:low";
    assert.equal((await worker.retry("429 too many requests")).rung, "anthropic/claude-sonnet-5:high");
  } finally { h.cleanup(); }
});

test("an auto model request without a session id is refused with a clear error and records nothing", async () => {
  const h = harness(LIVE);
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    await assert.rejects(auto.route(undefined, [{ role: "user", content: "Fix README.md", timestamp: 0 }]), /no session id/);
    assert.equal(h.records().length, 0);
  } finally { h.cleanup(); }
});

test("a damaged decision-record day file does not stop a new worker from classifying", async () => {
  const h = harness(LIVE);
  try {
    const folder = join(h.stateDir, "routing");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "2026-09-25.jsonl"), "{broken json\n");
    const classifier = answering("standard");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    const routed = await firstRequest(auto, [{ role: "user", content: "Add a retry option", timestamp: 0 }], "damaged-record-worker");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(routed.model.id, "claude-sonnet-5");
    const file = join(folder, "2026-09-26.jsonl");
    const record = JSON.parse(readFileSync(file, "utf8")) as { delegationId: string };
    assert.equal(record.delegationId, "damaged-record-worker");
  } finally { h.cleanup(); }
});

test("a worker without a recorded decision is classified as a first request", async () => {
  const h = harness(LIVE);
  try {
    const classifier = answering("standard");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    const routed = await firstRequest(auto, [{ role: "user", content: "Add a retry option", timestamp: 0 }], "unrecorded-worker");
    assert.equal(classifier.prompts.length, 1);
    assert.equal(routed.model.id, "claude-sonnet-5");
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("a resumed worker in a new process runs on the pin its branch's router state holds, without classifying or writing a record", async () => {
  const h = harness(LIVE);
  try {
    const first = await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "resumed-worker");
    assert.equal(first.rung, `${HAIKU}:low`);
    const classifier = answering("critical");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    const resumed = auto.worker("resumed-worker", FIX_README, first.state);
    assert.equal((await resumed.user()).rung, `${HAIKU}:low`);
    assert.equal((await resumed.continuation()).rung, `${HAIKU}:low`);
    assert.equal(classifier.prompts.length, 0);
    assert.equal(h.records().length, 1, "a resume writes no new record");
  } finally { h.cleanup(); }
});

test("a worker with a decision record but no router state on its branch is classified as a first request", async () => {
  const h = harness(LIVE);
  try {
    await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "stateless-worker");
    const classifier = answering("critical");
    const routed = await firstRequest(await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call }), FIX_README, "stateless-worker");
    assert.equal(classifier.prompts.length, 1, "the decision record is the audit trail, not the pin");
    assert.equal(routed.rung, "openai-codex/gpt-6-sol:xhigh", "a critical rung, not the recorded mechanical one");
    assert.equal(h.records().length, 2);
  } finally { h.cleanup(); }
});

test("the auto model is registered as a virtual model, not a provider, with the largest context window and output limit among the tier map's rungs", async () => {
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
    const auto = await loadAutoModel(h, registry);
    const [loaded, started, ...more] = auto.registered;
    assert.deepEqual(more, []);
    assert.deepEqual([loaded?.provider, loaded?.id, loaded?.name, loaded?.contextWindow, loaded?.maxTokens],
      ["orchestrator", "auto", "Orchestrator auto", undefined, undefined], "at load no tier map is read yet");
    assert.deepEqual(loaded?.thinkingLevels, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual([started?.provider, started?.id, started?.contextWindow, started?.maxTokens], ["orchestrator", "auto", 1_000_000, 128_000]);
  } finally { h.cleanup(); }
});

test("a retry after compaction for a context overflow stays on the rung without classifying again", async () => {
  const h = harness(LIVE);
  try {
    // pi compacts on an overflow and retries with reason retry and the failed
    // response (docs/virtual-models.md). This is Anthropic's overflow message.
    const overflow = "prompt is too long: 213462 tokens > 200000 maximum";
    const classifier = answering("mechanical");
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => classifier.call });
    const worker = auto.worker("long-worker");
    const first = await worker.user();
    assert.equal((await worker.retry(overflow)).rung, first.rung);
    assert.deepEqual(worker.rungs, [`${HAIKU}:low`, `${HAIKU}:low`]);
    assert.equal(classifier.prompts.length, 1);
    assert.equal(h.records().length, 1);
  } finally { h.cleanup(); }
});

test("the auto model probe reports the rung, pin and time for each request", async () => {
  const h = harness(LIVE);
  process.env.PI_ORCHESTRATOR_ROUTER_PROBE = "1";
  try {
    const lines = await stderrOf(async () => {
      const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("worker-probe");
      await worker.user();
      await worker.continuation();
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
    const registry = fakeSessionRegistry([{ events: answerEvents(classifierAnswer("mechanical")) }]);
    let routed: Routed | undefined;
    const stderr = await stderrOf(async () => {
      const auto = await loadRouterWith(h, registry, {});
      routed = await firstRequest(auto, FIX_README, "in-session-worker");
    });
    assert.doesNotMatch(stderr, /pi-orchestrator router disabled/, stderr);
    assert.equal(registry.calls.length, 1, "one classifier request through the session registry; pi sends the worker's");
    assert.deepEqual(registry.calls[0]?.context.messages.length, 1);
    assert.equal(routed?.rung, `${HAIKU}:low`);
    const [record] = h.records();
    assert.equal(record?.recordType === "decision" && record.classification.cause, `model:${HAIKU}:low`);
    assert.deepEqual(record?.recordType === "decision" && record.classification.hops.map((hop) => [hop.hop, hop.outcome, hop.allowance?.settlement]), [[`${HAIKU}:low`, "decided", "settled"]]);
  } finally { h.cleanup(); }
});

test("a failing in-session classifier request is a recorded hop failure: the router stays enabled and the worker runs unclassified, as elevated", async () => {
  const h = harness(LIVE);
  try {
    const registry = fakeSessionRegistry([
      { events: errorEvents("You're out of extra usage.") },
      { events: answerEvents(classifierAnswer("mechanical")) },
    ]);
    const stderr = await stderrOf(async () => {
      const auto = await loadRouterWith(h, registry, {});
      await firstRequest(auto, FIX_README, "worker-1");
      await firstRequest(auto, FIX_README, "worker-2");
    });
    assert.doesNotMatch(stderr, /pi-orchestrator router disabled/, stderr);
    const [first, second] = h.records();
    assert.deepEqual(first?.recordType === "decision" && first.classification.hops.map((hop) => [hop.hop, hop.outcome]), [[`${HAIKU}:low`, "out-of-usage"]]);
    assert.equal(first?.recordType === "decision" && first.classification.cause, "unclassified");
    assert.equal(first?.recordType === "decision" && first.classification.tier, "elevated");
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
      { events: errorEvents("socket hang up") },
    ]);
    const stderr = await stderrOf(async () => {
      const auto = await loadRouterWith(h, registry, {});
      await firstRequest(auto, FIX_README, "worker-1");
      await firstRequest(auto, FIX_README, "worker-2");
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const routed = await firstRequest(auto, FIX_README, "min-tier-worker");
    assert.deepEqual([routed.model.id, routed.thinkingLevel], ["claude-opus-5", "high"]);
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => answering("critical").call });
    const routed = await firstRequest(auto, FIX_README, "above-min-worker");
    assert.deepEqual([routed.model.id, routed.thinkingLevel], ["claude-opus-5", "xhigh"]);
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { evidence: () => () => evidenceOf({ authorization: approved("anthropic") }) });
    const routed = await firstRequest(auto, FIX_README, "min-tier-escalated");
    assert.deepEqual([routed.model.id, routed.thinkingLevel], ["claude-opus-5", "xhigh"]);
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { classifierCall: () => answering("elevated").call });
    const routed = await firstRequest(auto, FIX_README, "excluding-worker");
    assert.deepEqual([routed.model.id, routed.thinkingLevel], ["claude-opus-5", "xhigh"]);
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
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("forced-worker");
    await worker.user();
    worker.answered();
    await worker.continuation();
    assert.deepEqual(worker.rungs, ["anthropic/claude-sonnet-5:high", "anthropic/claude-sonnet-5:high"]);
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([]), { evidence: () => () => evidenceOf({ authorization: approved("anthropic") }) });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:medium";
    const routed = await firstRequest(auto, FIX_README, "refused-forced-worker");
    assert.deepEqual([routed.model.id, routed.thinkingLevel], ["claude-sonnet-5", "medium"]);
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
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const other = await firstRequest(auto, FIX_README, "other-worker");
    clear();
    const cleared = await firstRequest(auto, FIX_README, "constrained-worker");
    assert.deepEqual([other.rung, cleared.rung], [`${HAIKU}:low`, "openai-codex/gpt-6-luna:low"]);
    const records = h.records();
    assert.deepEqual(records.map((record) => record.delegationId), ["other-worker", "constrained-worker"]);
    for (const record of records) assert.equal("constraints" in record, false, "an unconstrained decision record has no constraints field");
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
      const auto = await loadAutoModel(h, fakeSessionRegistry([]), deps);
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:high";
      if (runs) {
        // A same-rung review (ADR 0010): no other rung can be chosen, so the reviewer runs on the excluded one.
        assert.equal((await firstRequest(auto, FIX_README, id)).rung, "anthropic/claude-sonnet-5:high", name);
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
      await assert.rejects(firstRequest(auto, FIX_README, id), { message: "no other rung is left: this worker would fall back to the orchestrator session model " +
        "anthropic/claude-sonnet-5:high, which its routing constraints exclude" }, name);
      assert.deepEqual(h.records(), [], `${name}: no decision is recorded for a worker that did not run`);
      // The same session model at another effort is not excluded.
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = "anthropic/claude-sonnet-5:medium";
      const other = `${id}-other-effort`;
      const clearOther = setRoutingConstraints(other, { minimumTier: "elevated", excludedRung: excluded });
      try {
        assert.equal((await firstRequest(auto, FIX_README, other)).rung, "anthropic/claude-sonnet-5:medium", name);
      } finally { clearOther(); }
    } finally { clear(); h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Usage observations (PRD cml8, "Usage observations" and "Signals"): a
// worker's usage-limit or rate-limit error marks the provider of its rung in
// the usage store in the state folder, and every later routing, from any
// session or project, reads it before the hard filters. pi ends a failed
// request with the failed response, which names the physical model it ran on,
// and the router reads it in the worker's message_end.
// ---------------------------------------------------------------------------

const CODEX_FIRST = { ...TEST_TIERS, mechanical: ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`] };
const CODEX_USAGE_LIMIT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.";
const CODEX_RATE_LIMIT = "Codex error: Rate limit reached. Please try again in 20s.";
const ANTHROPIC_RATE_LIMIT = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}';

/** The removed rungs of `delegationId`'s decision, with reason and detail. */
function removedRungs(h: Harness, delegationId: string): [string, string, string][] {
  const record = h.records().find((entry) => entry.delegationId === delegationId);
  assert.ok(record?.recordType === "decision", `a decision for ${delegationId}`);
  return record.route.removed.map((removed) => [removed.rung, removed.reason, removed.detail]);
}

test("a Codex usage-limit error marks openai-codex exhausted until the stated reset, and the next routing from another session and project avoids it", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("limited-worker");
    assert.equal((await worker.user()).rung, "openai-codex/gpt-6-luna:low");
    await worker.fail(CODEX_USAGE_LIMIT, "working");

    const otherProject = join(h.projectDir, "..", "other-project");
    mkdirSync(otherProject);
    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([]), {}, { cwd: otherProject }), FIX_README, "next-worker")).rung, `${HAIKU}:low`);
    const [removed] = removedRungs(h, "next-worker");
    assert.deepEqual(removed?.slice(0, 2), ["openai-codex/gpt-6-luna:low", "provider out of usage"]);
    assert.match(removed?.[2] ?? "", /exhausted until 2026-09-26T12:42:00\.000Z/);

    const afterReset = await loadAutoModel(h, fakeSessionRegistry([]), { now: () => new Date("2026-09-26T12:42:00.000Z") });
    assert.equal((await firstRequest(afterReset, FIX_README, "after-reset-worker")).rung, "openai-codex/gpt-6-luna:low");
  } finally { h.cleanup(); }
});

test("a failed response whose routing failed names the auto model and records no observation", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    await auto.handlers.get("message_end")?.({ type: "message_end", message: { ...assistantMessage({ stopReason: "error", errorMessage: CODEX_USAGE_LIMIT }),
      provider: "orchestrator", model: "auto" } }, workerContext(h, "unrouted-worker", fakeSessionRegistry([])));
    // The orchestrator's own failed response is not a rung's.
    await auto.handlers.get("message_end")?.({ type: "message_end", message: { ...assistantMessage({ stopReason: "error", errorMessage: CODEX_USAGE_LIMIT }),
      provider: "openai-codex", model: "gpt-6-luna" } }, { ...workerContext(h, "parent", fakeSessionRegistry([])), model: SESSION_MODEL });
    assert.deepEqual(readUsageObservations(usageObservationsPath(h.stateDir)), {});
  } finally { h.cleanup(); }
});

const LIMIT_ERROR_CASES = [
  { label: "a Codex usage limit without a reset", tiers: CODEX_FIRST, error: "You have hit your ChatGPT usage limit (pro plan).",
    limited: "openai-codex/gpt-6-luna:low", other: `${HAIKU}:low`, reason: "provider out of usage", holdsUntil: "2026-09-26T17:00:00.000Z", retried: false },
  // pi-ai prefixes a WebSocket error event with "Codex error: "; the message after it is a stand-in until the live check captures one.
  { label: "a Codex usage limit on the WebSocket path", tiers: CODEX_FIRST, error: "Codex error: The usage limit has been reached",
    limited: "openai-codex/gpt-6-luna:low", other: `${HAIKU}:low`, reason: "provider out of usage", holdsUntil: "2026-09-26T17:00:00.000Z", retried: false },
  { label: "Anthropic out of extra usage", tiers: TEST_TIERS, error: "You're out of extra usage.",
    limited: `${HAIKU}:low`, other: "openai-codex/gpt-6-luna:low", reason: "provider out of usage", holdsUntil: "2026-09-26T17:00:00.000Z", retried: false },
  { label: "an Anthropic 429 rate limit", tiers: TEST_TIERS, error: ANTHROPIC_RATE_LIMIT,
    limited: `${HAIKU}:low`, other: "openai-codex/gpt-6-luna:low", reason: "provider throttled", holdsUntil: "2026-09-26T12:05:00.000Z", retried: true },
  // A stand-in text too: pi-ai turns a Codex HTTP 429 into the usage-limit text above.
  { label: "a rate limit that says when to try again", tiers: CODEX_FIRST, error: CODEX_RATE_LIMIT,
    limited: "openai-codex/gpt-6-luna:low", other: `${HAIKU}:low`, reason: "provider throttled", holdsUntil: "2026-09-26T12:00:20.000Z", retried: true },
] as const;

for (const { label, tiers, error, limited, other, reason, holdsUntil, retried } of LIMIT_ERROR_CASES) {
  test(`${label} keeps the provider out of routing until ${holdsUntil}`, async () => {
    const h = harness({ ...LIVE, tiers });
    try {
      const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("limited-worker");
      assert.equal((await worker.user()).rung, limited);
      await worker.fail(error);

      const justBefore = new Date(Date.parse(holdsUntil) - 1_000);
      assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([]), { now: () => justBefore }), FIX_README, "before-worker")).rung, other);
      assert.deepEqual(removedRungs(h, "before-worker").map(([rung, why]) => [rung, why]), [[limited, reason]]);
      assert.match(removedRungs(h, "before-worker")[0]?.[2] ?? "", new RegExp(`until ${holdsUntil.replaceAll(".", "\\.")}`));

      const back = await loadAutoModel(h, fakeSessionRegistry([]), { now: () => new Date(holdsUntil) });
      assert.equal((await firstRequest(back, FIX_README, "after-worker")).rung, limited);
    } finally { h.cleanup(); }
  });

  // pi retries a rate limit; a usage limit it never retries fails over through the worker runtime's continue.
  test(`${label} on a first request before any output fails over to ${other}`, async () => {
    const h = harness({ ...LIVE, tiers });
    try {
      const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("limited-worker");
      await worker.user();
      assert.equal((retried ? await worker.retry(error) : await worker.continueAfter(error)).rung, other);
      assert.deepEqual(worker.rungs, [limited, other]);
    } finally { h.cleanup(); }
  });
}

test("an error that is no limit leaves the provider in routing", async () => {
  const h = harness(LIVE);
  try {
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("failed-worker");
    await worker.user();
    await worker.fail('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}');
    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "next-worker")).rung, "openai-codex/gpt-6-luna:low");
    assert.deepEqual(removedRungs(h, "next-worker"), []);
  } finally { h.cleanup(); }
});

/** A folder where the usage store should be: every usage-store write fails. */
function blockUsageStore(h: Harness): void {
  mkdirSync(join(h.stateDir, "usage-observations.json", "in-the-way"), { recursive: true });
}

test("a usage observation the store cannot save warns once, keeps routing on, and this process still avoids the provider", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    blockUsageStore(h);
    const rungs: string[] = [];
    const stderr = await stderrOf(async () => {
      const auto = await loadAutoModel(h, fakeSessionRegistry([]));
      const worker = auto.worker("limited-worker");
      rungs.push((await worker.user()).rung);
      await worker.fail(CODEX_USAGE_LIMIT, "working");
      // The pinned worker's next request hits the limit again: a second failed write, no second line.
      rungs.push((await worker.user()).rung);
      await worker.fail(CODEX_USAGE_LIMIT, "working");
      rungs.push((await firstRequest(auto, FIX_README, "next-worker")).rung);
    });
    const lines = stderr.split("\n").filter(Boolean);
    assert.equal(lines.length, 1, stderr);
    assert.equal(lines[0]!.replace(/: [A-Z]+: .*?\. Routing/, ": <error>. Routing"),
      "pi-orchestrator router warning: could not save the usage observation for openai-codex (exhausted until 2026-09-26T12:42:00.000Z) " +
      `in ${join(h.stateDir, "usage-observations.json")}: <error>. Routing in this process still avoids openai-codex; ` +
      "other sessions don't see it until a later write succeeds.");
    assert.deepEqual(rungs, ["openai-codex/gpt-6-luna:low", "openai-codex/gpt-6-luna:low", `${HAIKU}:low`],
      "the unsaved observation still removes openai-codex from the next routing");
    const record = h.records().find((entry) => entry.delegationId === "next-worker");
    assert.ok(record?.recordType === "decision" && record.mode === "live" && record.route.outcome === "chosen", "routing stays on");
    assert.deepEqual(removedRungs(h, "next-worker").map(([rung, why]) => [rung, why]), [["openai-codex/gpt-6-luna:low", "provider out of usage"]]);
  } finally { h.cleanup(); }
});

test("a first-request quota error whose observation the store cannot save still fails over", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    blockUsageStore(h);
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("failover-worker");
    await worker.user();
    await stderrOf(() => worker.continueAfter(CODEX_USAGE_LIMIT));
    assert.deepEqual(worker.rungs, ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`]);
  } finally { h.cleanup(); }
});

test("a first-request rate limit whose observation the store cannot save still fails over", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    blockUsageStore(h);
    let rungs: readonly string[] = [];
    const stderr = await stderrOf(async () => {
      const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("failover-worker");
      await worker.user();
      await worker.retry(CODEX_RATE_LIMIT);
      rungs = worker.rungs;
    });
    assert.deepEqual(rungs, ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`]);
    assert.deepEqual(recordsOf(h, "failover-worker").map((record) => record.recordType), ["decision", "failover", "decision"]);
    assert.match(stderr, /^pi-orchestrator router warning: could not save the usage observation for openai-codex /);
    assert.doesNotMatch(stderr, /router disabled/);
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
  const codex = (await loadAutoModel(h, fakeSessionRegistry([]), {}, { cwd: projectWithMechanicalTier(h, "codex-project", ["openai-codex/gpt-6-luna:low"]) })).worker("codex-worker");
  const anthropic = (await loadAutoModel(h, fakeSessionRegistry([]), {}, { cwd: projectWithMechanicalTier(h, "anthropic-project", [`${HAIKU}:low`]) })).worker("anthropic-worker");
  assert.deepEqual((await Promise.all([codex.user(), anthropic.user()])).map((routed) => routed.rung), ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`]);
  await Promise.all([codex.fail(CODEX_USAGE_LIMIT, "working"), anthropic.fail("You're out of extra usage.", "working")]);
}

test("with every provider exhausted a worker is refused with the reset times, and nothing is routed or recorded for it", async () => {
  const h = harness(LIVE);
  try {
    await exhaustBothProviders(h);
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    await assert.rejects(firstRequest(auto, FIX_README, "refused-worker"), { message: "routing refused this worker, and its fallback, the orchestrator session model " +
      `anthropic/claude-haiku-4-5:medium, is on anthropic, which is out of usage. Usage limits: ${BOTH_EXHAUSTED}. No worker request was sent.` });
    assert.equal(h.records().some((record) => record.delegationId === "refused-worker"), false);
  } finally { h.cleanup(); }
});

test("after a refusal the session-model fallback runs only while its provider is not exhausted", async () => {
  const codexOnly = { mechanical: ["openai-codex/gpt-6-luna:low"], standard: ["openai-codex/gpt-6-sol:medium"],
    elevated: ["openai-codex/gpt-6-sol:high"], critical: ["openai-codex/gpt-6-sol:xhigh"] };
  const h = harness({ ...LIVE, tiers: codexOnly });
  try {
    const codex = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("codex-worker");
    await codex.user();
    await codex.fail(CODEX_USAGE_LIMIT);

    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "fallback-worker")).rung, `${HAIKU}:medium`,
      "the anthropic session model still has usage");
    const record = h.records().find((entry) => entry.delegationId === "fallback-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "refused");
    assert.deepEqual([...new Set(record.route.removed.map((removed) => removed.reason))], ["provider out of usage"]);
    assert.equal(record.ranOn, `${HAIKU}:medium`);

    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = "openai-codex/gpt-6-sol:medium";
    await assert.rejects(firstRequest(auto, FIX_README, "skipped-fallback-worker"), { message: "routing refused this worker, and its fallback, the orchestrator " +
      "session model openai-codex/gpt-6-sol:medium, is on openai-codex, which is out of usage. Usage limits: openai-codex: exhausted until " +
      "2026-09-26T12:42:00.000Z, from a limit error at 2026-09-26T12:00:00.000Z. No worker request was sent." });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Failover on the first request (PRD cml8, "Failover"; spec 23b3): a limit
// error on a worker's first request, before the rung produced anything,
// reaches route as pi's retry, which pins the worker again to the next
// surviving rung on another provider, once. A limit later in the run stays on
// the pin, where pi retries it. Both record a usage observation.
// ---------------------------------------------------------------------------

/** The records of `delegationId`, in file order. */
function recordsOf(h: Harness, delegationId: string): RoutingRecord[] {
  return h.records().filter((record) => record.delegationId === delegationId);
}

test("a first request answered with a rate limit pins the worker again to the other provider, records the failover linked to the refused attempt, and later routing avoids the provider", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const worker = auto.worker("failover-worker");
    const refusedRoute = await worker.user();
    const failedOver = await worker.retry(CODEX_RATE_LIMIT);
    assert.deepEqual(worker.rungs, ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`]);
    assert.notEqual(failedOver.state, refusedRoute.state, "the new pin is stored in router state");

    const [refused, failover, chosen, ...rest] = recordsOf(h, "failover-worker");
    assert.deepEqual(rest, []);
    assert.ok(refused?.recordType === "decision" && refused.route.outcome === "chosen");
    assert.equal(refused.route.rung.rung, "openai-codex/gpt-6-luna:low", "the refused attempt's decision names the rung it tried");
    assert.equal(refused.ranOn, "openai-codex/gpt-6-luna:low");
    assert.ok(failover?.recordType === "failover");
    assert.deepEqual(failover.refusedAttempt, { timestamp: refused.timestamp, rung: "openai-codex/gpt-6-luna:low" });
    assert.equal(failover.limit, "throttled");
    assert.equal(failover.resetsAt, "2026-09-26T12:00:20.000Z");
    assert.equal(failover.detail, CODEX_RATE_LIMIT);
    assert.equal(failover.rung, `${HAIKU}:low`);
    assert.ok(chosen?.recordType === "decision" && chosen.route.outcome === "chosen");
    assert.equal(chosen.route.rung.rung, `${HAIKU}:low`);
    assert.equal(chosen.ranOn, `${HAIKU}:low`);
    assert.deepEqual(chosen.route.removed.map((removed) => [removed.rung, removed.reason]), [["openai-codex/gpt-6-luna:low", "provider throttled"]]);
    // The routing report reads the failover and counts one delegation, on the rung it ran on.
    const report = buildRoutingReport(join(h.stateDir, "routing"));
    assert.equal(report.totals.decisions, 1);
    assert.deepEqual(report.rows.map((row) => [row.tier, row.rung, row.decisions]), [["mechanical", `${HAIKU}:low`, 1]]);

    // Later requests of the same worker stay on the rung it failed over to.
    worker.answered();
    assert.equal((await worker.continuation()).rung, `${HAIKU}:low`);
    assert.equal((await worker.user()).rung, `${HAIKU}:low`);

    // The throttled observation steers the next routing, from another session.
    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "next-worker")).rung, `${HAIKU}:low`);
    const [removed] = removedRungs(h, "next-worker");
    assert.deepEqual(removed?.slice(0, 2), ["openai-codex/gpt-6-luna:low", "provider throttled"]);
    assert.match(removed?.[2] ?? "", /throttled until 2026-09-26T12:00:20\.000Z/);
  } finally { h.cleanup(); }
});

test("a first request answered with a usage-limit error pins the worker again to the other provider and records the failover", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("failover-worker");
    const refusedRoute = await worker.user();
    const moved = await worker.continueAfter(CODEX_USAGE_LIMIT);
    assert.deepEqual(worker.rungs, ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`]);
    assert.notEqual(moved.state, refusedRoute.state, "the new pin is stored in router state");
    assert.equal((moved.state as { failedOver?: boolean }).failedOver, true);
    const records = recordsOf(h, "failover-worker");
    assert.deepEqual(records.map((record) => record.recordType), ["decision", "failover", "decision"]);
    const failover = records.find((record) => record.recordType === "failover");
    assert.ok(failover?.recordType === "failover");
    assert.deepEqual([failover.limit, failover.resetsAt, failover.detail], ["exhausted", "2026-09-26T12:42:00.000Z", CODEX_USAGE_LIMIT]);
    assert.deepEqual(failover.refusedAttempt, { timestamp: records[0]!.timestamp, rung: "openai-codex/gpt-6-luna:low" });
    // Later requests stay on the new pin, and the observation steers other workers.
    worker.answered();
    assert.equal((await worker.continuation()).rung, `${HAIKU}:low`);
    assert.equal(readUsageObservations(usageObservationsPath(h.stateDir))["openai-codex"]?.state, "exhausted");
  } finally { h.cleanup(); }
});

test("a worker fails over after a quota error only once, and a failover request after its first answer or for another rung than its pin sends nothing", async () => {
  const tiers = { ...TEST_TIERS, mechanical: ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`, "openai-codex/gpt-6-sol:medium"] };
  const h = harness({ ...LIVE, tiers });
  try {
    const auto = await loadAutoModel(h, fakeSessionRegistry([]));
    const twice = auto.worker("twice-limited-worker");
    await twice.user();
    await twice.continueAfter(CODEX_USAGE_LIMIT);
    await assert.rejects(twice.continueAfter("You're out of extra usage."), /no other provider's rung is left.*out of extra usage/);
    assert.deepEqual(twice.rungs, ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`]);
    assert.deepEqual(recordsOf(h, "twice-limited-worker").map((record) => record.recordType), ["decision", "failover", "decision"]);
  } finally { h.cleanup(); }
  // A fresh usage store: the first worker left both providers exhausted.
  const h2 = harness({ ...LIVE, tiers });
  try {
    const auto = await loadAutoModel(h2, fakeSessionRegistry([]));
    const answered = auto.worker("answered-worker");
    await answered.user();
    answered.answered();
    await answered.continuation();
    await assert.rejects(answered.continueAfter(CODEX_USAGE_LIMIT), /no other provider's rung is left/);
    assert.deepEqual(recordsOf(h2, "answered-worker").map((record) => record.recordType), ["decision"]);

    // A request for another rung than the pin is not the pin's failure.
    const other = auto.worker("mismatched-worker");
    await other.user();
    const withdraw = requestFailover("mismatched-worker", { model: "openai-codex/gpt-6-not-the-pin", errorMessage: CODEX_USAGE_LIMIT });
    try { await assert.rejects(other.user(), /no other provider's rung is left/); } finally { withdraw(); }
    assert.deepEqual(recordsOf(h2, "mismatched-worker").map((record) => record.recordType), ["decision"]);
  } finally { h2.cleanup(); }
});

test("a failed-over worker's delegation counts for the provider it ran on once the throttle lifts", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("throttled-worker");
    await worker.user();
    await worker.retry(CODEX_RATE_LIMIT);
    const failover = recordsOf(h, "throttled-worker").find((record) => record.recordType === "failover");
    assert.ok(failover?.recordType === "failover");
    assert.deepEqual([failover.limit, failover.resetsAt, failover.rung], ["throttled", "2026-09-26T12:00:20.000Z", `${HAIKU}:low`]);

    // Once the throttle lifts, both providers survive: the failed-over
    // delegation counts for anthropic, where it ran, so codex is chosen.
    const next = await loadAutoModel(h, fakeSessionRegistry([]), { now: () => new Date("2026-09-26T12:00:20.000Z") });
    assert.equal((await firstRequest(next, FIX_README, "after-throttle-worker")).rung, "openai-codex/gpt-6-luna:low");
    const [record] = recordsOf(h, "after-throttle-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.deepEqual(record.route.providerCounts, { "openai-codex": 0, anthropic: 1 });
  } finally { h.cleanup(); }
});

test("a limit after the rung's first output, on a later request, or on the rung a worker failed over to stays on the pin for pi's retry, records no failover and still records the observation", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    // After output on the first request.
    const midStream = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("mid-stream-worker");
    await midStream.user();
    assert.equal((await midStream.retry(CODEX_RATE_LIMIT, "working")).rung, "openai-codex/gpt-6-luna:low");
    assert.deepEqual(recordsOf(h, "mid-stream-worker").map((record) => record.recordType), ["decision"]);

    // On a later request of a pinned worker.
    const later = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("later-worker");
    assert.equal((await later.user()).rung, `${HAIKU}:low`);
    later.answered();
    await later.continuation();
    assert.equal((await later.retry(ANTHROPIC_RATE_LIMIT)).rung, `${HAIKU}:low`, "the retry stays on the pinned rung");
    assert.equal((await later.retry(ANTHROPIC_RATE_LIMIT)).rung, `${HAIKU}:low`, "and so do pi's further retries");
    assert.deepEqual(recordsOf(h, "later-worker").map((record) => record.recordType), ["decision"]);

    // Both limits are observations the next routing reads: with both
    // providers throttled it refuses and falls back to the session model.
    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "next-worker")).rung, `${HAIKU}:medium`);
    const [record] = recordsOf(h, "next-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "refused");
    assert.deepEqual([...new Set(record.route.removed.map((removed) => removed.reason))], ["provider throttled"]);
  } finally { h.cleanup(); }
});

test("a worker fails over once: a limit on the first request of the rung it failed over to stays there", async () => {
  const tiers = { ...TEST_TIERS, mechanical: ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`, "openai-codex/gpt-6-sol:medium"] };
  const h = harness({ ...LIVE, tiers });
  try {
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("twice-limited-worker");
    await worker.user();
    await worker.retry(CODEX_RATE_LIMIT);
    assert.equal((await worker.retry(ANTHROPIC_RATE_LIMIT)).rung, `${HAIKU}:low`);
    assert.deepEqual(worker.rungs, ["openai-codex/gpt-6-luna:low", `${HAIKU}:low`, `${HAIKU}:low`]);
    assert.deepEqual(recordsOf(h, "twice-limited-worker").map((record) => record.recordType), ["decision", "failover", "decision"]);
  } finally { h.cleanup(); }
});

test("a first-request quota error with no other provider's rung left fails the worker with the limit error and records no failover", async () => {
  const codexOnly = { mechanical: ["openai-codex/gpt-6-luna:low", "openai-codex/gpt-6-sol:medium"], standard: ["openai-codex/gpt-6-sol:medium"],
    elevated: ["openai-codex/gpt-6-sol:high"], critical: ["openai-codex/gpt-6-sol:xhigh"] };
  const h = harness({ ...LIVE, tiers: codexOnly });
  try {
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("stuck-worker");
    await worker.user();
    await assert.rejects(worker.continueAfter(CODEX_USAGE_LIMIT), { message: `no other provider's rung is left to fail over to: ${CODEX_USAGE_LIMIT}` });
    assert.deepEqual(worker.rungs, ["openai-codex/gpt-6-luna:low"], "no request goes to the exhausted provider again");
    assert.deepEqual(recordsOf(h, "stuck-worker").map((record) => record.recordType), ["decision"]);
    assert.equal(readUsageObservations(usageObservationsPath(h.stateDir))["openai-codex"]?.state, "exhausted");
  } finally { h.cleanup(); }
});

test("a first-request rate limit with no other provider's rung left stays on the pin for pi's retries and records no failover", async () => {
  const codexOnly = { mechanical: ["openai-codex/gpt-6-luna:low", "openai-codex/gpt-6-sol:medium"], standard: ["openai-codex/gpt-6-sol:medium"],
    elevated: ["openai-codex/gpt-6-sol:high"], critical: ["openai-codex/gpt-6-sol:xhigh"] };
  const h = harness({ ...LIVE, tiers: codexOnly });
  try {
    const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("stuck-worker");
    await worker.user();
    await worker.retry(CODEX_RATE_LIMIT);
    await worker.retry(CODEX_RATE_LIMIT);
    assert.deepEqual(worker.rungs, ["openai-codex/gpt-6-luna:low", "openai-codex/gpt-6-luna:low", "openai-codex/gpt-6-luna:low"],
      "the same provider's next rung is not tried");
    const records = recordsOf(h, "stuck-worker");
    assert.deepEqual(records.map((record) => record.recordType), ["decision"]);
    assert.ok(records[0]?.recordType === "decision");
    assert.equal(records[0].ranOn, "openai-codex/gpt-6-luna:low");
  } finally { h.cleanup(); }
});

test("shadow mode and a resumed pin never fail over", async () => {
  for (const [name, routing] of [["shadow", { ...SHADOW, tiers: CODEX_FIRST }], ["resumed", { ...LIVE, tiers: CODEX_FIRST }]] as const) {
    const h = harness(routing);
    try {
      // A resumed worker's branch holds the pin its first request stored, in an earlier process.
      const saved = name === "resumed" ? (await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "no-failover-worker")).state : undefined;
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = "openai-codex/gpt-6-sol:medium";
      const worker = (await loadAutoModel(h, fakeSessionRegistry([]))).worker("no-failover-worker", FIX_README, saved);
      const first = await worker.user();
      assert.equal((await worker.retry(CODEX_RATE_LIMIT)).rung, first.rung, name);
      assert.equal(h.records().filter((record) => record.recordType === "failover").length, 0, name);
    } finally { h.cleanup(); }
  }
});

// ---------------------------------------------------------------------------
// Low usage in balancing (PRD cml8, story 51): a provider the usage store
// holds under 10% left for counts extra use in a balanced tier. It is never
// removed, and the weight lapses when the window it was read for resets.
// ---------------------------------------------------------------------------

async function observe(h: Harness, provider: string, observation: UsageObservation): Promise<void> {
  await recordUsageObservation(usageObservationsPath(h.stateDir), provider, observation);
}

const CODEX_LOW = { state: "low", percentLeft: 8, resetsAt: "2026-09-26T13:00:00.000Z", observedAt: "2026-09-26T11:59:00.000Z", source: "header" } as const;

test("a stored low percentage shifts a balanced choice to the other provider and the decision record names it", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    await seedDecision(h, "earlier-anthropic", NOW, "live");
    await observe(h, "openai-codex", CODEX_LOW);
    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "weighted-worker")).rung, `${HAIKU}:low`,
      "codex counts 0 + 5 against anthropic's 1");
    const [record] = recordsOf(h, "weighted-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.deepEqual(record.route.providerCounts, { "openai-codex": 0, anthropic: 1 });
    assert.deepEqual(record.route.lowUsageProviders, ["openai-codex"]);
    assert.deepEqual(record.route.removed, [], "a low provider is not filtered");
  } finally { h.cleanup(); }
});

test("a low provider is still chosen when the other is used far more, and the weight lapses at the stated reset", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    for (let index = 0; index < 6; index += 1) await seedDecision(h, `anthropic-${index}`, NOW, "live");
    await observe(h, "openai-codex", CODEX_LOW);
    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "busy-worker")).rung, "openai-codex/gpt-6-luna:low",
      "codex 0 + 5 is still below anthropic's 6");

    const h2 = harness({ ...LIVE, tiers: CODEX_FIRST });
    try {
      await seedDecision(h2, "earlier-anthropic", NOW, "live");
      await observe(h2, "openai-codex", CODEX_LOW);
      const afterReset = await loadAutoModel(h2, fakeSessionRegistry([]), { now: () => new Date(CODEX_LOW.resetsAt) });
      assert.equal((await firstRequest(afterReset, FIX_README, "after-reset-worker")).rung, "openai-codex/gpt-6-luna:low");
      const [record] = recordsOf(h2, "after-reset-worker");
      assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
      assert.equal(record.route.lowUsageProviders, undefined);
    } finally { h2.cleanup(); }
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Quota headers (PRD cml8, story 50): pi hands every provider response's
// status and headers to the session's after_provider_response handlers,
// which do not say which provider answered. The router attributes them to the
// request in flight: the physical model a worker's request on the auto model
// was routed to, or the model of the session's own request. They add a
// percentage left to the usage store.
//
// The first tests replay the sanitized captures of ticket 12
// (src/fixtures/usage, bean pi-orchestrator-ugoi): every `response` record's
// status and headers, as captured. They are all 200 responses far from a
// limit; no limit or error response has been captured yet.
// ---------------------------------------------------------------------------

const USAGE_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "usage");

interface CapturedRecord { readonly kind: string; readonly status?: number; readonly headers?: Record<string, string> }

/** The records of one captured case, read line by line as the fixture README says. */
function capturedRecords(file: string): CapturedRecord[] {
  return readFileSync(join(USAGE_FIXTURES, file), "utf8").split("\n").filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CapturedRecord);
}

/** The status and headers of each captured `response` record. */
function capturedResponses(file: string): { status: number; headers: Record<string, string> }[] {
  return capturedRecords(file).filter((record) => record.kind === "response")
    .map((record) => ({ status: record.status!, headers: record.headers! }));
}

/** A worker's request on the auto model as pi runs it: routed, then sent,
 *  with before_provider_request and, when the provider answered with
 *  `response`, after_provider_response in the worker's session. */
async function workerRequest(auto: AutoModel, h: Harness, sessionId: string, registry: SessionModelRegistry,
  response?: { status: number; headers: Record<string, string> }): Promise<Routed> {
  const routed = await firstRequest(auto, FIX_README, sessionId);
  const ctx = workerContext(h, sessionId, registry);
  await auto.handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
  if (response !== undefined) await auto.handlers.get("after_provider_response")?.({ type: "after_provider_response", ...response }, ctx);
  return routed;
}

function storedObservations(h: Harness) {
  return readUsageObservations(usageObservationsPath(h.stateDir));
}

test("captured Anthropic shaped-path headers on a worker's rung store anthropic's percentage left from the tighter window", async () => {
  const h = harness(LIVE);
  try {
    const [response, ...more] = capturedResponses("anthropic/shaped-ok.jsonl");
    assert.equal(more.length, 0, "the capture has one response record");
    const registry = fakeSessionRegistry([]);
    const auto = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call });
    assert.equal((await workerRequest(auto, h, "anthropic-worker", registry, response)).rung, `${HAIKU}:low`);
    // 5h utilization 0.05 is 95% left, 7d 0.39 is 61% left; the 7d window resets 2026-10-04T04:00:00Z.
    assert.deepEqual(storedObservations(h), { anthropic: { state: "available", percentLeft: 61, resetsAt: "2026-10-04T04:00:00.000Z",
      observedAt: NOW.toISOString(), source: "header" } });
  } finally { h.cleanup(); }
});

test("captured Codex SSE headers on a worker's rung store openai-codex's percentage left, not the auto model's provider", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const [response, ...more] = capturedResponses("openai-codex/sse-ok.jsonl");
    assert.equal(more.length, 0, "the capture has one response record");
    const registry = fakeSessionRegistry([]);
    const auto = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call });
    assert.equal((await workerRequest(auto, h, "codex-worker", registry, response)).rung, "openai-codex/gpt-6-luna:low");
    // Primary (300 min) 2% used is 98% left, secondary (10080 min) 37% used is 63% left, resetting 2026-10-05T09:47:17Z.
    assert.deepEqual(storedObservations(h), { "openai-codex": { state: "available", percentLeft: 63, resetsAt: "2026-10-05T09:47:17.000Z",
      observedAt: NOW.toISOString(), source: "header" } });
  } finally { h.cleanup(); }
});

test("the captured Codex WebSocket case has no response record, so a worker on it adds nothing to the usage store", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const records = capturedRecords("openai-codex/websocket-ok.jsonl");
    assert.deepEqual(records.map((record) => record.kind), ["session", "request", "result"]);
    const registry = fakeSessionRegistry([]);
    const auto = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call });
    await workerRequest(auto, h, "websocket-worker", registry);
    assert.deepEqual(storedObservations(h), {});
  } finally { h.cleanup(); }
});

test("captured headers of the session's own request are attributed to the model that request was sent with", async () => {
  const h = harness(LIVE);
  try {
    const [response] = capturedResponses("anthropic/shaped-ok.jsonl");
    const registry = fakeSessionRegistry([]);
    const { handlers } = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call });
    const ctx = { cwd: h.projectDir, hasUI: false, model: { provider: "anthropic", id: "claude-haiku-4-5" }, modelRegistry: registry,
      thinkingLevel: "medium", sessionManager: { getSessionId: () => "parent" } } as unknown as ExtensionContext;
    await handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: { model: "claude-haiku-4-5" } }, ctx);
    // The owner switches models while the request is in flight: the response still belongs to anthropic.
    const switched = { ...ctx, model: { provider: "openai-codex", id: "gpt-6-sol" } } as unknown as ExtensionContext;
    await handlers.get("after_provider_response")?.({ type: "after_provider_response", ...response! }, switched);
    assert.deepEqual(Object.keys(storedObservations(h)), ["anthropic"]);
    assert.equal(storedObservations(h).anthropic?.percentLeft, 61);
  } finally { h.cleanup(); }
});

test("a session that leaves the auto model for a physical one attributes its own response to that model, not its last routed rung", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const [response] = capturedResponses("anthropic/shaped-ok.jsonl");
    const registry = fakeSessionRegistry([]);
    const auto = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call });
    assert.equal((await workerRequest(auto, h, "switching-worker", registry)).rung, "openai-codex/gpt-6-luna:low");
    const own = { ...workerContext(h, "switching-worker", registry), model: SESSION_MODEL } as unknown as ExtensionContext;
    await auto.handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, own);
    await auto.handlers.get("after_provider_response")?.({ type: "after_provider_response", ...response! }, own);
    assert.deepEqual(Object.keys(storedObservations(h)), ["anthropic"]);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// Quota headers, synthetic cases. These values were NOT captured: ticket 12
// saw only 200 responses at 2% to 39% used. They check the reader's own
// rules (under 10% left, boundaries, malformed values, statuses it does not
// read, a live limit a success header must not clear) on the header names the
// captures showed. They say nothing about what a provider sends near a limit.
// ---------------------------------------------------------------------------

/** The captured Anthropic headers with some values replaced (synthetic). */
function anthropicHeaders(overrides: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string | undefined> = { ...capturedResponses("anthropic/shaped-ok.jsonl")[0]!.headers, ...overrides };
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** The captured Codex SSE headers with some values replaced (synthetic). */
function codexHeaders(overrides: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string | undefined> = { ...capturedResponses("openai-codex/sse-ok.jsonl")[0]!.headers, ...overrides };
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** Runs one worker whose rung answers with `response`, at `now`, and returns the store. */
async function workerWithResponse(h: Harness, sessionId: string, response: { status: number; headers: Record<string, string> },
  now: Date = NOW) {
  const registry = fakeSessionRegistry([]);
  const auto = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call, now: () => now });
  await workerRequest(auto, h, sessionId, registry, response);
  return { observations: storedObservations(h) };
}

test("synthetic: a Codex window under 10% left is stored low, and the next routing weighs openai-codex", async () => {
  const h = harness({ ...LIVE, tiers: CODEX_FIRST });
  try {
    const { observations } = await workerWithResponse(h, "codex-worker", { status: 200, headers: codexHeaders({ "x-codex-primary-used-percent": "93" }) });
    assert.deepEqual(observations["openai-codex"], { state: "low", percentLeft: 7, resetsAt: "2026-09-29T13:14:09.000Z",
      observedAt: NOW.toISOString(), source: "header" });
    // codex has 1 pinned delegation + 5 for low usage; anthropic none.
    assert.equal((await firstRequest(await loadAutoModel(h, fakeSessionRegistry([])), FIX_README, "next-worker")).rung, `${HAIKU}:low`);
    const [record] = recordsOf(h, "next-worker");
    assert.ok(record?.recordType === "decision" && record.route.outcome === "chosen");
    assert.deepEqual(record.route.lowUsageProviders, ["openai-codex"]);
  } finally { h.cleanup(); }
});

const BOUNDARY_CASES = [
  { label: "Anthropic utilization 0.9 is exactly 10% left: available", headers: () => anthropicHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.9" }),
    tiers: TEST_TIERS, provider: "anthropic", expected: { state: "available", percentLeft: 10, resetsAt: "2026-10-04T04:00:00.000Z" } },
  { label: "Anthropic utilization 0.905 is 9.5% left: low", headers: () => anthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.905" }),
    tiers: TEST_TIERS, provider: "anthropic", expected: { state: "low", percentLeft: 9.5, resetsAt: "2026-09-29T11:50:00.000Z" } },
  { label: "Anthropic utilization 1 is 0% left: low, never exhausted from a success header",
    headers: () => anthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "1" }),
    tiers: TEST_TIERS, provider: "anthropic", expected: { state: "low", percentLeft: 0, resetsAt: "2026-09-29T11:50:00.000Z" } },
  { label: "Codex 90% used is exactly 10% left: available", headers: () => codexHeaders({ "x-codex-secondary-used-percent": "90" }),
    tiers: CODEX_FIRST, provider: "openai-codex", expected: { state: "available", percentLeft: 10, resetsAt: "2026-10-05T09:47:17.000Z" } },
  { label: "Codex 100% used is 0% left: low", headers: () => codexHeaders({ "x-codex-primary-used-percent": "100" }),
    tiers: CODEX_FIRST, provider: "openai-codex", expected: { state: "low", percentLeft: 0, resetsAt: "2026-09-29T13:14:09.000Z" } },
  { label: "a malformed window is skipped and the other window still counts",
    headers: () => codexHeaders({ "x-codex-secondary-used-percent": "lots" }),
    tiers: CODEX_FIRST, provider: "openai-codex", expected: { state: "available", percentLeft: 98, resetsAt: "2026-09-29T13:14:09.000Z" } },
  { label: "a malformed reset leaves the percentage without a reset",
    headers: () => anthropicHeaders({ "anthropic-ratelimit-unified-7d-reset": "soon" }),
    tiers: TEST_TIERS, provider: "anthropic", expected: { state: "available", percentLeft: 61 } },
] as const;

for (const { label, headers, tiers, provider, expected } of BOUNDARY_CASES) {
  test(`synthetic: ${label}`, async () => {
    const h = harness({ ...LIVE, tiers });
    try {
      const { observations } = await workerWithResponse(h, "boundary-worker", { status: 200, headers: headers() });
      assert.deepEqual(observations, { [provider]: { ...expected, observedAt: NOW.toISOString(), source: "header" } });
    } finally { h.cleanup(); }
  });
}

const NOTHING_STORED_CASES = [
  { label: "Anthropic utilization above 1", headers: () => anthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "1.2",
    "anthropic-ratelimit-unified-7d-utilization": "-0.1" }), tiers: TEST_TIERS },
  { label: "Anthropic utilization that is no number", headers: () => anthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "",
    "anthropic-ratelimit-unified-7d-utilization": "0.39%" }), tiers: TEST_TIERS },
  { label: "Codex used percent above 100 or below 0", headers: () => codexHeaders({ "x-codex-primary-used-percent": "101",
    "x-codex-secondary-used-percent": "-1" }), tiers: CODEX_FIRST },
  { label: "no quota headers at all", headers: () => ({ "content-type": "text/event-stream" }), tiers: TEST_TIERS },
] as const;

for (const { label, headers, tiers } of NOTHING_STORED_CASES) {
  test(`synthetic: ${label} stores nothing`, async () => {
    const h = harness({ ...LIVE, tiers });
    try {
      assert.deepEqual((await workerWithResponse(h, "malformed-worker", { status: 200, headers: headers() })).observations, {});
    } finally { h.cleanup(); }
  });
}

test("synthetic: headers on a status other than 2xx are not read, since no limit response has been captured", async () => {
  const h = harness(LIVE);
  try {
    const low = anthropicHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.99", "anthropic-ratelimit-unified-status": "rejected" });
    assert.deepEqual((await workerWithResponse(h, "rejected-worker", { status: 429, headers: low })).observations, {});
  } finally { h.cleanup(); }
});

test("synthetic: a success header does not clear an exhausted limit from an error while it holds, and writes once it has lifted", async () => {
  const h = harness(LIVE);
  try {
    const limit = { state: "exhausted", resetsAt: "2026-09-26T12:30:00.000Z", observedAt: "2026-09-26T11:50:00.000Z", source: "error" } as const;
    await observe(h, "anthropic", limit);
    const response = { status: 200, headers: capturedResponses("anthropic/shaped-ok.jsonl")[0]!.headers };
    // Routing avoids anthropic, so the worker here runs on codex; the header arrives as if from a request still in flight on anthropic.
    const registry = fakeSessionRegistry([]);
    const { handlers } = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call });
    const ctx = { cwd: h.projectDir, hasUI: false, model: { provider: "anthropic", id: "claude-haiku-4-5" }, modelRegistry: registry,
      thinkingLevel: "medium", sessionManager: { getSessionId: () => "parent" } } as unknown as ExtensionContext;
    await handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
    await handlers.get("after_provider_response")?.({ type: "after_provider_response", ...response }, ctx);
    assert.deepEqual(storedObservations(h).anthropic, limit, "the limit stays while it holds");

    const lifted = await loadRouterWith(h, registry, { classifierCall: () => answering("mechanical").call, now: () => new Date(limit.resetsAt) });
    await lifted.handlers.get("before_provider_request")?.({ type: "before_provider_request", payload: {} }, ctx);
    await lifted.handlers.get("after_provider_response")?.({ type: "after_provider_response", ...response }, ctx);
    assert.deepEqual(storedObservations(h).anthropic, { state: "available", percentLeft: 61, resetsAt: "2026-10-04T04:00:00.000Z",
      observedAt: limit.resetsAt, source: "header" });
  } finally { h.cleanup(); }
});

test("synthetic: a later response with the same reading does not write the store again", async () => {
  const h = harness(LIVE);
  try {
    const response = { status: 200, headers: capturedResponses("anthropic/shaped-ok.jsonl")[0]!.headers };
    await workerWithResponse(h, "first-worker", response);
    const later = new Date(NOW.getTime() + 60_000);
    const { observations } = await workerWithResponse(h, "second-worker", response, later);
    assert.equal(observations.anthropic?.observedAt, NOW.toISOString(), "the unchanged reading keeps its first observation");
    const changed = await workerWithResponse(h, "third-worker",
      { status: 200, headers: anthropicHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.4" }) }, later);
    assert.deepEqual([changed.observations.anthropic?.percentLeft, changed.observations.anthropic?.observedAt], [60, later.toISOString()]);
  } finally { h.cleanup(); }
});
