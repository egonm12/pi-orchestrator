import { appendFileSync } from "node:fs";
import {
  checkModelScope,
  matchesScopePattern,
} from "../models/model-scope.ts";
import type {
  ModelScopeConfig,
  ModelSource,
} from "../models/model-scope.ts";
import { splitKnownThinkingSuffix } from "../models/model-info.ts";
import type { Availability } from "../fixtures/provider-double.ts";
import { isProhibitedModel, subagentBanListEntry } from "./ban-lists.ts";

// Every admitting layer imports the ban-list predicate from here; its one
// definition, and the settings it reads, live in ./ban-lists.ts.
export { isProhibitedModel };

// Ticket 04: every delegation names the provider and model it goes to, so
// assignments and failures are explainable.
//
// The scope decision is the allowed-model match in ../models/model-scope.ts.

// Name-based prohibition (the subagent ban list, ./ban-lists.ts) is
// independent of the allow patterns, which have no deny field
// (`ModelScopeRule` in ../models/model-scope.ts).

// Enumerated deliberately narrowly. `anthropic/*` and `openai-codex/*` are
// both WRONG here and the audit test proves it: this registry really contains
// anthropic/claude-fable-5, anthropic/claude-fable-5-1 and
// openai-codex/gpt-6-astra.
//
// `openai-codex/gpt-6-*` is absent for the same reason -- it would admit
// gpt-6-astra. The owner chose gpt-6-luna and gpt-6-sol for agent work, so
// they are granted as EXACT ids instead: an exact grant cannot widen, and
// gpt-6-astra stays refused because nothing names it.
export const HARNESS_ALLOW_PATTERNS = [
  "anthropic/claude-haiku-*",
  "anthropic/claude-opus-*",
  "anthropic/claude-sonnet-*",
  "openai-codex/gpt-5.*",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6-sol",
] as const;

// enforce: true  -- scope checks are opt-in; without it checkModelScope is a
//                   no-op.
// strict: true   -- without it an INHERITED out-of-scope model is only a
//                   `warn`. The user's prohibition must
//                   hold regardless of how the model was reached, so
//                   inherited must be an error too.
export const HARNESS_MODEL_SCOPE: ModelScopeConfig = {
  enforce: true,
  strict: true,
  allow: [...HARNESS_ALLOW_PATTERNS],
};

export type DelegationFailureCode =
  | "missing_model"
  | "out_of_scope"
  | "unavailable"
  | "throttled"
  | "call_failure";

export interface ResolvedDelegation {
  ok: true;
  /** Always explicit. Never inherited, never defaulted. */
  provider: string;
  id: string;
  /** `provider/id`, thinking suffix stripped. */
  baseModel: string;
  /** Exactly what the caller asked for, suffix included. */
  requestedModel: string;
  thinkingSuffix: string;
  source: ModelSource;
}

export interface RejectedDelegation {
  ok: false;
  code: DelegationFailureCode;
  /** The model the caller asked for, echoed back so a failure names its
   *  subject. `undefined` only for `missing_model`. */
  requestedModel?: string;
  message: string;
  source: ModelSource;
  allowedPatterns?: string[];
  retryAfterSeconds?: number;
}

export type DelegationDecision = ResolvedDelegation | RejectedDelegation;

/** Audit helper: does `allow` admit any model on the subagent ban list?
 *  Returns the offending ids. Empty means the allow list is safe. */
export function allowListAdmitsProhibitedModel(
  allow: readonly string[],
  knownModelIds: readonly string[],
): string[] {
  return knownModelIds.filter(
    (id) =>
      isProhibitedModel(id) &&
      allow.some((pattern) => matchesScopePattern(id, pattern)),
  );
}

export interface DelegationRequest {
  /** Absent/blank is a hard failure, never an inherited or default model. */
  model?: string;
  source: ModelSource;
  scope?: ModelScopeConfig;
  /** Optional availability probe. Omitted means "not checked here". */
  availability?: (baseModel: string) => Availability;
}

export function resolveDelegationModel(request: DelegationRequest): DelegationDecision {
  const { source, scope = HARNESS_MODEL_SCOPE } = request;
  const requested = request.model?.trim();

  // checkModelScope returns undefined for a falsy model,
  // so a missing model would pass the scope check silently and then inherit
  // from agent frontmatter / defaultModel / the parent session. That is the
  // exact fall-through this ticket forbids, so it is rejected here first.
  if (!requested) {
    return {
      ok: false,
      code: "missing_model",
      source,
      message:
        "pi-orchestration-harness: delegation specified no model. Every delegation " +
        "must name an explicit provider/model; inheriting from the parent " +
        "session, agent frontmatter or defaultModel is not permitted.",
    };
  }

  const { baseModel } = splitKnownThinkingSuffix(requested);
  if (isProhibitedModel(baseModel)) {
    return {
      ok: false,
      code: "out_of_scope",
      requestedModel: requested,
      source,
      message:
        `pi-orchestration-harness: model '${requested}' is prohibited by name ` +
        `(subagent ban list entry '${subagentBanListEntry(baseModel)}'); it is never delegated.`,
      allowedPatterns: [...(scope.allow ?? [])],
    };
  }

  const violation = checkModelScope(requested, scope, source);
  if (violation && violation.severity === "error") {
    return {
      ok: false,
      code: "out_of_scope",
      requestedModel: requested,
      source,
      message: violation.message,
      allowedPatterns: violation.allowedPatterns,
    };
  }

  const { thinkingSuffix } = splitKnownThinkingSuffix(requested);
  const slash = baseModel.indexOf("/");
  if (slash <= 0 || slash === baseModel.length - 1) {
    return {
      ok: false,
      code: "missing_model",
      requestedModel: requested,
      source,
      message:
        `pi-orchestration-harness: model '${requested}' does not name a ` +
        "provider. Delegations must use an explicit 'provider/id' identity.",
    };
  }

  if (request.availability) {
    const probe = request.availability(baseModel);
    // No substitution. A model that cannot be reached is reported as itself;
    // silently swapping in a working model is the failure being designed out.
    if (probe.status !== "available") {
      const code: DelegationFailureCode =
        probe.status === "throttled"
          ? "throttled"
          : probe.status === "call-failure"
            ? "call_failure"
            : "unavailable";
      const detail = probe.detail ? ` ${probe.detail}` : "";
      return {
        ok: false,
        code,
        requestedModel: requested,
        source,
        ...(probe.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: probe.retryAfterSeconds }
          : {}),
        message:
          `pi-orchestration-harness: model '${baseModel}' is not usable ` +
          `(${probe.status}).${detail} No substitute model was selected; ` +
          "choose another model explicitly or report the blocker.",
      };
    }
  }

  return {
    ok: true,
    provider: baseModel.slice(0, slash),
    id: baseModel.slice(slash + 1),
    baseModel,
    requestedModel: requested,
    thinkingSuffix,
    source,
  };
}

export const DELEGATION_RECORD_PREFIX = "DELEGATION=";

/**
 * Stable caller-supplied identity shared by every trace record for one
 * delegation attempt. It is optional at the formatter boundary so old callers
 * and old JSONL remain readable, but a recipient success without it cannot
 * prove that it belongs to a failed delegation and therefore cannot override
 * that failure.
 */
export interface DelegationIdentity {
  readonly delegationId: string;
}

/** Shared validation keeps all record emitters from writing blank identities. */
export function validatedDelegationId(
  identity?: DelegationIdentity,
): string | undefined {
  if (identity === undefined) return undefined;
  const delegationId = identity.delegationId.trim();
  if (delegationId.length === 0) {
    throw new Error("delegation id must be a non-blank string");
  }
  return delegationId;
}

/** Observable output: one JSONL line per decision. Tests read this from
 *  outside the harness instead of inspecting internals. */
export function formatDelegationRecord(
  decision: DelegationDecision,
  identity?: DelegationIdentity,
): string {
  const delegationId = validatedDelegationId(identity);
  const record = delegationId === undefined ? decision : { ...decision, delegationId };
  return `${DELEGATION_RECORD_PREFIX}${JSON.stringify(record)}`;
}

export function recordDelegationDecision(
  path: string,
  decision: DelegationDecision,
  identity?: DelegationIdentity,
): void {
  appendFileSync(path, `${formatDelegationRecord(decision, identity)}\n`);
}
