import { THINKING_LEVELS, type ThinkingLevel } from "../models/model-info.ts";
import type { EffortBand } from "./effort-rubric.ts";

/** Personal setting only. No project settings are consulted. */
export function sessionEffortBandFromSettings(personal: unknown): EffortBand | undefined {
  if (typeof personal !== "object" || personal === null || Array.isArray(personal)) return undefined;
  const orchestrator = (personal as Record<string, unknown>).orchestrator;
  if (typeof orchestrator !== "object" || orchestrator === null || Array.isArray(orchestrator)) return undefined;
  const routing = (orchestrator as Record<string, unknown>).routing;
  if (typeof routing !== "object" || routing === null || Array.isArray(routing)) return undefined;
  const raw = (routing as Record<string, unknown>).sessionEffort;
  if (raw === undefined) return undefined;
  const match = typeof raw === "string" ? /^([a-z]+)-([a-z]+)$/.exec(raw) : null;
  const min = match?.[1] as ThinkingLevel | undefined;
  const max = match?.[2] as ThinkingLevel | undefined;
  if (min === undefined || max === undefined || !THINKING_LEVELS.includes(min) || !THINKING_LEVELS.includes(max) ||
    THINKING_LEVELS.indexOf(min) > THINKING_LEVELS.indexOf(max)) {
    throw new Error(`orchestrator.routing.sessionEffort must be an inclusive effort band low-high; got ${JSON.stringify(raw)}.`);
  }
  return { min, max };
}
