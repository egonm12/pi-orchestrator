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
import {
  askGateLevel,
  askTarget,
  askWorkerLimit,
  currentFor,
  gateAndLimitIn,
  isProjectDirectory,
  OVERRIDES_TITLE,
  projectOverridesAllowed,
  projectSettingsPath,
  setsGateOrLimit,
  withSubagentKeys,
  type SettingsTarget,
} from "./worker-settings.ts";

// `/pi-orchestrator init`: asks for the subagent ban list with a picker
// that starts from the current list (ban-list-picker.ts), then the gate
// level and worker limit for personal settings or this project
// (worker-settings.ts), then, when a tier map exists, whether to rebuild it.
// It writes the ban list and a starter tier map into personal settings,
// then asks the owner to approve each provider the map would send task text
// to. The ban list, tier map, classifier and recipients are always
// personal. It needs a UI to ask; without one it approves nothing and says
// what to do.

/** What the command needs from pi's command context. */
export interface InitContext {
  readonly hasUI: boolean;
  /** The folder pi runs in; a project folder is offered as a settings target. */
  readonly cwd?: string;
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

  // Gate level and worker limit: the target is asked once, and only when
  // init runs in a project folder. Escape at the target skips both values.
  const projectPath = ctx.cwd && isProjectDirectory(ctx.cwd, settingsPath) ? projectSettingsPath(ctx.cwd) : undefined;
  let project: Record<string, unknown> | undefined;
  if (projectPath) {
    try { project = readPersonalSettings(projectPath); }
    catch (error) { say(`pi-orchestrator: ${projectPath} cannot be read (${String(error).split(/\r?\n/, 1)[0]}); only personal settings are offered.`, "warning"); }
  }
  const target: SettingsTarget | undefined = project ? await askTarget(ctx.ui) : "personal";
  const subagentKeys: Record<string, unknown> = {};
  if (target === undefined) {
    say("pi-orchestrator: gate level and worker limit skipped; left unchanged.");
  } else {
    // Picking the value in force that the target does not set itself writes
    // nothing, so the target keeps inheriting it.
    const current = currentFor(target, personal, project);
    const own = gateAndLimitIn(target === "project" ? project : personal);
    const gateLevel = await askGateLevel(ctx.ui, current.gateLevel, current.gateMark);
    if (gateLevel !== undefined && gateLevel !== own.gateLevel && !(gateLevel === current.gateLevel && own.gateLevel === undefined)) subagentKeys.gateLevel = gateLevel;
    const workerLimit = await askWorkerLimit(ctx.ui, current.workerLimit, current.limitMark);
    if (workerLimit !== undefined && workerLimit !== own.workerLimit && !(workerLimit === current.workerLimit && own.workerLimit === undefined)) subagentKeys.workerLimit = workerLimit;
  }
  const projectKeys = target === "project" ? subagentKeys : {};
  const personalKeys: Record<string, unknown> = target === "personal" ? { ...subagentKeys } : {};
  // The overrides question comes whenever the project would set a gate
  // level or worker limit that personal settings make the loader ignore:
  // one written now, or one the file already sets.
  let overridesIgnored = false;
  if (target === "project" && !projectOverridesAllowed(personal) && (Object.keys(projectKeys).length > 0 || setsGateOrLimit(project))) {
    if (await ctx.ui.confirm(OVERRIDES_TITLE, "Without it the subagents extension ignores every orchestrator.subagents key in a project's .pi/settings.json. This sets orchestrator.subagents.allowProjectOverrides in personal settings.")) {
      personalKeys.allowProjectOverrides = true;
    } else {
      overridesIgnored = true;
    }
  }

  const starter = starterTierMap(installed, banLists);
  if (!starter) say("pi-orchestrator: no installed model qualifies for a starter tier map (allowed-model list, ban list, published price).", "warning");
  // Escape at the rebuild question is no: the map stays.
  const rebuildTiers = hasTierMap && starter !== undefined
    && await ctx.ui.confirm("Rebuild the tier map from installed models?", `This replaces orchestrator.routing.tiers in ${settingsPath} with a starter map; the classifier, mode and other routing keys stay. No keeps the current map.`);
  const plan = planSettings(personal, starter, subagentBanList, { rebuildTiers });

  // The written map, starter or existing, must load: check it the way the
  // router will.
  if ((starter || hasTierMap) && plan.settings !== personal) {
    try {
      tierMapFromSettings(plan.settings, undefined, { installedModels: installed, banLists });
    } catch (error) {
      const map = rebuildTiers ? "the rebuilt tier map" : hasTierMap ? `the existing tier map in ${settingsPath}` : "the starter tier map";
      say(`pi-orchestrator: ${map} does not load (${String(error)}); nothing was written.`, "error");
      return lines;
    }
  }
  const personalChanges = [...plan.changes, ...Object.entries(personalKeys).map(([key, value]) => `orchestrator.subagents.${key} = ${String(value)}`)];
  if (personalChanges.length > 0) {
    writePersonalSettings(settingsPath, Object.keys(personalKeys).length > 0 ? withSubagentKeys(plan.settings, personalKeys) : plan.settings);
    say(`pi-orchestrator: wrote ${personalChanges.join("; ")} to ${settingsPath}.`);
    if (unmatched.length > 0) say(`pi-orchestrator: saved ban-list entries that match no installed model yet: ${unmatched.map((line) => line.slice(0, line.lastIndexOf(":"))).join(", ")}.`);
  } else {
    say("pi-orchestrator: personal settings already have a tier map and ban lists; left unchanged.");
  }
  if (projectPath && project && Object.keys(projectKeys).length > 0) {
    writePersonalSettings(projectPath, withSubagentKeys(project, projectKeys));
    say(`pi-orchestrator: wrote ${Object.entries(projectKeys).map(([key, value]) => `orchestrator.subagents.${key} = ${String(value)}`).join("; ")} to ${projectPath}.`);
  }
  if (overridesIgnored) say(`pi-orchestrator: project overrides are off, so the gate level and worker limit in ${projectPath} are ignored until orchestrator.subagents.allowProjectOverrides is true in ${settingsPath}.`, "warning");

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
