import { limitLiftsAt, percentHoldsUntil, type UsageObservation, type UsageObservations } from "../router/usage-observations.ts";

// The orchestrator's usage line (PRD cml8, user story 54): one short line of
// what the usage store knows per provider, such as
//   usage: anthropic exhausted until 14:00 · openai-codex 62% left
// It ends the orchestrator protocol (orchestrator-protocol.ts), so it rides the
// protocol onto every request of every orchestrator run and never reaches a
// worker. A provider whose limit has lifted, or whose low or available reading
// is past the earlier of its window reset and its five-hour freshness limit
// (percentHoldsUntil), is left out: its observation says nothing true any more.
// With nothing left to say there is no line.

const pad = (value: number) => String(value).padStart(2, "0");

/** `at` in local time: 14:00 on `now`'s day, else with its date, 2026-09-30 14:00. */
function localTime(at: number, now: Date): string {
  const time = new Date(at);
  const clock = `${pad(time.getHours())}:${pad(time.getMinutes())}`;
  const sameDay = time.getFullYear() === now.getFullYear() && time.getMonth() === now.getMonth() && time.getDate() === now.getDate();
  return sameDay ? clock : `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock}`;
}

/** One provider's part of the line, or undefined when its observation no longer holds at `now`. */
function providerPart(provider: string, observation: UsageObservation, now: Date): string | undefined {
  const left = observation.percentLeft === undefined ? undefined : `${Math.round(observation.percentLeft)}% left`;
  const lifts = limitLiftsAt(observation);
  if (lifts !== undefined) {
    if (!(now.getTime() < lifts)) return undefined;
    // Without a stated reset the time is the store's own estimate.
    const until = `until ${observation.resetsAt === undefined ? "about " : ""}${localTime(lifts, now)}`;
    return `${provider} ${observation.state} ${until}${observation.state === "throttled" && left !== undefined ? `, ${left}` : ""}`;
  }
  if (!(now.getTime() < percentHoldsUntil(observation))) return undefined;
  if (observation.state === "low") return `${provider} low${left === undefined ? "" : `, ${left}`}`;
  return `${provider} ${left ?? "available"}`;
}

/** The usage line for `observations` at `now`, or undefined when none of them still says anything. */
export function usageLine(observations: UsageObservations, now: Date): string | undefined {
  const parts = Object.keys(observations).sort()
    .flatMap((provider) => providerPart(provider, observations[provider]!, now) ?? []);
  return parts.length === 0 ? undefined : `usage: ${parts.join(" · ")}`;
}
