import type { EventBus, ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { INIT_COMMAND } from "./setup.ts";

// `/pi-orchestrator <subcommand> [arguments]`: the first word picks the
// subcommand, which gets the rest of the arguments. No subcommand, or one
// that is not listed, prints the usage with every subcommand.
//
// Each pi-orchestrator extension adds its own subcommands (the router `init`,
// the subagents extension `gate`), and any of them may be switched off.
// pi would name a second `/pi-orchestrator` `/pi-orchestrator:2`, so exactly
// one extension registers the command: the first to load hosts it, and the
// others join it on the session's event bus. pi gives each session's
// extensions one bus and delivers an event to its listeners at once, so a
// worker's extensions never join the orchestrator's command.

/** What the dispatcher needs from pi's command context to print the usage. */
export interface CommandContext {
  readonly hasUI: boolean;
  readonly ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

/** One subcommand of `/pi-orchestrator`. */
export interface Subcommand<C extends CommandContext> {
  readonly name: string;
  /** What it does, in a few words, for the usage and the command's description. */
  readonly summary: string;
  /** Runs it; `rest` is the arguments after its name, trimmed. */
  run(rest: string, ctx: C): Promise<void> | void;
}

/** Shows a subcommand's `line` to the owner: in the UI, or on stderr without one. */
export function showOwner(ctx: CommandContext, line: string, type: "info" | "warning" | "error"): void {
  if (ctx.hasUI && ctx.ui) ctx.ui.notify(line, type);
  else process.stderr.write(`${line}\n`);
}

/** A subcommand as the usage and the description name it. */
type SubcommandName = Pick<Subcommand<CommandContext>, "name" | "summary">;

/** The usage: the command and one line per subcommand. */
export function commandUsage(subcommands: readonly SubcommandName[]): string {
  return [`usage: /${INIT_COMMAND} <subcommand>`, ...subcommands.map(({ name, summary }) => `  ${name}: ${summary}`)].join("\n");
}

/** The command's description in pi's command list. */
export function commandDescription(subcommands: readonly SubcommandName[]): string {
  return `${INIT_COMMAND}: ${subcommands.map(({ name, summary }) => `${name} (${summary})`).join(", ")}`;
}

/** The bus channel on which an extension asks the host to add its subcommands. */
const JOIN_CHANNEL = "pi-orchestrator:subcommands";

/** An extension's offer of its subcommands; the host marks it taken. */
interface JoinOffer {
  readonly subcommands: readonly Subcommand<ExtensionCommandContext>[];
  taken: boolean;
}

function isJoinOffer(data: unknown): data is JoinOffer {
  return typeof data === "object" && data !== null && Array.isArray((data as JoinOffer).subcommands) && typeof (data as JoinOffer).taken === "boolean";
}

/** Adds `subcommands` to this session's `/pi-orchestrator` command: joins the
 *  extension that hosts it, or hosts it when none does yet. */
export function registerSubcommands(pi: Pick<ExtensionAPI, "registerCommand"> & { readonly events?: EventBus },
  subcommands: readonly Subcommand<ExtensionCommandContext>[]): void {
  const offer: JoinOffer = { subcommands, taken: false };
  pi.events?.emit(JOIN_CHANNEL, offer);
  if (offer.taken) return;
  const hosted = [...subcommands];
  // Registering the command again replaces it, with the description naming every subcommand.
  const register = () => pi.registerCommand(INIT_COMMAND, {
    description: commandDescription(hosted),
    handler: async (args, ctx) => { await dispatchSubcommand(args, ctx, hosted); },
  });
  register();
  pi.events?.on(JOIN_CHANNEL, (data) => {
    if (!isJoinOffer(data) || data.taken) return;
    data.taken = true;
    for (const subcommand of data.subcommands) {
      const index = hosted.findIndex((candidate) => candidate.name === subcommand.name);
      if (index < 0) hosted.push(subcommand);
      else hosted[index] = subcommand;
    }
    register();
  });
}

/** Runs the subcommand `args` names, or prints the usage. Returns what it
 *  printed: nothing when a subcommand ran. */
export async function dispatchSubcommand<C extends CommandContext>(args: string, ctx: C, subcommands: readonly Subcommand<C>[]): Promise<string[]> {
  const trimmed = args.trim();
  const [name = ""] = trimmed.split(/\s+/, 1);
  const subcommand = subcommands.find((candidate) => candidate.name === name);
  if (subcommand) {
    await subcommand.run(trimmed.slice(name.length).trim(), ctx);
    return [];
  }
  const usage = commandUsage(subcommands);
  const line = name === "" ? usage : `pi-orchestrator: unknown subcommand '${name}'.\n${usage}`;
  showOwner(ctx, line, "warning");
  return [line];
}
