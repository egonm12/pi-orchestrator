// Reimplementation of the pure scope check in pi-subagents'
// `src/runs/shared/model-scope.js` (installed version 0.71.0): `checkModelScope`
// and `matchesScopePattern`. The settings parser is not needed. Behaviour must
// match 0.71.0; model-scope.test.ts pins it.

import { splitKnownThinkingSuffix } from "./model-info.ts";

export interface ModelScopeRule {
  enforce?: boolean;
  strict?: boolean;
  allow?: string[];
}

export interface ModelScopeConfig extends ModelScopeRule {
  agents?: Record<string, ModelScopeRule>;
}

export interface ModelScopeCheckRule extends ModelScopeRule {
  origin?: string;
}

export type ModelSource = "explicit" | "inherited";

export interface ModelScopeViolation {
  model: string;
  severity: "warn" | "error";
  message: string;
  allowedPatterns: string[];
  origin: string;
}

/** Escape RegExp specials except `*`, then turn `*` into `.*`. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

/** Case-insensitive glob match against the full `provider/id`, thinking suffix stripped. */
export function matchesScopePattern(model: string, pattern: string): boolean {
  return globToRegExp(pattern).test(splitKnownThinkingSuffix(model).baseModel);
}

/** A violation when enforcement is on and no `allow` pattern matches. An
 *  explicit model is an error; an inherited one is a warning unless `strict`. */
export function checkModelScope(
  model: string | undefined,
  scope: ModelScopeCheckRule | undefined,
  source: ModelSource,
): ModelScopeViolation | undefined {
  if (!model || !scope?.enforce) return undefined;
  const allow = scope.allow;
  if (!allow || allow.length === 0) return undefined;
  if (allow.some((pattern) => matchesScopePattern(model, pattern))) return undefined;
  const baseModel = splitKnownThinkingSuffix(model).baseModel;
  const severity = source === "explicit" || scope.strict === true ? "error" : "warn";
  const origin = scope.origin ?? "modelScope";
  return {
    model: baseModel,
    severity,
    allowedPatterns: allow,
    origin,
    message:
      `Model '${baseModel}' is outside the configured subagent model scope (${origin}). ` +
      `Allowed patterns: ${allow.join(", ")}.`,
  };
}
