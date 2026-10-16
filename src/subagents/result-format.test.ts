import assert from "node:assert/strict";
import { test } from "node:test";
import { missingResultSections, missingSectionsNote } from "./result-format.ts";

test("a Result with all three sections as headings misses none", () => {
  const result = ["## Result", "Updated the behavior (src/a.ts:3). npm test: 12 pass.", "## Changed", "src/a.ts", "## Not verified", "None."].join("\n");
  assert.deepEqual(missingResultSections(result), []);
});

test("bold labels, list items, trailing colons and other cases count as section headers", () => {
  const result = ["- **Result**: src/a.ts:3", "**Changed:** src/a.ts", "### not verified findings"].join("\r\n");
  assert.deepEqual(missingResultSections(result), []);
});

test("a section name inside prose is not a header, and missing sections keep section order", () => {
  const result = ["Result evidence shows the fix works.", "I changed src/a.ts.", "## Changed", "src/a.ts", "## Changes", "src/a.ts"].join("\n");
  assert.deepEqual(missingResultSections(result), ["Result", "Not verified"]);
  assert.deepEqual(missingResultSections(""), ["Result", "Changed", "Not verified"]);
});

test("the note names every missing section", () => {
  assert.equal(missingSectionsNote(["Not verified"]).includes("no Not verified section."), true);
  assert.match(missingSectionsNote(["Changed", "Not verified"]), /no Changed, Not verified sections/);
});
