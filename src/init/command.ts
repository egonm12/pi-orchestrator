import { join } from "node:path";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { tierMapFromSettings } from "../routing/tier-map.ts";
import { toModelInfo, type ModelInfo, type RegistryModelLike } from "../models/model-info.ts";
import {
  approveRecipients,
  AUTO_MODEL_SETUP_LINE,
  INIT_COMMAND,
  planSettings,
  readPersonalSettings,
  recipientProviders,
  RECIPIENTS_FILE,
  starterTierMap,
  writePersonalSettings,
} from "./setup.ts";

// `/pi-orchestrator init`: writes a starter tier map and a ban list into
// personal settings, then asks the owner to approve each provider the map
// would send task text to. It needs a UI to ask; without one it approves
// nothing and says what to do.

/** What the command needs from pi's command context. */
export interface InitContext {
  readonly hasUI: boolean;
  readonly modelRegistry?: { getAvailable(): RegistryModelLike[] };
  readonly ui?: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
}

export interface InitOptions {
  readonly stateDir: string;
  readonly agentDir?: string;
}

export const INIT_USAGE = `usage: /${INIT_COMMAND} init`;

export async function runInit(args: string, ctx: InitContext, options: InitOptions): Promise<string[]> {
  const lines: string[] = [];
  const say = (line: string, type: "info" | "warning" | "error" = "info") => {
    lines.push(line);
    if (ctx.hasUI && ctx.ui) ctx.ui.notify(line, type);
    else process.stderr.write(`${line}\n`);
  };
  if (args.trim() !== "init") {
    say(INIT_USAGE, "warning");
    return lines;
  }
  if (!ctx.hasUI || !ctx.ui) {
    say(`pi-orchestrator: /${INIT_COMMAND} init asks for approvals and needs an interactive session; nothing was written.`, "warning");
    return lines;
  }
  const settingsPath = join(options.agentDir ?? personalAgentDir(), "settings.json");
  const personal = readPersonalSettings(settingsPath);
  const installed: ModelInfo[] = (ctx.modelRegistry?.getAvailable() ?? []).map((model) => toModelInfo(model));

  const banInput = await ctx.ui.input("Models subagents may never use (comma-separated substrings, empty for none)", "e.g. fable, astra");
  const subagentBanList = (banInput ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const banLists = { subagentBanList, sessionBanList: [] };

  const starter = starterTierMap(installed, banLists);
  if (!starter) say("pi-orchestrator: no installed model qualifies for a starter tier map (allowed-model list, ban list, published price).", "warning");
  const plan = planSettings(personal, starter, subagentBanList);

  // The written map must load: check it the way the router will.
  if (starter && plan.settings !== personal) {
    try {
      tierMapFromSettings(plan.settings, undefined, { installedModels: installed, banLists });
    } catch (error) {
      say(`pi-orchestrator: the starter tier map does not load (${String(error)}); nothing was written.`, "error");
      return lines;
    }
  }
  if (plan.changes.length > 0) {
    writePersonalSettings(settingsPath, plan.settings);
    say(`pi-orchestrator: wrote ${plan.changes.join("; ")} to ${settingsPath}.`);
  } else {
    say("pi-orchestrator: personal settings already have a tier map and ban lists; left unchanged.");
  }

  const tiers = (plan.settings.orchestrator as { routing?: { tiers?: Record<string, string[]>; classifier?: { model?: string } } } | undefined)?.routing;
  const providers = recipientProviders({
    tiers: (tiers?.tiers ?? {}) as never,
    classifier: tiers?.classifier?.model ?? starter?.classifier ?? "",
  }).filter(Boolean);
  const approved: string[] = [];
  for (const provider of providers) {
    const yes = await ctx.ui.confirm(
      `Approve ${provider} as a data recipient?`,
      `The router extension may send worker task text to ${provider} models, to classify and run the work.`,
    );
    if (yes) approved.push(provider);
  }
  const storePath = join(options.stateDir, RECIPIENTS_FILE);
  approveRecipients(storePath, approved, "owner via /pi-orchestrator init");
  const declined = providers.filter((provider) => !approved.includes(provider));
  say(
    `pi-orchestrator: approved recipients: ${approved.join(", ") || "(none)"}` +
      (declined.length ? `; not approved: ${declined.join(", ")} (their rungs are skipped)` : "") +
      `. Store: ${storePath}. Start a new session to route.`,
  );
  say(AUTO_MODEL_SETUP_LINE);
  return lines;
}
