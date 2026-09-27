import assert from "node:assert/strict";
import { test } from "node:test";
import { commandDescription, commandUsage, dispatchSubcommand, type CommandContext, type Subcommand } from "./subcommands.ts";

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
