import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyCheckboxInput,
  checkboxRowValues,
  checkboxSelect,
  checkboxSelectedValues,
  createCheckboxSelectState,
  type CheckboxSelectUi,
} from "./checkbox-select.ts";

test("checkbox state keeps selected values in option order", () => {
  const state = createCheckboxSelectState(["a", "b", "c"], ["c", "missing", "a"]);
  assert.deepEqual(checkboxSelectedValues(state), ["a", "c"]);
});

test("checkbox key handling moves, toggles, confirms and cancels", () => {
  let state = createCheckboxSelectState(["a", "b", "c"], ["b"]);
  let result = applyCheckboxInput(state, "\x1B[B");
  state = result.state;
  assert.equal(state.cursor, 1);
  result = applyCheckboxInput(state, " ");
  state = result.state;
  assert.deepEqual(checkboxSelectedValues(state), []);
  result = applyCheckboxInput(state, "\x1B[B");
  state = result.state;
  result = applyCheckboxInput(state, " ");
  state = result.state;
  assert.deepEqual(checkboxSelectedValues(state), ["c"]);
  assert.equal(applyCheckboxInput(state, "\r").outcome, "confirm");
  assert.equal(applyCheckboxInput(state, "\x1B").outcome, "cancel");
});

test("checkbox row value cycling wraps and does not change selection", () => {
  let state = createCheckboxSelectState(["a", "b"], [], {
    choices: { a: ["low", "medium", "high"], b: ["off"] },
    initial: { a: "medium", b: "off" },
  });
  let result = applyCheckboxInput(state, "\x1B[C");
  state = result.state;
  assert.deepEqual(checkboxRowValues(state), { a: "high", b: "off" });
  assert.deepEqual(checkboxSelectedValues(state), []);
  result = applyCheckboxInput(state, "\x1B[C");
  state = result.state;
  assert.equal(checkboxRowValues(state).a, "low");
  result = applyCheckboxInput(state, "\x1B[D");
  state = result.state;
  assert.equal(checkboxRowValues(state).a, "high");
});

test("checkbox row value config skips unsupported values", () => {
  const state = createCheckboxSelectState(["a"], ["a"], {
    choices: { a: ["off", "low"] },
    initial: { a: "xhigh" },
  });
  assert.deepEqual(checkboxRowValues(state), { a: "off" });
  const result = applyCheckboxInput(state, "\x1B[D");
  assert.deepEqual(checkboxRowValues(result.state), { a: "low" });
});

test("checkbox select falls back to the select loop without custom UI", async () => {
  const calls: { title: string; options: string[] }[] = [];
  const answers = ["c", "Remove an entry…", "b", "Done"];
  const ui: CheckboxSelectUi = {
    select: async (title, options) => {
      calls.push({ title, options: [...options] });
      return answers.shift();
    },
  };
  const picked = await checkboxSelect(ui, "Pick models", ["a", "b", "c"], ["b"], "Hint text");
  assert.deepEqual(picked, ["c"]);
  assert.match(calls[0]!.title, /Pick models: b\. Hint text/);
  assert.deepEqual(calls[0]!.options, ["a", "c", "Remove an entry…", "Done"]);
  assert.deepEqual(calls[2]!.options, ["b", "c", "Back, remove nothing"]);
});

test("checkbox select falls back in non-tui modes even when custom exists", async () => {
  const ui: CheckboxSelectUi = {
    mode: "rpc",
    custom: async () => { throw new Error("custom should not run"); },
    select: async () => "Done",
  };
  assert.deepEqual(await checkboxSelect(ui, "Pick models", ["a", "b"], ["b"]), ["b"]);
});
