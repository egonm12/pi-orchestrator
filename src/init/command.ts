import { join } from "node:path";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { tierMapFromSettings } from "../routing/tier-map.ts";
import { toModelInfo, type ModelInfo, type RegistryModelLike } from "../models/model-info.ts";
import {
  approveRecipients,
  currentSubagentBanList,
  INIT_COMMAND,
  planSettings,
  readPersonalSettings,
  recipientProviders,
  RECIPIENTS_FILE,
  setupStatus,
  starterTierMap,
  writePersonalSettings,
} from "./setup.ts";
import { NO_MATCH_NOTE, banListPreview, pickSubagentBanList } from "./ban-list-picker.ts";

// `/pi-orchestrator init`: asks for the subagent ban list with a picker
// that starts from the current list (ban-list-picker.ts), writes it and a
// starter tier map into personal settings, then asks the owner to approve each provider the map
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
    select(title: string, options: string[]): Promise<string | undefined>;
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

  const hasTierMap = !setupStatus(personal, options.stateDir).tiersMissing;
  const existing = hasTierMap ? { settings: personal, path: settingsPath } : undefined;
  const subagentBanList = await pickSubagentBanList(ctx.ui, installed, currentSubagentBanList(personal), existing);
  if (subagentBanList === undefined) {
    say("pi-orchestrator: init cancelled at the ban list step; ban list unchanged and nothing was written.", "warning");
    return lines;
  }
  const unmatched = banListPreview(subagentBanList, installed).filter((line) => line.endsWith(NO_MATCH_NOTE));
  const banLists = { subagentBanList, sessionBanList: [] };

  const starter = starterTierMap(installed, banLists);
  if (!starter) say("pi-orchestrator: no installed model qualifies for a starter tier map (allowed-model list, ban list, published price).", "warning");
  const plan = planSettings(personal, starter, subagentBanList);

  // The written map, starter or existing, must load: check it the way the
  // router will.
  if ((starter || hasTierMap) && plan.settings !== personal) {
    try {
      tierMapFromSettings(plan.settings, undefined, { installedModels: installed, banLists });
    } catch (error) {
      const map = hasTierMap ? `the existing tier map in ${settingsPath}` : "the starter tier map";
      say(`pi-orchestrator: ${map} does not load (${String(error)}); nothing was written.`, "error");
      return lines;
    }
  }
  if (plan.changes.length > 0) {
    writePersonalSettings(settingsPath, plan.settings);
    say(`pi-orchestrator: wrote ${plan.changes.join("; ")} to ${settingsPath}.`);
    if (unmatched.length > 0) say(`pi-orchestrator: saved ban-list entries that match no installed model yet: ${unmatched.map((line) => line.slice(0, line.lastIndexOf(":"))).join(", ")}.`);
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
  return lines;
}
