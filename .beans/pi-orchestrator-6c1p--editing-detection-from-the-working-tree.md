---
# pi-orchestrator-6c1p
title: Editing detection from the working tree
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 37 to 41).

## What to build

A delegation is editing when the working tree changed while its worker ran, or when the worker used `edit` or `write`. A snapshot of the working tree (tracked changes plus untracked files) is taken when a worker starts and when it ends. The changed paths feed the reviewer's file list. A change made while workers overlapped is attributed to each of them. Without a git repository the current command rule stays.

## Acceptance criteria

- [ ] Bash that changed nothing: not editing, no verdict asked
- [ ] Bash that changed the tree: editing, changed paths in the reviewer's file list
- [ ] An `edit` or `write` outside the repository: editing
- [ ] Two overlapping workers: a change counts for each
- [ ] No repository: the old command rule applies
- [ ] End-to-end tests with `routedHarness` and `createTempRepo`

## Blocked by

None, can start immediately.
