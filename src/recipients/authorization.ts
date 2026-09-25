// Ticket 07: knowing a provider exists is not permission to send it data.
//
// Two sets, deliberately kept apart and never merged:
//
//   DISCOVERED   -- providers the environment reveals: the model catalog, the
//                   installed registry, configuration. Discovery is a pure
//                   read. It answers "what exists", and nothing else.
//
//   AUTHORIZED   -- providers the owner has explicitly approved to RECEIVE
//                   delegation data. Every entry carries who approved it, when,
//                   and what they approved.
//
// The default is empty. A provider that appears in discovery is not a
// recipient, and nothing in this module lets it become one as a side effect of
// being seen. That is the whole point: a newly-visible provider must not
// quietly become a destination for user data.
//
// This module performs no network I/O and makes no model call.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelCatalog } from "../catalog/model-catalog.ts";

// ---------------------------------------------------------------------------
// Discovery: what exists
// ---------------------------------------------------------------------------

/** How a provider came to be visible. Recorded so a reader can tell a
 *  catalogued provider from a configured one, and neither from an approved
 *  one. */
export type DiscoverySource = "model-catalog" | "installed-registry" | "configuration";

export interface DiscoveredProvider {
  readonly provider: string;
  readonly discoveredVia: DiscoverySource;
  readonly models: readonly string[];
}

function groupByProvider(
  modelIds: readonly string[],
  discoveredVia: DiscoverySource,
): DiscoveredProvider[] {
  const byProvider = new Map<string, string[]>();
  for (const model of modelIds) {
    const slash = model.indexOf("/");
    if (slash <= 0) continue;
    const provider = model.slice(0, slash);
    const models = byProvider.get(provider);
    if (models) models.push(model);
    else byProvider.set(provider, [model]);
  }
  return [...byProvider.entries()]
    .map(([provider, models]) => ({ provider, discoveredVia, models: [...models].sort() }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Discover the providers a catalog reveals. Pure read: it cannot and does not
 *  touch the authorization store. */
export function discoverProviders(catalog: ModelCatalog): DiscoveredProvider[] {
  return groupByProvider(Object.keys(catalog.entries), "model-catalog");
}

/** Discover from a bare list of model ids, e.g. the installed registry
 *  snapshot or a configured provider list. */
export function discoverProvidersFromModelIds(
  modelIds: readonly string[],
  discoveredVia: DiscoverySource = "installed-registry",
): DiscoveredProvider[] {
  return groupByProvider(modelIds, discoveredVia);
}

// ---------------------------------------------------------------------------
// Authorization: who may receive data
// ---------------------------------------------------------------------------

/**
 * What is being approved. The spec treats all three as requiring approval:
 * "Installing integrations, adding credentials, or introducing new recipients
 * requires approval." They are distinguished so an approval to install an
 * integration is not silently read as an approval to send it data.
 */
/**
 * What an approval authorizes. Deliberately NOT fungible: each scope is
 * checked by name at its own gate, so an approval minted for one purpose
 * cannot be spent on another.
 *
 * `capability-research` and `active-benchmark` are ticket 08's paid refresh
 * activities. `allowance-overrun` is ticket 09's gate for delegating past a
 * task's spending allowance. `tracker-operations` is ticket 12's external
 * planning-tracker authorization (wayfinder). They are listed here rather than
 * given separate approval registries so the harness keeps ONE unforgeable
 * approval concept -- and none of them can widen data access, because every
 * recipient read below requires `scope === "data-recipient"` exactly
 * (`isAuthorizedRecipient`, `recipientApproval`, `approvedRecipients`).
 *
 * `approved-scope`, `paid-service`, `destructive-action`,
 * `tracker-publication`, `deployment`, `git-push` and `pr-creation` are
 * ticket 15's gated actions, added here for the same reason: one registry,
 * one minting function, one definition of "the owner said yes". Ticket 11's
 * `infrastructure-recovery` scope uses that same registry for an explicit
 * decision after a structured infrastructure failure. None can widen data
 * access -- same exact-scope reads -- and because scopes are compared by
 * equality at each gate, an approval to deploy cannot be spent on a push or
 * an infrastructure retry.
 */
export type AuthorizationScope =
  | "data-recipient"
  | "integration"
  | "credential"
  | "capability-research"
  | "active-benchmark"
  | "allowance-overrun"
  | "tracker-operations"
  | "approved-scope"
  | "paid-service"
  | "destructive-action"
  | "tracker-publication"
  | "deployment"
  | "git-push"
  | "pr-creation"
  | "infrastructure-recovery"
  | "project-policy-relaxation";

export const AUTHORIZATION_SCOPES: readonly AuthorizationScope[] = [
  "data-recipient",
  "integration",
  "credential",
  "capability-research",
  "active-benchmark",
  "allowance-overrun",
  "tracker-operations",
  "approved-scope",
  "paid-service",
  "destructive-action",
  "tracker-publication",
  "deployment",
  "git-push",
  "pr-creation",
  "infrastructure-recovery",
  "project-policy-relaxation",
];

export interface OwnerApproval {
  readonly approvedBy: string;
  /** ISO-8601. */
  readonly grantedAt: string;
  readonly scope: AuthorizationScope;
  /** What the owner was told they were approving. Stored so an authorization
   *  can be audited against what was actually asked. */
  readonly acknowledgement: string;
  /**
   * The one instance this approval decides, for gates that admit per instance
   * rather than per scope. Compared by exact string equality at the gate and
   * never parsed out of `acknowledgement`: owner prose is an audit record, not
   * a machine-readable binding, and a substring or prefix test over it admits
   * neighbouring ids (`infra-1` matches `infra-10`) and cannot tell an
   * instruction from its negation (`DO NOT retry infra-1`).
   *
   * Ticket 11's `infrastructure-recovery` gate requires it to equal the
   * structured failure id. Scopes with no per-instance gate leave it unset.
   */
  readonly subject?: string;
}

/**
 * Approvals granted through `grantOwnerApproval`, and only those.
 *
 * Module-scoped and never exported, so it is unreachable from any other
 * module. An object that was not produced by `grantOwnerApproval` is not in
 * this set and `authorizeRecipient` rejects it. That is what makes "adding a
 * recipient requires explicit approval" structural rather than conventional:
 * routing or catalog code cannot forge an approval, because it cannot reach
 * this registry to register one -- a hand-built object with all the right
 * fields still fails.
 *
 * A WeakSet rather than a Set so a discarded approval does not pin memory.
 */
const grantedApprovals = new WeakSet<object>();

export class UnapprovedAuthorizationError extends Error {
  readonly code = "unapproved_authorization_attempt";
  constructor(message: string) {
    super(message);
    this.name = "UnapprovedAuthorizationError";
  }
}

export interface GrantOwnerApprovalInput {
  readonly approvedBy: string;
  readonly scope: AuthorizationScope;
  readonly acknowledgement: string;
  /** ISO-8601. Defaults to now. */
  readonly grantedAt?: string;
  /** See `OwnerApproval.subject`. Omitted, or a non-blank instance id. */
  readonly subject?: string;
}

/**
 * The single way to mint an approval. Every field is required and must be
 * non-blank: a hollow token carrying empty strings is not an approval, and
 * accepting one would reduce this gate to a formality.
 */
export function grantOwnerApproval(input: GrantOwnerApprovalInput): OwnerApproval {
  const approvedBy = input.approvedBy.trim();
  const acknowledgement = input.acknowledgement.trim();
  if (!approvedBy) {
    throw new UnapprovedAuthorizationError(
      "pi-orchestration-harness: an owner approval must name who approved it.",
    );
  }
  if (!acknowledgement) {
    throw new UnapprovedAuthorizationError(
      "pi-orchestration-harness: an owner approval must state what was approved.",
    );
  }
  if (!AUTHORIZATION_SCOPES.includes(input.scope)) {
    throw new UnapprovedAuthorizationError(
      `pi-orchestration-harness: unknown approval scope '${input.scope}'.`,
    );
  }
  const subject = input.subject?.trim();
  if (input.subject !== undefined && !subject) {
    throw new UnapprovedAuthorizationError(
      "pi-orchestration-harness: an owner approval that names a subject must name a non-blank one.",
    );
  }
  const approval: OwnerApproval = Object.freeze({
    approvedBy,
    grantedAt: input.grantedAt ?? new Date().toISOString(),
    scope: input.scope,
    acknowledgement,
    ...(subject === undefined ? {} : { subject }),
  });
  grantedApprovals.add(approval);
  return approval;
}

/**
 * Whether an approval was minted by `grantOwnerApproval`.
 *
 * Read-only and cannot mint: it answers a boolean about an object the caller
 * already holds. Exported so another gate (ticket 08's paid capability
 * research) can verify genuineness against this same module-private registry
 * instead of standing up a second one.
 */
export function isOwnerApprovalGranted(approval: OwnerApproval): boolean {
  return grantedApprovals.has(approval);
}

export interface AuthorizedRecipient {
  readonly provider: string;
  readonly scope: AuthorizationScope;
  readonly approvedBy: string;
  readonly grantedAt: string;
  readonly acknowledgement: string;
  readonly note?: string;
}

export const RECIPIENTS_SCHEMA_VERSION = 1;

export interface RecipientAuthorization {
  readonly schemaVersion: number;
  readonly recipients: readonly AuthorizedRecipient[];
}

/** The default. Empty means no recipient is approved, not "everything
 *  discovered is fine". */
export function emptyAuthorization(): RecipientAuthorization {
  return Object.freeze({
    schemaVersion: RECIPIENTS_SCHEMA_VERSION,
    recipients: Object.freeze([]) as readonly AuthorizedRecipient[],
  });
}

/**
 * Add a recipient. Returns a NEW authorization; the input is never mutated, so
 * a held reference cannot be widened behind its holder's back.
 *
 * Throws unless `approval` came from `grantOwnerApproval`.
 */
export function authorizeRecipient(
  authorization: RecipientAuthorization,
  provider: string,
  approval: OwnerApproval,
  note?: string,
): RecipientAuthorization {
  if (!grantedApprovals.has(approval)) {
    throw new UnapprovedAuthorizationError(
      `pi-orchestration-harness: refusing to authorize '${provider}' as a data ` +
        "recipient. The supplied approval was not granted through " +
        "grantOwnerApproval, so no owner approval is on record. Discovery is " +
        "not authorization.",
    );
  }
  const name = provider.trim();
  if (!name) {
    throw new UnapprovedAuthorizationError(
      "pi-orchestration-harness: cannot authorize a blank provider name.",
    );
  }
  const entry: AuthorizedRecipient = {
    provider: name,
    scope: approval.scope,
    approvedBy: approval.approvedBy,
    grantedAt: approval.grantedAt,
    acknowledgement: approval.acknowledgement,
    ...(note === undefined ? {} : { note }),
  };
  const existing = authorization.recipients.filter(
    (r) => !(r.provider === name && r.scope === approval.scope),
  );
  return Object.freeze({
    schemaVersion: RECIPIENTS_SCHEMA_VERSION,
    recipients: Object.freeze([...existing, entry]) as readonly AuthorizedRecipient[],
  });
}

/** Approved to RECEIVE DATA specifically. An integration or credential
 *  approval is not a data-recipient approval. */
export function isAuthorizedRecipient(
  authorization: RecipientAuthorization,
  provider: string,
): boolean {
  return authorization.recipients.some(
    (r) => r.provider === provider && r.scope === "data-recipient",
  );
}

export function recipientApproval(
  authorization: RecipientAuthorization,
  provider: string,
): AuthorizedRecipient | undefined {
  return authorization.recipients.find(
    (r) => r.provider === provider && r.scope === "data-recipient",
  );
}

/**
 * The read-only view routing consumes, shaped for ticket 06's
 * `PrivacyConstraint.approvedRecipients`.
 *
 * Frozen, and a plain array of names: it carries no mutator, so a consumer
 * cannot add a recipient through it even by accident. Routing narrows the
 * candidate set with this; it never writes to the store.
 */
export function approvedRecipients(
  authorization: RecipientAuthorization,
): readonly string[] {
  return Object.freeze(
    authorization.recipients
      .filter((r) => r.scope === "data-recipient")
      .map((r) => r.provider)
      .sort(),
  );
}

// ---------------------------------------------------------------------------
// The gap between the two sets, made visible
// ---------------------------------------------------------------------------

export interface DiscoveryReport {
  readonly discovered: readonly DiscoveredProvider[];
  readonly authorized: readonly string[];
  /** Visible in routing's landscape, not permitted as a destination. */
  readonly discoveredButUnauthorized: readonly string[];
  /** Approved but not currently discoverable -- an approval does not conjure a
   *  provider either. */
  readonly authorizedButUndiscovered: readonly string[];
}

export function reviewDiscovery(
  discovered: readonly DiscoveredProvider[],
  authorization: RecipientAuthorization,
): DiscoveryReport {
  const approved = approvedRecipients(authorization);
  const discoveredNames = discovered.map((d) => d.provider);
  return {
    discovered,
    authorized: approved,
    discoveredButUnauthorized: discoveredNames.filter((p) => !approved.includes(p)).sort(),
    authorizedButUndiscovered: approved.filter((p) => !discoveredNames.includes(p)).sort(),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Runtime state, not source: git-ignored, same as the catalog's. */
export const DEFAULT_RECIPIENTS_PATH = "src/state/authorized-recipients.json";

export function saveAuthorization(
  path: string,
  authorization: RecipientAuthorization,
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(authorization, null, 2)}\n`);
}

export function loadAuthorization(path: string): RecipientAuthorization {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RecipientAuthorization;
  if (parsed.schemaVersion !== RECIPIENTS_SCHEMA_VERSION) {
    throw new Error(
      `authorized-recipients schemaVersion ${parsed.schemaVersion} != expected ${RECIPIENTS_SCHEMA_VERSION}`,
    );
  }
  return Object.freeze({
    schemaVersion: parsed.schemaVersion,
    recipients: Object.freeze([...parsed.recipients]) as readonly AuthorizedRecipient[],
  });
}

/**
 * Load, or start from empty when there is no store yet.
 *
 * Fails CLOSED: a missing or unreadable store yields no approved recipients,
 * never all discovered ones. An unparseable store is the same answer -- the
 * harness would rather delegation nothing than delegate to a provider whose
 * approval it cannot read.
 */
export function loadAuthorizationOrEmpty(path: string): RecipientAuthorization {
  try {
    return loadAuthorization(path);
  } catch {
    return emptyAuthorization();
  }
}
