---
# pi-orchestrator-mw81
title: Unjudged edits block commit and push
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-28T08:53:07Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-kokv
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. While any editing delegation of this session has no verdict, git commit and git push from the orchestrator are denied with a message naming the unjudged delegations. At the end of each orchestrator turn with unjudged delegations, a notice names them. The final reply and new delegations are never blocked.

Recognising a commit or push is new: the budget's classification only tells read-only and build/test commands apart. Match git commit and git push inside a bash command, including chained commands (&&, ;, |) and git options before the subcommand (git -C <dir> commit).

## Acceptance criteria

- [x] git commit and git push are denied while a verdict is outstanding and allowed once every editing delegation has one
- [x] The deny message and the turn-end notice name each unjudged delegation
- [x] Chained commands and git options before the subcommand are recognised
- [x] Other bash, new delegations and the final reply are not blocked
- [x] Workers are not affected
- [x] Tests

## Blocked by

- pi-orchestrator-kokv

## Summary of Changes

- `src/subagents/commit-gate.ts` (new): `registerCommitGate` hooks pi's `tool_call` in the orchestrator's session only (`isOrchestratorSession`). A `bash` call whose command runs `git commit` or `git push` is denied while any editing delegation of this orchestrator session waits for a verdict; the reason names each one (`delegation <id>`, with `agent <name>` and `still running` when the worker board knows them). A record folder that cannot be read denies a commit or push with the reason. Nothing else is gated: other bash, `git add`, new delegations, the final reply.
- Turn-end notice: a `turn_end` handler sends a `subagents-unjudged` custom message with `triggerTurn: false`, the path a worker's progress report takes (report.ts): pi defers it to the end of the turn, after the tool results, the model reads it at its next request, and it never starts a turn. The handler returns nothing, so it never asks pi to continue and cannot hold back a final reply. `UnjudgedNotices` sends it only when the waiting set (delegation id plus latest edit time, so a resume that edits again counts as new) differs from the last notice, and once more at the first turn end after each user prompt. A failure is logged once, never thrown.
- Matching: `gitSubcommands` in `tool-call-kind.ts` reuses the existing bash reader (chains, pipes, `;`, newlines, heredocs, `env`, assignments, `xargs`) and skips git's own options with values (`-C`, `-c`, `--git-dir`, `--work-tree`, `--namespace`, `--config-env`; `gitKind` now shares that list). A command the reader cannot follow (such as `git commit -m "$(cat <<'EOF' ...)"`) is matched by its text, in the safe direction.
- `src/subagents/editing.ts`: `unjudgedDelegations(records, orchestratorSession)`: editing delegations whose latest edit record has no verdict of either kind after it. The gate level (mxmz) can filter out gate action none in `waiting` in commit-gate.ts.
- Protocol: the verdict paragraph gains "Your git commit and git push are denied until every editing delegation has a verdict."
- README: the Verdicts section documents the block and the notice; intro, protocol and switching-off lines updated.
- Tests: `commit-gate.test.ts` (matcher, deny text, notice de-duplication), `editing.test.ts` (`unjudgedDelegations`), `tool-call-kind.test.ts` (`gitSubcommands`), `extension.test.ts` (a real orchestrator session: denied commit and push naming the delegation, `ls` and a new delegation allowed, a worker's own commit runs, notices once per change and after a final reply without a new turn, accept and request_changes both unblock, the commit then runs; a still-running delegation; an unreadable record folder; the protocol sentence).

Open for the owner:
- `sh -c 'git commit'`, `sudo git commit` and `find -exec git commit` are not recognised; the gate holds the orchestrator to the protocol, it is not a hard boundary (ADR 0005).
- Every orchestrator turn end reads the whole routing record folder.


Orchestrator verdict: accepted. Verified in isolation (a detached worktree with only this ticket's files, because another session has uncommitted widget work in the main tree): typecheck clean, npm test 731 pass 0 fail. Commit gate read. Known gaps: sh -c, sudo and find -exec wrappers are not caught.
