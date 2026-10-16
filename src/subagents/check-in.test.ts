import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKGROUND_CHECK_IN, CheckInSchedule, DEFAULT_CHECK_IN, FOREGROUND_CHECK_IN, parseCheckInReply, WorkerCheckIn } from "./check-in.ts";

const MINUTE = 60_000;

test("the first check-in is due after afterMinutes on the clock, then every everyMinutes after the last one", () => {
  const schedule = new CheckInSchedule({ ...DEFAULT_CHECK_IN, afterMinutes: 15, everyMinutes: 10 }, 0);
  assert.equal(schedule.due(15 * MINUTE - 1, 0), false);
  assert.equal(schedule.due(15 * MINUTE, 0), true);
  schedule.checkedIn(20 * MINUTE);
  assert.equal(schedule.due(30 * MINUTE - 1, 0), false);
  assert.equal(schedule.due(30 * MINUTE, 0), true);
});

test("the first check-in is due after afterModelCalls if they come first; later ones go by the clock alone", () => {
  const schedule = new CheckInSchedule({ ...DEFAULT_CHECK_IN, afterModelCalls: 40 }, 0);
  assert.equal(schedule.due(MINUTE, 39), false);
  assert.equal(schedule.due(MINUTE, 40), true);
  schedule.checkedIn(MINUTE);
  assert.equal(schedule.due(2 * MINUTE, 80), false, "model calls count for the first check-in only");
  assert.equal(schedule.due(16 * MINUTE, 80), true);
});

test("a check-in reply is continue, accept or stop alone, hint: and its text, or any other text as a hint", () => {
  assert.deepEqual(parseCheckInReply("continue"), { decision: "continue" });
  assert.deepEqual(parseCheckInReply(" Accept. "), { decision: "accept" });
  assert.deepEqual(parseCheckInReply("STOP"), { decision: "stop" });
  assert.deepEqual(parseCheckInReply("hint: read config.json first"), { decision: "hint", hint: "read config.json first" });
  assert.deepEqual(parseCheckInReply("stop using the cache"), { decision: "hint", hint: "stop using the cache" }, "never a stop by accident");
});

test("a worker's check-in is steered in once due on a fake clock: a background worker waits, a foreground one ends its run", () => {
  let now = 0;
  const steered: string[] = [];
  const background = new WorkerCheckIn({ ...DEFAULT_CHECK_IN, afterMinutes: 15 }, { background: true, now: () => now });
  background.attach((text) => steered.push(text));
  background.modelCallStarted();
  now = 15 * MINUTE;
  background.modelCallStarted();
  assert.deepEqual(steered, [BACKGROUND_CHECK_IN]);
  background.waiting();
  now = 40 * MINUTE;
  background.modelCallStarted();
  assert.equal(steered.length, 1, "no check-in while one waits for its answer");
  background.answered({ decision: "accept" });
  assert.equal(background.outcome, "accepted");

  const foreground = new WorkerCheckIn({ ...DEFAULT_CHECK_IN, afterModelCalls: 2 }, { background: false, now: () => 0 });
  const foregroundSteered: string[] = [];
  foreground.attach((text) => foregroundSteered.push(text));
  foreground.modelCallStarted();
  assert.equal(foreground.outcome, undefined);
  foreground.modelCallStarted();
  assert.deepEqual(foregroundSteered, [FOREGROUND_CHECK_IN]);
  assert.equal(foreground.outcome, "ended");
});
