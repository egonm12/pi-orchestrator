// Ticket 05: how a pi routing identity relates to a published-catalog entry.
//
// pi's registry names ROUTES, not upstream models. `anthropic/claude-sonnet-5`
// is a route through pi's built-in Anthropic provider signed in with a Claude
// subscription; models.dev knows a model by the same name under its own
// `anthropic` provider key. The harness needs that correspondence to attach
// published pricing and capability data at all.
//
// The correspondence is an ASSUMPTION, reached by matching names across
// namespaces -- and it stays an assumption even where the two namespaces spell
// the provider identically, because a shared name is still not a confirmation
// that the route reaches that upstream model. The ticket is explicit that a
// registry listing "does not establish ... upstream identity", so it is
// recorded with evidence `assumed-name-mapping` and never as a confirmed fact.
// Anything derived through it inherits that caveat.

/** Billing shape of a route. This is what decides whether a per-call dollar
 *  figure means anything, so it is kept separate from the published price. */
export type RouteBilling = "subscription" | "metered";

export interface UpstreamMapping {
  /** pi provider namespace, as it appears in `pi models`. */
  readonly piProvider: string;
  /** models.dev provider key the ids are assumed to correspond to. */
  readonly upstreamProvider: string;
  readonly billing: RouteBilling;
  /** Why we believe the billing shape. Cited in the catalog's provenance. */
  readonly billingBasis: string;
}

// Both routes on this installation are subscription-routed. For `anthropic`
// that is not merely an operator statement -- it is what the installed
// packages do, and the sources are cited in `billingBasis` below so a reviewer
// can re-read them:
//
//   - @gotgenes/pi-anthropic-auth README ("What It Does"): the extension exists
//     to make a Claude Pro/Max OAuth subscription work on pi's built-in
//     `anthropic` provider. It is installed here (agent/settings.json
//     `packages`).
//   - @gotgenes/pi-anthropic-auth src/billing-header.ts: every shaped request
//     carries `x-anthropic-billing-header`, which "identifies the request as
//     Claude Code usage. Without it, Anthropic classifies an OAuth request as
//     third-party app usage and rejects it with a 400 disguised as 'You're out
//     of extra usage.'" A prior harness run reproduced exactly that 400 with
//     stored OAuth credentials and the extension absent.
//   - pi's own startup notice (pi-coding-agent bundle,
//     ANTHROPIC_SUBSCRIPTION_AUTH_WARNING): "Third-party harness usage draws
//     from extra usage and is billed per token, not your Claude plan limits."
//     That is the UNSHAPED case. The extension's README says the warning "is
//     not entirely wrong": interactive turns, compaction and
//     `ctx.modelRegistry.streamSimple()` are shaped, while an extension that
//     calls pi-ai's `compat.streamSimple` directly is not. This harness
//     dispatches through ordinary pi sessions, so its calls are on the shaped,
//     plan-billed path.
//
// So the billing SHAPE is subscription, and no per-call dollar amount exists
// for it. That is deliberately not the same claim as "free": `billing` only
// ever suppresses a billed-cost figure (see model-catalog.ts), never asserts a
// zero. The residual unshaped path is recorded in the basis rather than hidden,
// because it is the one way an anthropic call here could become metered.
//
// For openai-codex the basis is still only the operator's statement.
// 01-findings.md §B.2 corroborates the general shape: those runs DID report
// non-zero figures (up to $6.136058), but a reported figure on a subscription
// route is a list-price-derived estimate of consumption, not an amount billed
// per call. Recording billing separately from price is what keeps those apart.
export const UPSTREAM_MAPPINGS: readonly UpstreamMapping[] = [
  {
    piProvider: "anthropic",
    upstreamProvider: "anthropic",
    billing: "subscription",
    billingBasis:
      "Claude Pro/Max OAuth subscription via installed @gotgenes/pi-anthropic-auth: " +
      "its billing header marks requests as Claude Code usage billed against plan " +
      "limits (README 'What It Does'; src/billing-header.ts), and without it Anthropic " +
      "rejects the OAuth request as third-party usage ('You're out of extra usage'), " +
      "reproduced on this installation. Residual exposure: pi's own notice " +
      "(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING) describes unshaped call paths -- an " +
      "extension calling pi-ai compat.streamSimple directly -- which do draw metered " +
      "extra usage; this harness does not use that path",
  },
  {
    piProvider: "openai-codex",
    upstreamProvider: "openai",
    billing: "subscription",
    billingBasis:
      "operator-stated subscription route; pi's recorded per-run figures " +
      "(01-findings.md §B.2) are list-price-derived consumption estimates, " +
      "not per-call billed amounts",
  },
] as const;

export function mappingFor(piProvider: string): UpstreamMapping | undefined {
  return UPSTREAM_MAPPINGS.find((m) => m.piProvider === piProvider);
}

/** The upstream provider keys the vendored snapshot must contain. The refresh
 *  script derives its subset from this, so the pin follows the mapping instead
 *  of being hand-picked. */
export function requiredUpstreamProviders(): string[] {
  return [...new Set(UPSTREAM_MAPPINGS.map((m) => m.upstreamProvider))].sort();
}
