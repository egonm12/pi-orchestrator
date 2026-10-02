import { subagentBanListEntry } from "../policy/ban-lists.ts";
import type { ModelInfo } from "../models/model-info.ts";
import { emptiedPersonalTiers } from "../routing/tier-map.ts";

// The ban list step of `/pi-orchestrator init`: pick installed model
// families or type entries, preview what each entry blocks, then save or go
// back and edit. pi has no multi-select, so the picker is a loop of single
// selects. Escape at any select cancels the step and the caller keeps the
// previous list.

export const BAN_LIST_HINT =
  "Subagent ban list: each entry blocks every model whose id contains it, case-insensitive. For example, `opus` excludes every Opus model.";
export const TYPE_OWN = "Type your own…";
export const REMOVE_ENTRY = "Remove an entry…";
export const DONE = "Done";
/** Holds a comma, which a typed entry cannot, so it never names an entry. */
export const BACK = "Back, remove nothing";
export const SAVE_LIST = "Save this list";
export const EDIT_LIST = "Go back and edit";
export const NO_MATCH_NOTE = "matches no installed model yet";

/** The pi UI calls the picker uses. */
export interface PickerUi {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** A model's family: its id lowercased, without a `provider/` prefix and
 *  without 8-digit date parts, cut before the first part that starts with a
 *  digit (`claude-opus-4-5-20251101` is `claude-opus`). When only one name
 *  part comes before the version, the major version stays, so `gpt-5.6-luna`
 *  is `gpt-5` and `gemini-2.5-pro` is `gemini-2`. A family is always a
 *  prefix of the id, so as a ban-list entry it matches every model in it. */
export function modelFamily(id: string): string {
  const parts = id.toLowerCase().slice(id.lastIndexOf("/") + 1).split("-").filter((part) => !/^\d{8}$/.test(part));
  const version = parts.findIndex((part) => /^\d/.test(part));
  if (version === -1) return parts.join("-");
  if (version === 0) return parts[0]!;
  if (version === 1) return `${parts[0]}-${/^\d+/.exec(parts[1]!)![0]}`;
  return parts.slice(0, version).join("-");
}

/** The installed models' families, sorted and without duplicates. */
export function installedFamilies(installed: readonly ModelInfo[]): string[] {
  return [...new Set(installed.map((model) => modelFamily(model.id)))].sort();
}

/** The installed models `entry` blocks, by the ban list's own rule. */
export function banListMatches(entry: string, installed: readonly ModelInfo[]): string[] {
  const banLists = { subagentBanList: [entry], sessionBanList: [] };
  return installed.filter((model) => subagentBanListEntry(model.fullId, banLists) !== undefined).map((model) => model.fullId);
}

/** One preview line per entry: the installed models it matches, or the
 *  no-match note. */
export function banListPreview(entries: readonly string[], installed: readonly ModelInfo[]): string[] {
  if (entries.length === 0) return ["Subagent ban list is empty: subagents may use every installed model."];
  return entries.map((entry) => {
    const matches = banListMatches(entry, installed);
    return `${entry}: ${matches.length > 0 ? matches.join(", ") : NO_MATCH_NOTE}`;
  });
}

/** The personal settings init leaves the tier map in, and their path. */
export interface ExistingTierMap {
  readonly settings: unknown;
  readonly path: string;
}

/** One warning per tier of the existing personal tier map that `entries`
 *  would leave with no rungs, by the tier map loader's own checks
 *  (`emptiedPersonalTiers`). `[]` when there is no map. A map that does not
 *  load for another reason gives no warning here; init reports it. */
export function emptiedTierWarnings(settings: unknown, entries: readonly string[], installed: readonly ModelInfo[]): string[] {
  const banLists = { subagentBanList: [...entries], sessionBanList: [] };
  let emptied;
  try {
    emptied = emptiedPersonalTiers(settings, { installedModels: installed, banLists });
  } catch {
    return [];
  }
  return emptied.map(({ tier, dropped }) => {
    const matched = [...new Set(dropped.map((drop) => subagentBanListEntry(drop.model, banLists)).filter((entry) => entry !== undefined))];
    const others = [...new Set(dropped.filter((drop) => drop.reason !== "subagent ban list").map((drop) => drop.reason))];
    const why = others.length === 0
      ? `all its rungs match ${matched.join(", ")}`
      : matched.length === 0
        ? `its rungs drop: ${others.join(", ")}`
        : `its rungs match ${matched.join(", ")} or drop: ${others.join(", ")}`;
    return `tier ${tier} would have no models left (${why})`;
  });
}

const sameEntry = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Run the picker from `current`. Returns the list to save, or `undefined`
 *  when the owner pressed Escape at a select. Escape at the typed-entry
 *  input only returns to the picker. With an `existing` tier map, a list
 *  that would leave one of its tiers with no rungs is not offered for
 *  saving; the preview offers only going back. */
export async function pickSubagentBanList(
  ui: PickerUi,
  installed: readonly ModelInfo[],
  current: readonly string[],
  existing?: ExistingTierMap,
): Promise<string[] | undefined> {
  ui.notify(BAN_LIST_HINT);
  const families = installedFamilies(installed);
  const chosen = [...current];
  const add = (entry: string) => { if (!chosen.some((other) => sameEntry(other, entry))) chosen.push(entry); };
  for (;;) {
    const title = `Subagent ban list: ${chosen.length > 0 ? chosen.join(", ") : "(none)"}. Add a model family, type your own, or Done`;
    const options = [
      ...families.filter((family) => !chosen.some((entry) => sameEntry(entry, family))),
      TYPE_OWN,
      ...(chosen.length > 0 ? [REMOVE_ENTRY] : []),
      DONE,
    ];
    const choice = await ui.select(title, options);
    if (choice === undefined) return undefined;
    if (choice === TYPE_OWN) {
      const typed = await ui.input("Ban-list entries (comma-separated; each blocks every model whose id contains it)", "e.g. fable, astra");
      for (const entry of (typed ?? "").split(",").map((part) => part.trim()).filter(Boolean)) add(entry);
    } else if (choice === REMOVE_ENTRY) {
      const removed = await ui.select("Remove which entry?", [...chosen, BACK]);
      if (removed === undefined) return undefined;
      if (removed !== BACK) chosen.splice(chosen.indexOf(removed), 1);
    } else if (choice === DONE) {
      for (const line of banListPreview(chosen, installed)) ui.notify(line, line.endsWith(NO_MATCH_NOTE) ? "warning" : "info");
      const emptied = existing ? emptiedTierWarnings(existing.settings, chosen, installed) : [];
      for (const line of emptied) ui.notify(line, "warning");
      const verdict = emptied.length > 0
        ? await ui.select(
            `Subagent ban list ${chosen.join(", ")} would leave a tier of the existing tier map with no models, so it cannot be saved. Edit the tier map in ${existing!.path} first, or ban less.`,
            [EDIT_LIST],
          )
        : await ui.select(`Save subagent ban list: ${chosen.join(", ") || "(none)"}?`, [SAVE_LIST, EDIT_LIST]);
      if (verdict === undefined) return undefined;
      if (verdict === SAVE_LIST) return chosen;
    } else {
      add(choice);
    }
  }
}
