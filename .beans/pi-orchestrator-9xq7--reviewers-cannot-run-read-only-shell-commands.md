---
# pi-orchestrator-9xq7
title: Reviewers cannot run read-only shell commands
status: completed
type: bug
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:55:30Z
updated_at: 2026-09-28T15:10:07Z
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

- [x] Reproduce with the exact tool calls a real reviewer session made (Bash, ctx_execute with language shell, ctx_execute_file)
- [x] Find why each is classified as editing
- [x] Failing test first, then fix


## Findings

- The three reviewer sessions (subagents/01a0e857-..., files 01a0e877-8c43, 01a0e877-8c4c and 01a0e885-00bb) sent every shell call as tool `bash` with input `{ command, timeout }`, for example `{"command": "git -C <repo> show --stat e0abfd7", "timeout": 60}`. Every `bash`, `ctx_execute` and `ctx_execute_file` result was the denial; `read` calls ran.
- Root cause: the pi-claude-hooks package runs Claude Code's PreToolUse hooks as a `tool_call` hook, and ~/.claude/settings.json has `rtk hook claude` for Bash. That hook rewrites `event.input.command` in place (pi lets a `tool_call` handler mutate the input, and later handlers see the change): `git -C x show --stat e0abfd7` becomes `rtk git -C x show --stat e0abfd7`, `wc -l f` becomes `rtk wc -l f`, `npx tsc --noEmit` becomes `rtk tsc --noEmit`. The reviewer guard (READ_ONLY_REVIEWER, src/subagents/editing.ts) then saw `rtk ...`, which classifyToolCall called unrecognised, so editing, so denied. Checked with `rtk hook claude` (rtk 0.49.0) and classifyToolCall on its output.
- `beans prime` is not rewritten by rtk, but classifyToolCall called it unrecognised, so it was denied too.
- context-mode's pi `tool_call` hook only blocks inline HTTP calls and does not change the input, so it was not the cause.
- The same rewrite hid `rtk git commit` from the commit gate (gitSubcommands returned `[]`), and made every worker that ran `rtk git status` or similar an editing delegation.

## Decisions

- `beans prime`, `beans show` and `beans list` are read-only in the classifier; every other beans command stays unrecognised, since create, update, archive and the rest change `.beans`. That also means a worker that only runs those three is not an editing delegation, which is correct: they write nothing. The subcommand is read after beans' global options `--beans-path` and `--config` and their values, so `beans --beans-path show update x` is an update.
- `rtk err`, `rtk test`, `rtk summary` and `rtk proxy` stay unrecognised, like `sh -c` (review of b681070). The first three join their arguments with spaces and run the result with `sh -c`, so `rtk err cat x ';' rm -rf src` removes `src`; `proxy` splits a lone argument with spaces into a command, so `rtk proxy 'rm -rf src/cat'` runs `rm`. rtk's hook never rewrites a command to them, so reviewers lose nothing. The commit gate's `gitSubcommands` sees through them no better than through `sh -c`: `rtk proxy git push` is no longer read as a push.
- `ctx_execute` and `ctx_execute_file` stay denied for reviewers and stay editing for workers. They run code in any language (the transcripts show JavaScript with `require('fs')`), and ADR 0010 counts them as editing by owner decision. Classifying only `language: shell` with the bash reader would be possible, but it would change ADR 0010's editing rule and is not needed now that `bash` works for reviewers.

## Summary of changes

- src/subagents/tool-call-kind.ts: the bash reader treats `rtk` as a wrapper. `rtk <tool> ...` has the kind of `<tool> ...`, `rtk read` is read as `cat` and `rtk lint` as `eslint`, and any other rtk subcommand (`init`, `config`, `run`) stays unrecognised. `rtk err`, `test`, `summary` and `proxy` run a command through a shell or split one, so `rtkCommand` returns nothing for them and `commandWords` leaves the command as `rtk ...`, which is unrecognised (fix after review of b681070, which read them as the command after them). Because the wrapper sits in `commandWords`, the commit gate's `gitSubcommands` sees `rtk git commit` as `commit` too. `beans prime`, `show` and `list` are read-only, after the global options `--beans-path` and `--config` and their values.
- src/subagents/review.test.ts: a reviewer test with a fake hook that rewrites `bash` input in place as rtk does, replaying the transcript's calls (`git -C <dir> show --stat e0abfd7`, `cd <dir> && git show ... && git status --short`, `wc -l`, `cd <dir> && beans prime | head -50`); they run, and `git commit -m x` rewritten to `rtk git commit -m x` is still denied. It failed before the fix on the `git show` call. After review, it also replays `cd <dir> && rtk summary ls '>' notes.md`, which is denied; it failed before that fix.
- src/subagents/tool-call-kind.test.ts: classifier tests for the rtk forms rtk's hook produces, for rtk commands that stay unrecognised or version-control, for `gitSubcommands` through rtk, and for beans. After review: a test that each quoted shell form through `rtk err`, `summary`, `proxy` and `test` is unrecognised and that `gitSubcommands` reads them as it reads `sh -c`, and a test for beans' global options. Both failed before the fix.
- README.md: the exploration budget section says how beans and rtk commands are read, and why the four rtk runners are unrecognised. That README change went into 909ff9b (bean pi-orchestrator-2uc7), whose commit took the whole README while both were edited in the same tree.
