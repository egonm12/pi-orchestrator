---
status: accepted
date: 2026-09-24
---

# Classify with a general instruction model, not a Jev-class decision engine

LiteLLM's auto-routing supports Jev (TypeSafe) and other System-One decision engines as the classifier. JevBench v1.4.1 (benchmarkheaven.com/jev-models, read 2026-09-24) shows why we do not: the top-ranked Jev-class model reaches roughly 84% public and 30% sealed accuracy, while GPT-6 Luna at low effort, asked the same questions as a plain instruction model with a JSON schema, reaches 99.1% and 92.9%. Jev-class models win the composite score on speed and cost per decision, which do not matter for a routing decision that steers an entire delegated task and costs a fraction of a cent either way. The classifier is therefore a general model with a fixed rubric and a JSON schema, `openai-codex/gpt-6-luna:low` by default, configurable, with a fallback list and keywords as the last resort.

## Consequences

- Every routing decision costs one small model call, charged to the task allowance, so it is visible and never free.
- The classifier model is a rung like any other: it must pass the subagent ban list and the allowed-model list.
- Revisit if a decision engine reaches comparable sealed accuracy; the classifier is behind one setting.
