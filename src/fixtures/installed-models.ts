// Snapshot of this installation's real model registry, captured from
// `pi --list-models` (zero model spend -- it prints the catalog and exits).
//
// Captured verbatim so the prohibition audit runs against ids that actually
// exist here rather than invented ones. Three entries matter more than the rest:
//
//   anthropic/claude-fable-5     -- a REAL Fable model in the live registry.
//   anthropic/claude-fable-5-1   -- and a second one.
//     The obvious allow pattern `anthropic/*` would admit both.
//   openai-codex/gpt-6-astra     -- prohibited by the same user decision;
//     `openai-codex/*` would admit it.
//
// Note 01-findings.md used `openai/fable-1` as the Fable example, and earlier
// captures of this file used `claude-bridge/claude-fable-5`. Neither id exists
// in this registry any more: the `claude-bridge` provider is uninstalled and
// the Claude subscription is now reached through pi's built-in `anthropic`
// provider (see harness/catalog/upstream-mapping.ts). The real Fable ids are
// `anthropic/claude-fable-5` and `anthropic/claude-fable-5-1`, both refused by
// the default subagent ban list (harness/policy/ban-lists.ts).
export const INSTALLED_MODEL_IDS = [
  "anthropic/claude-fable-5",
  "anthropic/claude-fable-5-1",
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-haiku-4-5-20251001",
  "anthropic/claude-opus-4-5",
  "anthropic/claude-opus-4-5-20251101",
  "anthropic/claude-opus-4-6",
  "anthropic/claude-opus-4-7",
  "anthropic/claude-opus-4-8",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-4-5",
  "anthropic/claude-sonnet-4-5-20250929",
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-sonnet-5",
  "openai-codex/gpt-5.3-codex-spark",
  "openai-codex/gpt-5.5",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-6-luna",
  "openai-codex/gpt-6-sol",
] as const;
