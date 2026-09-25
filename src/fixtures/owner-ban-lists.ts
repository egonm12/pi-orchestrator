import { afterEach, beforeEach } from "node:test";
import { configureBanLists, resetBanLists, type BanLists } from "../policy/ban-lists.ts";

// The package ships empty ban lists. These tests were written against the
// owner's list, which bans Fable and Astra for delegated agents; they now set
// it explicitly instead of relying on a shipped default.
export const OWNER_BAN_LISTS: BanLists = Object.freeze({
  subagentBanList: Object.freeze(["fable", "astra"]),
  sessionBanList: Object.freeze([]),
});

/** The same lists as they appear in personal settings. */
export const OWNER_BAN_LIST_SETTINGS = { subagentBanList: ["fable", "astra"] } as const;

/** Configure the owner's lists before each test in this file and reset after. */
export function useOwnerBanLists(): void {
  beforeEach(() => configureBanLists(OWNER_BAN_LISTS));
  afterEach(() => resetBanLists());
}
