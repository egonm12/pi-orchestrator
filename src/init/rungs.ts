import { getSupportedThinkingLevels, splitKnownThinkingSuffix, THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../models/model-info.ts";

function isThinkingLevel(value: string | undefined): value is ThinkingLevel {
  return value !== undefined && THINKING_LEVELS.some((level) => level === value);
}

function writtenBandMax(rung: string): ThinkingLevel | undefined {
  const colon = rung.lastIndexOf(":");
  if (colon === -1) return undefined;
  const [min, max, ...rest] = rung.slice(colon + 1).split("-");
  return rest.length === 0 && isThinkingLevel(min) && isThinkingLevel(max) ? max : undefined;
}

/** Extracts the model portion for init's defaults; tier-map loading owns rung validation. */
export function modelIdFromRung(rung: string): string {
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(rung);
  if (thinkingSuffix) return baseModel;
  const colon = rung.lastIndexOf(":");
  return writtenBandMax(rung) !== undefined && colon !== -1 ? rung.slice(0, colon) : rung;
}

/** The displayed single-effort default for an existing fixed or dynamic rung. */
export function thinkingLevelFromRung(rung: string, model?: ModelInfo): ThinkingLevel | undefined {
  const suffix = splitKnownThinkingSuffix(rung).thinkingSuffix;
  if (suffix) return suffix.slice(1) as ThinkingLevel;
  const bandMax = writtenBandMax(rung);
  if (bandMax) return bandMax;
  if (model && rung === model.fullId) {
    return getSupportedThinkingLevels(model).filter((level) => level !== "max").at(-1);
  }
  return undefined;
}

/** A rung without one recognized effort is dynamic, including a written band or no-effort form. */
export function isDynamicRung(rung: string): boolean {
  return splitKnownThinkingSuffix(rung).thinkingSuffix === "";
}
