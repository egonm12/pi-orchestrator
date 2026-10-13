import { test } from "node:test";
import assert from "node:assert/strict";
import { quotaHeaderObservation } from "./quota-headers.ts";

const at = new Date("2026-10-03T15:00:00.000Z");
const headers = {
  "x-codex-primary-used-percent": "26",
  "x-codex-primary-window-minutes": "300",
  "x-codex-primary-reset-at": String(Date.parse("2026-10-03T21:34:00.000Z") / 1000),
  "x-codex-secondary-used-percent": "7",
  "x-codex-secondary-window-minutes": "10080",
  "x-codex-secondary-reset-at": String(Date.parse("2026-10-09T23:10:00.000Z") / 1000),
};

test("Codex headers report the remaining percentage of the binding window", () => {
  assert.deepEqual(quotaHeaderObservation(200, headers, at), {
    state: "available",
    percentLeft: 74,
    resetsAt: "2026-10-03T21:34:00.000Z",
    observedAt: at.toISOString(),
    source: "header",
  });
});

test("Codex weekly headroom is used when it is tighter than the five-hour window", () => {
  const observation = quotaHeaderObservation(200, {
    ...headers,
    "x-codex-primary-used-percent": "5",
    "x-codex-primary-reset-at": String(Date.parse("2026-10-03T21:34:00.000Z") / 1000),
    "x-codex-secondary-used-percent": "23",
    "x-codex-secondary-reset-at": String(Date.parse("2026-10-09T23:10:00.000Z") / 1000),
  }, at);
  assert.deepEqual(observation, {
    state: "available",
    percentLeft: 77,
    resetsAt: "2026-10-09T23:10:00.000Z",
    observedAt: at.toISOString(),
    source: "header",
  });
});

test("Anthropic weekly headroom is used when it is tighter than the five-hour window", () => {
  assert.deepEqual(quotaHeaderObservation(200, {
    "anthropic-ratelimit-unified-5h-utilization": "0.05",
    "anthropic-ratelimit-unified-5h-reset": String(Date.parse("2026-10-03T21:34:00.000Z") / 1000),
    "anthropic-ratelimit-unified-7d-utilization": "0.23",
    "anthropic-ratelimit-unified-7d-reset": String(Date.parse("2026-10-09T23:10:00.000Z") / 1000),
  }, at), {
    state: "available",
    percentLeft: 77,
    resetsAt: "2026-10-09T23:10:00.000Z",
    observedAt: at.toISOString(),
    source: "header",
  });
});

test("a missing quota window uses the known window", () => {
  assert.deepEqual(quotaHeaderObservation(200, {
    "x-codex-secondary-used-percent": "23",
    "x-codex-secondary-reset-at": String(Date.parse("2026-10-09T23:10:00.000Z") / 1000),
  }, at), {
    state: "available",
    percentLeft: 77,
    resetsAt: "2026-10-09T23:10:00.000Z",
    observedAt: at.toISOString(),
    source: "header",
  });
});
