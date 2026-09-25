// Why a rung is passed over: ticket 24's hard-filter reasons and the effort
// ladder's max opt-in (ticket 26). The router re-exports REMOVAL_REASONS.
//
// This module imports nothing, so the decision-record reader can validate
// ladder records without loading the router: the report CLI runs under Node's
// permission model with a fixed list of readable module sources.

/** The hard filters, in the order a rung is checked against them. A rung is
 *  removed by the first one it fails. */
export const REMOVAL_REASONS = [
  "subagent ban list",
  "allowed-model list",
  "provider out of usage",
  "provider throttled",
  "context window",
  "allowance preflight",
  "unapproved recipient",
] as const;

export type RemovalReason = (typeof REMOVAL_REASONS)[number];

export const MAX_NOT_LISTED = "max not listed";

/** Every reason the effort ladder skips a candidate. */
export const LADDER_SKIP_REASONS = [...REMOVAL_REASONS, MAX_NOT_LISTED] as const;

export type LadderSkipReason = (typeof LADDER_SKIP_REASONS)[number];
