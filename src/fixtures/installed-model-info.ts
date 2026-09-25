import type { ModelInfo } from "../subagents/model-info.ts";

// Thinking facts for every id in ./installed-models.ts, as pi's model
// registry defines them. Captured 2026-09-24 from pi-ai 0.87.1's provider
// data, installed at
// `~/.bun/install/global/node_modules/@earendil-works/pi-ai/dist/providers/data/`
// (`anthropic.json` and `openai-codex.json`), keeping only the fields
// pi-subagents' `getSupportedThinkingLevels` reads: `reasoning` and
// `thinkingLevelMap`.
//
// Ticket 22's tier-map loader takes the installed models as an input and asks
// that pi function which efforts a model supports. `pi --list-models` does not
// print these fields, so ./installed-models.ts cannot carry them; ticket 27's
// extension will pass pi's live registry instead of this snapshot.
//
// Examples the tier-map tests rely on:
//   anthropic/claude-haiku-4-5  no map: off through xhigh, not max.
//   anthropic/claude-opus-5     `off: null`: every level except off.
export const INSTALLED_MODEL_INFO: readonly ModelInfo[] = [
  { provider: "anthropic", id: "claude-fable-5", fullId: "anthropic/claude-fable-5", reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
  { provider: "anthropic", id: "claude-fable-5-1", fullId: "anthropic/claude-fable-5-1", reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
  { provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5", reasoning: true },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001", fullId: "anthropic/claude-haiku-4-5-20251001", reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-5", fullId: "anthropic/claude-opus-4-5", reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-5-20251101", fullId: "anthropic/claude-opus-4-5-20251101", reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-6", fullId: "anthropic/claude-opus-4-6", reasoning: true, thinkingLevelMap: { max: "max" } },
  { provider: "anthropic", id: "claude-opus-4-7", fullId: "anthropic/claude-opus-4-7", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
  { provider: "anthropic", id: "claude-opus-4-8", fullId: "anthropic/claude-opus-4-8", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
  { provider: "anthropic", id: "claude-opus-5", fullId: "anthropic/claude-opus-5", reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" } },
  { provider: "anthropic", id: "claude-opus-5-5", fullId: "anthropic/claude-opus-5-5", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  { provider: "anthropic", id: "claude-sonnet-4-5", fullId: "anthropic/claude-sonnet-4-5", reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-4-5-20250929", fullId: "anthropic/claude-sonnet-4-5-20250929", reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-4-6", fullId: "anthropic/claude-sonnet-4-6", reasoning: true, thinkingLevelMap: { max: "max" } },
  { provider: "anthropic", id: "claude-sonnet-5", fullId: "anthropic/claude-sonnet-5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } },
  { provider: "openai-codex", id: "gpt-5.3-codex-spark", fullId: "openai-codex/gpt-5.3-codex-spark", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", minimal: "low" } },
  { provider: "openai-codex", id: "gpt-5.5", fullId: "openai-codex/gpt-5.5", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", minimal: "low" } },
  { provider: "openai-codex", id: "gpt-5.6-luna", fullId: "openai-codex/gpt-5.6-luna", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" } },
  { provider: "openai-codex", id: "gpt-5.6-sol", fullId: "openai-codex/gpt-5.6-sol", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" } },
  { provider: "openai-codex", id: "gpt-5.6-terra", fullId: "openai-codex/gpt-5.6-terra", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max", minimal: "low" } },
  { provider: "openai-codex", id: "gpt-6-astra", fullId: "openai-codex/gpt-6-astra", reasoning: true, thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  { provider: "openai-codex", id: "gpt-6-luna", fullId: "openai-codex/gpt-6-luna", reasoning: true, thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  { provider: "openai-codex", id: "gpt-6-sol", fullId: "openai-codex/gpt-6-sol", reasoning: true, thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
];
