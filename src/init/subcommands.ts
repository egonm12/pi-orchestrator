import { INIT_COMMAND } from "./setup.ts";

// `/pi-orchestrator <subcommand> [arguments]`: the first word picks the
// subcommand, which gets the rest of the arguments. No subcommand, or one
// that is not listed, prints the usage with every subcommand.

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
  if (ctx.hasUI && ctx.ui) ctx.ui.notify(line, "warning");
  else process.stderr.write(`${line}\n`);
  return [line];
}
