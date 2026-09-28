---
# pi-orchestrator-6c1p
title: Editing detection from the working tree
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T22:24:06Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 37 to 41).

## What to build

A delegation is editing when the working tree changed while its worker ran, or when the worker used `edit` or `write`. A snapshot of the working tree (tracked changes plus untracked files) is taken when a worker starts and when it ends. The changed paths feed the reviewer's file list. A change made while workers overlapped is attributed to each of them. Without a git repository the current command rule stays.

## Acceptance criteria

- [x] Bash that changed nothing: not editing, no verdict asked
- [x] Bash that changed the tree: editing, changed paths in the reviewer's file list
- [x] An `edit` or `write` outside the repository: editing
- [x] Two overlapping workers: a change counts for each
- [x] No repository: the old command rule applies
- [x] End-to-end tests with `routedHarness` and `createTempRepo`

## Blocked by

None, can start immediately.


## Summary of changes

- `src/subagents/working-tree.ts` (new): a snapshot of the repository the worker's working directory is in (HEAD plus every path `git status --untracked-files=all --no-renames` names, with a content fingerprint), and the changed paths between two snapshots, including the paths a moved HEAD changed. `undefined` outside a git repository.
- `src/subagents/editing.ts`: `trackEdits` takes a snapshot as a worker starts and compares it as it ends (`finish()`, which replaces `edited()` and `stop()`). In a repository only `edit` and `write` count as calls (they still write their edit record at once); a changed tree, or a moved HEAD, makes the run editing and writes a `working-tree` edit record with the changed paths. Each worker compares on its own, so a change made while workers overlapped counts for each. Without a repository, or when the end snapshot fails, the command rule decides as before. Reviewers, and workers they start, take no snapshot.
- `src/routing/decision-record.ts`: edit records get optional `paths` (at most 100, redacted like free text) and `omittedPaths`.
- `src/subagents/review.ts`: the reviewer's file list adds the paths of the delegation's `working-tree` edit records, and says they can hold changes of workers that ran at the same time.
- `src/subagents/worker.ts`: passes the worker's cwd and whether it is read-only to `trackEdits`.
- `src/subagents/extension.ts`, `src/subagents/tool-call-kind.ts`: stale comments fixed (commit and push are no longer held back; the exploration nudge replaced the budget).
- README: Verdicts and Reviewers describe the working-tree rule, the extra edit record and the file list.
- Tests (`src/subagents/extension.test.ts`, routedHarness with createTempRepo): bash that changed nothing, bash that changed the tree with the reviewer's file list, edit and write outside the repository, two overlapping workers, and no repository.

## Review follow-up

- `src/subagents/working-tree.ts`: `git status` runs as `git --no-optional-locks status`, so a snapshot takes no `index.lock` while an overlapping worker runs `git add` or `git commit`. A failed `git status` makes the snapshot `undefined`, at the start or the end, so the worker completes and the command rule decides for that run, as without a repository.
- README (Verdicts): says the snapshot takes no optional locks and that the command rule decides when either snapshot fails.
- Test (`src/subagents/extension.test.ts`, routedHarness with createTempRepo and a logging `git` wrapper first on PATH): every snapshot's `git status` carries `--no-optional-locks`; with `git status` failing as the workers start, and as they end, both workers complete, `cat` is not editing, `echo > notes.md` is editing by the command rule, and only `bash` edit records are written.
