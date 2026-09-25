import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { splitKnownThinkingSuffix } from "../../../../../../.pi/agent/npm/node_modules/pi-subagents/src/shared/model-info.js";

// Ticket 21, ADR 0002: two owner-configured ban lists read from pi's personal
// settings under the `harness` key.
//
//   harness.subagentBanList  binds every delegated agent. Default below.
//   harness.sessionBanList   binds only the orchestrator's own session model.
//                            Empty by default.
//
// A project settings file may not extend, shorten or replace either list; a
// project value is ignored and the loader names the ignored key.
//
// This file is the one definition of the banned-name rule in the harness.
// Every admitting layer calls `isProhibitedModel`, which reads the configured
// subagent ban list; nothing else holds a copy of the names or the match.
//
// Seam: the lists are module-level state. They start at the defaults (the
// "no harness key" case) and change only through `configureBanLists`. Two
// hosts call it: the personal guard (harness/guard/extension.ts), with
// `loadBanListsOrDefaults(...)`, and the router extension
// (harness/router/extension.ts, ticket 27), at session start with the same
// personal lists validated strictly by `banListsFromSettings`. Tests
// configure and reset explicitly, so no test ever reads the real personal
// settings file.

export interface BanLists {
  readonly subagentBanList: readonly string[];
  readonly sessionBanList: readonly string[];
}

export const DEFAULT_BAN_LISTS: BanLists = Object.freeze({
  subagentBanList: Object.freeze(["fable", "astra"]),
  sessionBanList: Object.freeze([]),
});

type BanListKey = keyof BanLists;
const BAN_LIST_KEYS: readonly BanListKey[] = ["subagentBanList", "sessionBanList"];

export interface LoadedBanLists {
  readonly banLists: BanLists;
  /** Dotted keys a project settings file carried and the loader ignored,
   *  e.g. `harness.subagentBanList`. Data for the guard's log and, later,
   *  the decision record (ticket 25). */
  readonly ignoredProjectKeys: readonly string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail closed: a malformed list is an error naming the key, never a
 *  silently empty or default list. Entries are trimmed; a blank entry would
 *  match every model id, so it is refused too. */
function validatedBanList(key: BanListKey, value: unknown): readonly string[] {
  const expected = `harness.${key} must be an array of non-empty strings`;
  if (!Array.isArray(value)) throw new Error(`${expected}; got ${JSON.stringify(value)}.`);
  return Object.freeze(
    value.map((entry, index) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        throw new Error(`${expected}; entry ${index} is ${JSON.stringify(entry)}.`);
      }
      return entry.trim();
    }),
  );
}

/** The personal `harness` object, `undefined` when absent. Throws when the
 *  settings or the key are not objects. Shared with the tier-map loader
 *  (harness/routing/tier-map.ts). */
export function personalHarness(personal: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(personal)) {
    throw new Error("personal settings must be a JSON object.");
  }
  const harness = personal.harness;
  if (harness !== undefined && !isPlainObject(harness)) {
    throw new Error("personal settings key 'harness' must be an object.");
  }
  return harness;
}

/** Pure: effective lists from parsed personal and (optional) project settings. */
export function banListsFromSettings(personal: unknown, project?: unknown): LoadedBanLists {
  const harness = personalHarness(personal);
  const lists: Record<BanListKey, readonly string[]> = { ...DEFAULT_BAN_LISTS };
  for (const key of BAN_LIST_KEYS) {
    if (harness && Object.hasOwn(harness, key)) lists[key] = validatedBanList(key, harness[key]);
  }

  return { banLists: Object.freeze(lists), ignoredProjectKeys: ignoredProjectBanListKeys(project) };
}

/** Ban-list keys a project settings value carries, whatever their value. */
function ignoredProjectBanListKeys(project: unknown): string[] {
  const projectHarness = isPlainObject(project) ? project.harness : undefined;
  return isPlainObject(projectHarness)
    ? BAN_LIST_KEYS.filter((key) => Object.hasOwn(projectHarness, key)).map((key) => `harness.${key}`)
    : [];
}

/** `${PI_CODING_AGENT_DIR ?? ~/.pi/agent}`, with a leading `~` expanded. */
export function personalAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return join(home, ".pi", "agent");
  return configured === "~" || configured.startsWith("~/") ? `${home}${configured.slice(1)}` : configured;
}

/** A missing file is no settings; an unreadable or non-JSON file fails closed.
 *  Shared with the tier-map loader (harness/routing/tier-map.ts). */
export function readSettingsFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot read settings file ${path}: ${String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`settings file ${path} is not valid JSON: ${String(error)}`);
  }
}

export interface BanListSources {
  /** Personal agent dir; `settings.json` inside it is the personal file. */
  readonly agentDir?: string;
  /** Project cwd; `.pi/settings.json` inside it is the project file. */
  readonly projectCwd?: string;
}

export function loadBanLists({ agentDir = personalAgentDir(), projectCwd }: BanListSources = {}): LoadedBanLists {
  const personal = readSettingsFile(join(agentDir, "settings.json")) ?? {};
  const project = projectCwd === undefined ? undefined : readSettingsFile(join(projectCwd, ".pi", "settings.json"));
  return banListsFromSettings(personal, project);
}

export interface GuardBanLists extends LoadedBanLists {
  /** One message per settings file that could not be used. */
  readonly errors: readonly string[];
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A malformed list keeps its key's defaults plus every usable entry it does
 *  carry, so a bad edit can only narrow what the owner configured. */
function narrowedBanList(key: BanListKey, value: unknown, errors: string[]): readonly string[] {
  try {
    return validatedBanList(key, value);
  } catch (error) {
    errors.push(messageOf(error));
    const usable = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
      : [];
    return Object.freeze([...new Set([...DEFAULT_BAN_LISTS[key], ...usable])]);
  }
}

/** The personal guard's loader. It never throws and never widens:
 *  - each personal key is validated on its own, so a bad key never discards
 *    a good one, and a bad list keeps its defaults plus its usable entries;
 *  - an unreadable personal file or a non-object `harness` leaves the
 *    defaults in force;
 *  - an unusable project file leaves the personal lists in force.
 *  Each failure is one message. */
export function loadBanListsOrDefaults({ agentDir = personalAgentDir(), projectCwd }: BanListSources = {}): GuardBanLists {
  const errors: string[] = [];
  const lists: Record<BanListKey, readonly string[]> = { ...DEFAULT_BAN_LISTS };
  try {
    const harness = personalHarness(readSettingsFile(join(agentDir, "settings.json")) ?? {});
    for (const key of BAN_LIST_KEYS) {
      if (harness && Object.hasOwn(harness, key)) lists[key] = narrowedBanList(key, harness[key], errors);
    }
  } catch (error) {
    errors.push(messageOf(error));
  }
  let ignoredProjectKeys: string[] = [];
  if (projectCwd !== undefined) {
    try {
      ignoredProjectKeys = ignoredProjectBanListKeys(readSettingsFile(join(projectCwd, ".pi", "settings.json")));
    } catch (error) {
      errors.push(messageOf(error));
    }
  }
  return { banLists: Object.freeze(lists), ignoredProjectKeys, errors };
}

let configuredBanLists: BanLists = DEFAULT_BAN_LISTS;

/** Install the effective lists for every caller of the predicates below. */
export function configureBanLists(banLists: BanLists): void {
  configuredBanLists = Object.freeze({
    subagentBanList: validatedBanList("subagentBanList", banLists.subagentBanList),
    sessionBanList: validatedBanList("sessionBanList", banLists.sessionBanList),
  });
}

/** The lists every predicate below reads by default. */
export function activeBanLists(): BanLists {
  return configuredBanLists;
}

/** Back to the defaults, as if no `harness` key were present. */
export function resetBanLists(): void {
  configuredBanLists = DEFAULT_BAN_LISTS;
}

/** The banned-name rule: case-insensitive substring on the model id with the
 *  thinking suffix stripped. Returns the matching entry. */
function banListEntryFor(model: string, banList: readonly string[]): string | undefined {
  const id = splitKnownThinkingSuffix(model).baseModel.toLowerCase();
  return banList.find((entry) => id.includes(entry.toLowerCase()));
}

/** The subagent ban list entry that `model` matches, if any. */
export function subagentBanListEntry(model: string, banLists: BanLists = configuredBanLists): string | undefined {
  return banListEntryFor(model, banLists.subagentBanList);
}

/** Is `model` refused for every delegated agent? Applied to model-id fields
 *  only, never to task text, paths or shell text. */
export function isProhibitedModel(model: string, banLists: BanLists = configuredBanLists): boolean {
  return subagentBanListEntry(model, banLists) !== undefined;
}

/** Rejection reason for a candidate refused by `isProhibitedModel`. */
export function subagentBanListReason(model: string, banLists: BanLists = configuredBanLists): string {
  return `model id is prohibited by name (subagent ban list entry '${subagentBanListEntry(model, banLists)}')`;
}

/** Is `model` refused as the orchestrator's own session model? */
export function isSessionBannedModel(model: string, banLists: BanLists = configuredBanLists): boolean {
  return banListEntryFor(model, banLists.sessionBanList) !== undefined;
}

export interface SessionBanListRefusal {
  readonly entry: string;
  readonly message: string;
}

/** The refusal the personal guard (ticket 20) reports for a session-banned
 *  session model; `undefined` when the session model is allowed. */
export function sessionBanListRefusal(
  model: string,
  banLists: BanLists = configuredBanLists,
): SessionBanListRefusal | undefined {
  const entry = banListEntryFor(model, banLists.sessionBanList);
  if (entry === undefined) return undefined;
  return {
    entry,
    message: `session model '${model}' is on the session ban list (entry '${entry}')`,
  };
}
