---
# pi-orchestrator-c1sw
title: Fork rung test fails on any day but 2026-09-26
status: completed
type: bug
created_at: 2026-09-27T13:53:55Z
updated_at: 2026-09-27T13:53:55Z
parent: pi-orchestrator-a338
---

The test "queued forks keep their call-time rung when the session switches model; ordinary items still route" in src/subagents/extension.test.ts expected routing records in write order: fork, fork, decision. The test router's clock is fixed at NOW (2026-09-26T12:00Z), so the decision record lands in 2026-09-26.jsonl, while fork records carry the real date. From 2026-09-27 on, the fork records land in a later day file, and readRoutingRecords sorts day files by name, so the decision came first and the test failed. Found while merging wave 3 of a338.

## Summary of Changes

The test now compares the record types sorted, since it only cares that two fork records and one decision are written, not their order across day files. Test-only change; no product code touched.
