---
# pi-orchestrator-9xq7
title: Reviewers cannot run read-only shell commands
status: todo
type: bug
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:55:30Z
updated_at: 2026-09-28T14:56:06Z
---

## Problem

A reviewer worker cannot run read-only shell commands. During the review of e0abfd7 (bean pi-orchestrator-zb6t), every Bash, ctx_execute and ctx_execute_file call a reviewer made was denied with "pi-orchestrator: a reviewer changes nothing, and this call would edit". That included git show, git status, beans prime, npx tsc --noEmit and test runs. So a reviewer cannot verify typecheck, tests or diffs, and has to take the implementer's Verified by section on trust.

## Where to look

- src/subagents/editing.ts:40 blocks, with REVIEWER_EDIT_DENIED (editing.ts:32), each call that isEditingToolCall (editing.ts:25) says edits. isEditingToolCall counts every ctx_execute and ctx_execute_file call as editing by design (ARBITRARY_CODE_TOOLS, editing.ts:21), and a bash call when classifyToolCall (src/subagents/tool-call-kind.ts) says edit, version-control or unrecognised.
- Checked in isolation on 2026-09-28: classifyToolCall("bash", ...) says read-only for git show, git status and cd ... && git show, and build-test for npx tsc --noEmit, npm test and node --test, so isEditingToolCall does not call them editing. beans prime is unrecognised, so it is denied.
- So the denial of the git and tsc calls comes from somewhere else (unverified). One suspect: the context-mode hook routes a reviewer's Bash call into ctx_execute, which is always denied. Another: the tool name or input shape a real reviewer session sends differs from what the classifier expects.
- review.test.ts has a test ("a reviewer's editing calls are denied with the reason, its reads, searches, builds and tests run") that says reads, builds and tests run. It may use a different tool shape from a real reviewer session.

## Expected

A reviewer can run read-only and verifying commands (git show, git status, git diff, beans prime, npx tsc --noEmit, node --test, npm test), and is still denied every call that edits.

## Todo

- [ ] Reproduce with the exact tool calls a real reviewer session made (Bash, ctx_execute with language shell, ctx_execute_file)
- [ ] Find why each is classified as editing
- [ ] Failing test first, then fix
