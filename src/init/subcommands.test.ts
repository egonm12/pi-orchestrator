import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, type EventBus, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { commandDescription, commandUsage, dispatchSubcommand, registerSubcommands, type CommandContext, type Subcommand } from "./subcommands.ts";

// `/pi-orchestrator <subcommand> [arguments]`: the first word picks the
// subcommand, which gets the rest. Anything else prints the usage.

interface Notice { readonly message: string; readonly type: string | undefined }

function uiCtx(notices: Notice[]): CommandContext {
  return { hasUI: true, ui: { notify: (message, type) => { notices.push({ message, type }); } } };
}

function recording(...names: string[]) {
  const calls: { name: string; rest: string; ctx: CommandContext }[] = [];
  const subcommands: Subcommand<CommandContext>[] = names.map((name) => ({
    name, summary: `does ${name}`,
    run: async (rest, ctx) => { calls.push({ name, rest, ctx }); },
  }));
  return { calls, subcommands };
}

test("the first word picks the subcommand, which gets the rest of the arguments", async () => {
  const { calls, subcommands } = recording("init", "budget");
  const notices: Notice[] = [];
  const ctx = uiCtx(notices);
  assert.deepEqual(await dispatchSubcommand("init", ctx, subcommands), []);
  await dispatchSubcommand("  budget   off  ", ctx, subcommands);
  await dispatchSubcommand("init extra words", ctx, subcommands);
  assert.deepEqual(calls.map(({ name, rest }) => [name, rest]), [["init", ""], ["budget", "off"], ["init", "extra words"]]);
  assert.equal(calls[0]!.ctx, ctx, "the subcommand gets the command's context");
  assert.deepEqual(notices, []);
});

test("an unknown subcommand runs nothing and prints the usage listing every subcommand", async () => {
  const { calls, subcommands } = recording("init", "budget");
  const notices: Notice[] = [];
  const lines = await dispatchSubcommand("gate high", uiCtx(notices), subcommands);
  assert.deepEqual(calls, []);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.type, "warning");
  assert.deepEqual(lines, [notices[0]!.message]);
  assert.equal(notices[0]!.message, [
    "pi-orchestrator: unknown subcommand 'gate'.",
    "usage: /pi-orchestrator <subcommand>",
    "  init: does init",
    "  budget: does budget",
  ].join("\n"));
});

test("a subcommand's name is matched exactly", async () => {
  const { calls, subcommands } = recording("init");
  const notices: Notice[] = [];
  await dispatchSubcommand("INIT", uiCtx(notices), subcommands);
  await dispatchSubcommand("initialise", uiCtx(notices), subcommands);
  assert.deepEqual(calls, []);
  assert.deepEqual(notices.map((notice) => notice.message.split("\n", 1)[0]),
    ["pi-orchestrator: unknown subcommand 'INIT'.", "pi-orchestrator: unknown subcommand 'initialise'."]);
});

test("no subcommand prints the usage alone", async () => {
  const { calls, subcommands } = recording("init");
  const notices: Notice[] = [];
  await dispatchSubcommand("   ", uiCtx(notices), subcommands);
  assert.deepEqual(calls, []);
  assert.deepEqual(notices, [{ message: "usage: /pi-orchestrator <subcommand>\n  init: does init", type: "warning" }]);
  assert.equal(commandUsage(subcommands), notices[0]!.message);
});

test("without a UI the usage goes to stderr", async () => {
  const { subcommands } = recording("init");
  const written: string[] = [];
  const write = process.stderr.write;
  process.stderr.write = ((chunk: string) => { written.push(chunk); return true; }) as typeof process.stderr.write;
  let lines: string[];
  try { lines = await dispatchSubcommand("nope", { hasUI: false }, subcommands); } finally { process.stderr.write = write; }
  assert.deepEqual(written, [`${lines[0]}\n`]);
  assert.match(lines[0]!, /^pi-orchestrator: unknown subcommand 'nope'\.\nusage: \/pi-orchestrator <subcommand>\n {2}init: does init$/);
});

test("the command's description names every subcommand", () => {
  const { subcommands } = recording("init", "budget");
  assert.equal(commandDescription(subcommands), "pi-orchestrator: init (does init), budget (does budget)");
});

// Several pi-orchestrator extensions add subcommands to the one
// `/pi-orchestrator` command. They find each other on the session's event
// bus: the first to register hosts the command, the others join it, so the
// command holds whatever extensions are loaded, in any order.

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

/** An extension's view of pi: the session's bus and its own command registrations. */
function extensionPi(events: EventBus | undefined, commands: Map<string, CommandOptions>) {
  return {
    ...(events === undefined ? {} : { events }),
    registerCommand: (name: string, options: CommandOptions) => { commands.set(name, options); },
  };
}

function recorded(name: string, calls: string[]): Subcommand<ExtensionCommandContext> {
  return { name, summary: `does ${name}`, run: (rest) => { calls.push(`${name} ${rest}`.trim()); } };
}

const commandCtx = (notices: Notice[]) => uiCtx(notices) as unknown as ExtensionCommandContext;

test("extensions on one session's bus share one /pi-orchestrator command, in either load order", async () => {
  for (const order of [["router", "subagents"], ["subagents", "router"]] as const) {
    const events = createEventBus();
    const calls: string[] = [];
    const registered = new Map<string, Map<string, CommandOptions>>();
    for (const extension of order) {
      const commands = new Map<string, CommandOptions>();
      registered.set(extension, commands);
      registerSubcommands(extensionPi(events, commands), extension === "router" ? [recorded("init", calls)] : [recorded("budget", calls)]);
    }
    const hosts = [...registered].filter(([, commands]) => commands.size > 0);
    assert.deepEqual(hosts.map(([extension, commands]) => [extension, [...commands.keys()]]), [[order[0], ["pi-orchestrator"]]], "the first extension hosts it alone");
    const command = hosts[0]![1].get("pi-orchestrator")!;
    const expectedNames = order[0] === "router" ? ["init", "budget"] : ["budget", "init"];
    assert.equal(command.description, commandDescription(expectedNames.map((name) => ({ name, summary: `does ${name}` }))));
    const notices: Notice[] = [];
    await command.handler("budget off", commandCtx(notices));
    await command.handler("init", commandCtx(notices));
    assert.deepEqual(calls, ["budget off", "init"]);
    await command.handler("", commandCtx(notices));
    assert.equal(notices.at(-1)!.message, commandUsage(expectedNames.map((name) => ({ name, summary: `does ${name}` }))));
  }
});

test("an extension alone, or without an event bus, hosts its own subcommands", async () => {
  for (const events of [createEventBus(), undefined]) {
    const calls: string[] = [];
    const commands = new Map<string, CommandOptions>();
    registerSubcommands(extensionPi(events, commands), [recorded("budget", calls)]);
    assert.deepEqual([...commands.keys()], ["pi-orchestrator"]);
    await commands.get("pi-orchestrator")!.handler("budget off", commandCtx([]));
    assert.deepEqual(calls, ["budget off"]);
  }
});

test("each session's bus has its own command: a worker's extensions never join the orchestrator's", () => {
  const orchestrator = new Map<string, CommandOptions>();
  const worker = new Map<string, CommandOptions>();
  registerSubcommands(extensionPi(createEventBus(), orchestrator), [recorded("init", [])]);
  registerSubcommands(extensionPi(createEventBus(), worker), [recorded("budget", [])]);
  assert.equal(orchestrator.get("pi-orchestrator")!.description, "pi-orchestrator: init (does init)");
  assert.equal(worker.get("pi-orchestrator")!.description, "pi-orchestrator: budget (does budget)");
});
