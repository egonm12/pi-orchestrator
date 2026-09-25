import { getAgentDir, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setImmediate } from "node:timers/promises";
import { ROUTER_PREFIX } from "./prefix.ts";

type Model = { readonly provider: string; readonly id: string };

const isAutoModel = (model: Model | undefined) => model?.provider === "orchestrator" && model.id === "auto";

/**
 * "Set as default" in `/model` saves the model as pi's global default before
 * pi emits `model_select` (agent-session.js setModel). The save is queued on
 * pi's settings write queue, whose tasks are synchronous file writes chained
 * on promises, so it has landed once a macrotask has passed. Then, if the
 * global settings name `orchestrator/auto` as the default, the default is set
 * to `model` through pi's own SettingsManager: it takes pi's file lock and
 * writes only the two default fields over the file's current content. pi's
 * in-memory copy has already written those fields and clears them from its
 * modified set, so its later saves leave the correction alone.
 * `undefined` when the saved default is not the auto model.
 */
async function restoreSavedDefault(model: Model | undefined, cwd: string): Promise<"restored" | "unchanged" | undefined> {
  await setImmediate();
  const settings = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const global = settings.getGlobalSettings();
  if (!isAutoModel({ provider: global.defaultProvider ?? "", id: global.defaultModel ?? "" })) return undefined;
  if (model === undefined || settings.drainErrors().length > 0) return "unchanged";
  settings.setDefaultModelAndProvider(model.provider, model.id);
  await settings.flush();
  return settings.drainErrors().length === 0 ? "restored" : "unchanged";
}

/**
 * The main thread stays on the model picked in `/model` (ADR 0006). pi cannot
 * hide `orchestrator/auto` from `/model`, so a user's selection of it (source
 * `set` or `cycle`) is undone: the previous model is restored, a saved default
 * of `orchestrator/auto` is set back to it, and one line says why. A `restore`
 * selection, and a session that starts on the auto model as a worker does,
 * are left alone.
 */
export function refuseAutoModelForMainThread(pi: ExtensionAPI): void {
  pi.on("model_select", async (event, ctx) => {
    if (event.source === "restore" || !isAutoModel(event.model)) return;
    const previous = event.previousModel;
    const restored = previous !== undefined && await pi.setModel(previous);
    const savedDefault = await restoreSavedDefault(restored ? previous : undefined, ctx.cwd);
    const restoredText = restored ? `restored ${previous.provider}/${previous.id} for the main thread` : "pick another model in /model for the main thread";
    const defaultText = savedDefault === "restored" ? " and as the default model"
      : savedDefault === "unchanged" ? "; the saved default is still orchestrator/auto, set another default in /model" : "";
    const line = `${ROUTER_PREFIX} orchestrator/auto is for workers; ${restoredText}${defaultText}.`;
    if (ctx.hasUI) ctx.ui.notify(line, "warning");
    else process.stderr.write(`${line}\n`);
  });
}
