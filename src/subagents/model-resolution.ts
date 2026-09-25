// Reimplementation of the part of pi-subagents'
// `src/runs/shared/model-resolution.js` (installed version 0.71.0) the router
// uses: `INHERIT_MODEL` and `resolveEffectiveSubagentModel` called with no
// options (no scope enforcement), as the router calls it. Behaviour must match
// 0.71.0; model-resolution.test.ts pins it.

import { splitKnownThinkingSuffix, type ModelInfo } from "./model-info.ts";

export const INHERIT_MODEL = "inherit";

/** Case-fold, treat dots and underscores as dashes, collapse repeats. */
export function normalizeModelSegment(segment: string): string {
  return segment.toLowerCase().replace(/[._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function isPlausibleDateStamp(year: string, month: string, day: string): boolean {
  const yyyy = Number(year), mm = Number(month), dd = Number(day);
  return yyyy >= 1900 && yyyy <= 2099 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/** Drop a trailing `-20251001` or `-2025-10-01` so dated and undated ids match. */
function stripTrailingDateStamp(segment: string): string {
  const dashed = /^(.*)-(\d{4})-(\d{2})-(\d{2})$/.exec(segment);
  if (dashed && isPlausibleDateStamp(dashed[2]!, dashed[3]!, dashed[4]!)) return dashed[1]!;
  const compact = /^(.*)-(\d{4})(\d{2})(\d{2})$/.exec(segment);
  if (compact && isPlausibleDateStamp(compact[2]!, compact[3]!, compact[4]!)) return compact[1]!;
  return segment;
}

function isRegisteredProvider(provider: string, availableModels: readonly ModelInfo[]): boolean {
  const normalized = normalizeModelSegment(provider);
  return availableModels.some((entry) => normalizeModelSegment(entry.provider) === normalized);
}

/** Split `provider/id` (or `provider:id`, `provider.id`) only when the first
 *  segment is a registered provider. */
function splitQualifiedModelQuery(baseModel: string, availableModels: readonly ModelInfo[]): { queryProvider?: string; queryIdRaw: string } {
  const slashIdx = baseModel.indexOf("/");
  if (slashIdx !== -1) {
    const providerPart = baseModel.slice(0, slashIdx);
    if (isRegisteredProvider(providerPart, availableModels)) {
      return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(slashIdx + 1) };
    }
    return { queryIdRaw: baseModel };
  }
  for (const separator of [":", "."]) {
    const separatorIdx = baseModel.indexOf(separator);
    if (separatorIdx <= 0) continue;
    const providerPart = baseModel.slice(0, separatorIdx);
    if (!isRegisteredProvider(providerPart, availableModels)) continue;
    return { queryProvider: normalizeModelSegment(providerPart), queryIdRaw: baseModel.slice(separatorIdx + 1) };
  }
  return { queryIdRaw: baseModel };
}

function resolveExactIdMatches(baseModel: string, availableModels: readonly ModelInfo[], preferredProvider?: string): string | undefined {
  const exactMatches = availableModels.filter((entry) => entry.id === baseModel);
  if (preferredProvider) {
    const preferred = exactMatches.find((entry) => entry.provider === preferredProvider);
    if (preferred) return preferred.fullId;
  }
  return exactMatches.length === 1 ? exactMatches[0]!.fullId : undefined;
}

export function fuzzyResolveModel(baseModel: string, availableModels: readonly ModelInfo[], preferredProvider?: string): string | undefined {
  const { queryProvider, queryIdRaw } = splitQualifiedModelQuery(baseModel, availableModels);
  const queryId = normalizeModelSegment(queryIdRaw);
  const queryIdNoDate = stripTrailingDateStamp(queryId);
  const candidates = availableModels.filter((entry) => {
    const entryId = normalizeModelSegment(entry.id);
    if (entryId !== queryId && stripTrailingDateStamp(entryId) !== queryIdNoDate) return false;
    return queryProvider === undefined || normalizeModelSegment(entry.provider) === queryProvider;
  });
  if (candidates.length === 0) return undefined;
  if (preferredProvider) {
    const wanted = normalizeModelSegment(preferredProvider);
    const preferred = candidates.find((entry) => normalizeModelSegment(entry.provider) === wanted);
    if (preferred) return preferred.fullId;
  }
  return candidates.length === 1 ? candidates[0]!.fullId : undefined;
}

function resolveBaseModelCandidate(baseModel: string, availableModels: readonly ModelInfo[], preferredProvider?: string): string | undefined {
  const exact = availableModels.find((entry) => entry.fullId === baseModel);
  if (exact) return exact.fullId;
  const { queryProvider } = splitQualifiedModelQuery(baseModel, availableModels);
  if (queryProvider === undefined) {
    const exactId = resolveExactIdMatches(baseModel, availableModels, preferredProvider);
    if (exactId) return exactId;
  }
  return fuzzyResolveModel(baseModel, availableModels, preferredProvider);
}

function resolveSubagentModelCandidate(model: string, availableModels: readonly ModelInfo[], preferredProvider?: string): string | undefined {
  if (availableModels.length === 0) return model;
  const whole = resolveBaseModelCandidate(model, availableModels, preferredProvider);
  if (whole) return whole;
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(model);
  const base = thinkingSuffix ? resolveBaseModelCandidate(baseModel, availableModels, preferredProvider) : undefined;
  return base ? `${base}${thinkingSuffix}` : undefined;
}

/** The model a child launch gets when the call names none: the agent's model
 *  resolved against the registry (kept as written when it does not resolve),
 *  or the parent session's model when the agent has none or says `inherit`. */
export function resolveEffectiveSubagentModel(
  explicitModel: string | undefined,
  agentModel: string | undefined,
  parentModel: { provider: string; id: string } | undefined,
  availableModels: readonly ModelInfo[],
  preferredProvider?: string,
): string | undefined {
  const resolve = (requested: string | undefined): string | undefined => {
    const trimmed = typeof requested === "string" ? requested.trim() : "";
    const explicit = trimmed && trimmed !== INHERIT_MODEL ? trimmed : undefined;
    if (explicit === undefined) return parentModel ? `${parentModel.provider}/${parentModel.id}` : undefined;
    return resolveSubagentModelCandidate(explicit, availableModels, preferredProvider) ?? explicit;
  };
  const resolved = resolve(explicitModel ?? agentModel);
  if (resolved || explicitModel === undefined) return resolved;
  return resolve(agentModel);
}
