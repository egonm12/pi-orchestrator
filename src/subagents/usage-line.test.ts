import { test } from "node:test";
import assert from "node:assert/strict";
import { usageLine } from "./usage-line.ts";

const staleHeader = {
  state: "available",
  percentLeft: 32,
  resetsAt: "2026-10-05T09:47:17.000Z",
  observedAt: "2026-10-01T16:47:53.999Z",
  source: "header",
} as const;

test("a stale header reading is omitted even while its reported window reset is in the future", () => {
  assert.equal(usageLine({ "openai-codex": staleHeader }, new Date("2026-10-03T15:00:00.000Z")), undefined);
});
