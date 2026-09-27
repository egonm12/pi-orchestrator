import assert from "node:assert/strict";
import { test } from "node:test";
import { missingResultSections, missingSectionsNote } from "./result-format.ts";

test("a Result with all five sections as headings misses none", () => {
  const result = ["## Confirmed", "src/a.ts:3", "## Changed", "None.", "## Unverified", "None.",
    "## Could not check", "None.", "## Verified by", "npm test: 12 pass"].join("\n");
  assert.deepEqual(missingResultSections(result), []);
});

test("bold labels, list items, trailing colons and other cases count as section headers", () => {
  const result = ["- **Confirmed**: src/a.ts:3", "**Changed:** src/a.ts", "### unverified findings", "Could not check:",
    "1. __Verified by__ (commands)"].join("\r\n");
  assert.deepEqual(missingResultSections(result), []);
});

test("a section name inside prose is not a header, and missing sections keep section order", () => {
  const result = ["Confirmed that the fix works.", "I changed src/a.ts.", "## Verified by", "npm test", "## Changes", "src/a.ts"].join("\n");
  assert.deepEqual(missingResultSections(result), ["Confirmed", "Changed", "Unverified", "Could not check"]);
  assert.deepEqual(missingResultSections(""), ["Confirmed", "Changed", "Unverified", "Could not check", "Verified by"]);
});

test("the note names every missing section", () => {
  assert.equal(missingSectionsNote(["Unverified"]).includes("no Unverified section."), true);
  assert.match(missingSectionsNote(["Changed", "Verified by"]), /no Changed, Verified by sections/);
});
