# pi-orchestrator

A [pi](https://pi.dev) package with three extensions for sessions that delegate work to workers:

- **Subagents**: the built-in `subagents` tool. It starts workers in the orchestrator's own process, on the auto model `orchestrator/auto`, and gives the orchestrator's own session the orchestrator protocol, the exploration nudge, the `subagents_verdict` tool and a block on git commit and git push while edits wait for a verdict.
- **Router extension**: serves the auto model `orchestrator/auto`. It classifies a worker's first request into a tier and routes it to a rung from your tier map.
- **Guard**: enforces a personal subagent ban list for workers and an optional session ban list for the orchestrator.

The three are independent. You can switch any one off without touching the others.

## Install

```sh
pi install git:github.com/egonm12/pi-orchestrator
```

Or from a local checkout:

```sh
pi install ~/path/to/pi-orchestrator
```

The package ships its own `subagents` tool (see below), so an orchestrator session needs no separate subagent extension to start workers. Other subagent extensions that start workers on `orchestrator/auto` still work and are still routed; use one for chains, which the built-in tool does not do. For another extension's background workers, install pi-orchestrator as a package, not just with `pi -e`: their separate process loads installed packages. The package has no runtime dependencies of its own.

## Set up with `init`

A fresh install ships no tier map, no ban list and no approved recipients, so routing is not enabled yet. At the start of the orchestrator's own session (not a worker's, and not in a pi-subagents child process) the notice names what is missing:

```text
pi-orchestrator: not set up: no tier map (...), no approved recipients (...). Run /pi-orchestrator init.
```

Run `/pi-orchestrator init` in an interactive session. It:

1. Asks which models workers may never use (comma-separated substrings, such as `fable, astra`, or empty for none).
2. Writes a starter tier map from your installed models into personal settings, in **shadow** mode, together with the ban list. An existing tier map, classifier or ban list is never replaced.
3. Asks you to approve each provider the map would send task text to. Only the providers you say yes to are approved. A declined provider's rungs are skipped.

Review the written map in `~/.pi/agent/settings.json`, then start a new session. Workers started through the built-in `subagents` tool always run on `orchestrator/auto` already; nothing else needs setting up for them.

`/pi-orchestrator` takes a subcommand as its first word: `init` comes with the router extension, `gate` with the subagents extension (see Gate level below). With one of them switched off, its subcommands are gone and the other's stay. Without a subcommand, or with one it does not know, it prints the usage with every subcommand.

## Subagents tool

The `subagents` tool starts workers in the orchestrator's own process, by default on the auto model `orchestrator/auto`. One call takes 1 to 8 items:

```json
{ "items": [
  { "task": "Fix the typo in README.md" },
  { "task": "Add a test for the new validation rule", "agent": "reviewer" },
  { "resume": "<delegation id>", "task": "Continue the test with the new case" }
] }
```

Each item's `task` is the whole task for an ordinary worker, with every fact it needs: an ordinary worker sees nothing else. `agent` is optional; see Agent definitions below. Set `fork: true` to give a forked worker the orchestrator's current branch, ending before the assistant message containing the delegating tool call:

```json
{ "items": [
  { "task": "Review this change in context", "fork": true },
  { "task": "Check the isolated test suite" }
] }
```

A fork uses the session model and thinking level at call time, without routing. Later model changes do not move it, even while it is queued. It can use a banned session model as an exception to the subagent ban list; its fork record marks that exception. An `agent` on a fork supplies instructions and narrowed tools, but its `model` and `thinking` are ignored without a warning. A fork gets no reporting rules (see Results below). Forked workers never receive the `subagents` tool. Forks and ordinary workers may share a call. An item with `review` set to a finished editing delegation's id starts an independent reviewer for it (see Reviewers below). An item with `retry` set to a delegation whose latest verdict is `request_changes` starts a new attempt with `task` as feedback (see Retries below). At most `orchestrator.subagents.maxParallel` items (default 4) run at once, the rest queue. The orchestrator waits for every item; Ctrl+C aborts running workers and drops queued ones.

### Background calls

With `"background": true` next to `items`, the call returns at once with its call id and one delegation id per item, in item order. The items run on while the orchestrator does other work, each call with its own `maxParallel`. When every item has finished, one completion notice arrives with the same result text as a foreground call, headed by the call id. It is delivered as a follow-up message: it starts a turn when the orchestrator is idle, and otherwise waits for the current turn to end.

`orchestrator.subagents.maxBackgroundWorkers` (default 8) caps the background workers, queued or running, across the session's background calls; a call that would exceed it is refused with the reason, and starts no worker. Ctrl+C leaves background workers running. `/subagents stop <id>` stops one: a call id stops the whole call (running workers abort, queued ones are not started), a delegation id stops that worker alone, and `all` stops every call. A stopped call still sends its notice. When the orchestrator's session ends, its background workers are aborted, and each call's notice, with status `aborted`, is recorded in the session without starting a turn. A worker's own `subagents` call cannot be background.

### Messages

Use `subagents_message({ "id": "<delegation id>", "text": "Check this case", "mode": "steer" })` to message one running background worker. `mode` defaults to `"steer"`, delivered after its current tool call and before the next model request. `"followUp"` is delivered when the worker would otherwise stop. The same tool answers a worker's `report` question: its next message unblocks the waiting question. Call ids, queued or finished workers, foreground workers and unknown ids are refused. Workers cannot use `subagents_message`.

### Reports

Every worker has a `report` tool, `{ "kind": "progress" | "question", "text": string }`, to message the agent that delegated to it on its own, whatever its agent definition's `tools:` list says:

- `progress` is a short note, and the worker goes on at once. It is recorded in the session as a `subagents-report` message without starting a turn, so the orchestrator reads it at its next turn. An idle orchestrator's TUI shows the message at once; while the orchestrator is busy, pi records the message when the current turn ends, so the TUI shows the note at once as a notification.
- `question` is only for background workers; a foreground worker's `report` has no question kind. The question starts an orchestrator turn when the orchestrator is idle, and is steered in after its current tool call when it is busy. The worker waits for the answer without a time limit: the next `subagents_message` to its delegation id is the answer and the `report` tool's result. `/subagents stop`, stopping its call or ending the session releases the worker, which then aborts.

A question ends a pending `subagents_status` wait on its call, which would otherwise hold the orchestrator's turn until the call ends: the wait fails with a hint to answer with `subagents_message` and wait again. A new wait on a call with an unanswered question is refused with the same hint. The call runs on, and its completion notice goes to a later wait or to the session as usual.

A worker started by another worker reports to that worker, progress only, since a worker's calls are foreground.

### Results

A worker's final reply is its Result. Every worker except a fork gets the reporting rules appended to its system prompt, whatever its agent definition says, and before that definition's instructions: verify before reporting, give `file:line` for every factual claim, label unverified claims, say what could not be checked and why, and do only what the task asks. The Result ends in five sections, each under its own heading: Confirmed, Changed, Unverified, Could not check and Verified by (the commands the worker ran). A resumed worker gets the rules again; a resumed fork does not.

When a worker other than a fork completes, the runtime checks its Result's section headers, without a model call. A markdown heading or a bold label starting with a section's name counts, as does a plain line of the name alone or followed by a colon. A Result missing one or more sections gets a note naming them after its text in that worker's part of the tool result, and the item's `missingSections` in `details` lists them. The check never rejects a Result, and a complete one gets no note.

### Verdicts

A delegation that edited needs the orchestrator's verdict, unless the gate level leaves it ungated (see Gate level below). It edited when its worker, or a worker it started (see Nested delegation below), ran one of these calls:

- `edit` or `write`;
- `bash` that is neither a read-only search nor a build or test run, as the exploration nudge classifies it (see Exploration nudge below): unrecognised commands, redirects into a file, and version-control actions such as `git commit` or `git checkout` all count; so does `powershell`;
- `ctx_execute` or `ctx_execute_file`, which run whatever code they are given, although the exploration nudge counts them as exploratory.

Only a call that ran counts: one a `tool_call` hook blocked, or one for a tool the worker does not have, edited nothing. Other tools, `mcp` and `ctx_batch_execute` included, do not count.

The first editing call in a worker's run writes an edit record into the routing record folder (see State below): the delegation id, the orchestrator session and the tool, with `nestedDelegationId` when a worker's own worker made it. The fact outlives the worker, a pi reload and a resume of the orchestrator's session. A resumed delegation keeps its delegation id, and a resume that edits writes another edit record for it. The editing delegation's part of the tool result, and of a background call's completion notice, carries one line after the session file:

```text
This delegation edited. Judge its Result, then record a verdict with subagents_verdict.
```

That line is for a delegation whose gate action is a spot check (see Gate level below). For one that needs a reviewer (see Reviewers below), the line says so instead:

```text
This delegation edited and is elevated: at the medium gate level it needs an independent reviewer. Start one with a subagents item whose review is <id>, judge the reviewer's Result, then record a verdict with subagents_verdict naming it as reviewer.
```

For an ungated delegation, one whose gate action is none, it says that no verdict is needed:

```text
This delegation edited. At the low gate level a mechanical delegation needs no verdict: it is ungated. You may still judge its Result and record a verdict with subagents_verdict.
```

The line follows the gate level in force when the call's results are written.

A worker's own `subagents` call does not show the line: its workers' edits count for the worker's delegation, whose own Result shows it.

The orchestrator records its verdict with `subagents_verdict`, `{ "delegationId": string, "verdict": "accept" | "request_changes", "reason": string, "reviewer"?: string, "gateLevel"?: "low" | "medium" | "high" | "max", "gateLevelReason"?: string }`, whether it judged the Result by its own spot check or by a reviewer's Result; `reviewer` is the delegation id of that reviewer, and `gateLevel` with `gateLevelReason` raises the gate level for this delegation (see Gate level below). An ungated delegation takes a verdict too. The verdict is attached to the delegation's decision record, its fork or agent-model record, or, for an unrouted retry, its effort-ladder record, or otherwise its edit record; a verdict on a known editing delegation is never orphaned. The reason is recorded with the verdict, credential-shaped text redacted and cut to 500 characters. A verdict on a routed delegation that chose a rung is also a learning observation, as before. The tool replies `Recorded <verdict> on delegation <id>.`, with `, reviewed by delegation <reviewer id>` before the full stop when it names a reviewer, and `, with its gate level raised from <level> to <level>` when it raises the level. A same-rung review is named in the reply and marked on the verdict record. A later verdict adds `It replaces the earlier <verdict>.`: it replaces the earlier one in the routing report, and the record keeps both. For `request_changes`, the reply also names the next effort-ladder rung and how to retry, says why the ladder cannot place the failed attempt, or refuses a retry when the ladder is exhausted or the task has climbed twice. It refuses, and records nothing, when:

- the delegation id is unknown;
- the delegation did not edit: a research Result is checked but gets no verdict;
- the id is a worker's own worker: the refusal names the delegation its edits count for;
- the delegation is still queued or running;
- the delegation belongs to another orchestrator session;
- the delegation needs a reviewer at the gate level in force, or at the one the verdict raises it to, and the verdict names none (see Reviewers below);
- `gateLevel` is not higher than the gate level in force (the orchestrator may raise it, never lower it), is not a gate level, or comes without a `gateLevelReason`, or a `gateLevelReason` comes without it;
- the named reviewer is not a completed review of this delegation by this orchestrator session, started after the delegation's latest edit: the refusal says which;
- the verdict is not `accept` or `request_changes`, or the reason is blank, or a given `reviewer` is blank;
- a worker calls it: workers never get `subagents_verdict`, even when their agent definition's `tools:` list names it.

While any editing delegation of the orchestrator's session waits for a verdict, its `bash` calls that run `git commit` or `git push` are denied. A delegation waits from its latest edit record until a verdict of either kind, `accept` or `request_changes`, is recorded after it, so a resume that edits again waits again. An ungated delegation, one whose gate action is none at the gate level in force, never waits: neither the deny nor the turn-end notice names it. The reason names each waiting delegation, with its agent and whether it still runs when the orchestrator's process knows them:

```text
pi-orchestrator: git commit is denied while 2 editing delegations wait for your verdict: delegation <id>, delegation <id> (agent scribe, still running). Judge each Result and record its verdict with `subagents_verdict`, then commit.
```

A commit or push is found anywhere in the command: in a chain or a pipe (`npm test && git commit -m x`, `git status; git push`), after git's own options (`git -C <dir> commit`, `git -c k=v push`), through `env` or `xargs`. A command the bash reader cannot follow, such as `git commit -m "$(cat <<'EOF' ...)"`, is matched by its text: `git`, git's options, then `commit` or `push`. Other `bash`, `git add` included, and the final reply are never blocked, nor are new delegations: the runtime cannot tell before a worker runs whether it will edit. When the record folder cannot be read, a commit or push is denied with the reason.

At the end of each orchestrator turn with delegations waiting, a notice names them the same way, and says that commit and push are denied until each has a verdict. It is sent like a worker's progress report: shown at once, read by the model at its next request, and never starting a turn, so it follows a final reply without holding it back. It repeats only when the waiting delegations change, and once at the first turn end of each user prompt. Workers, forked workers and sessions in a pi-subagents child process commit and push unhindered.

When a run of an editing delegation ends, the orchestrator's copy of the extension writes its gate requirement into the routing record folder: the delegation id, the gate level in force at that moment and the gate action at it (`none`, `spot-check` or `reviewer`). A resume that edits again writes a fresh one, and the latest counts; a run that did not edit writes none, and a worker's own worker leaves it to the delegation its edits count for. The requirement is written when the worker ends, not at pi's `session_shutdown`, which also fires for a reload, a resume, a new session and a fork.

The routing report, `node src/routing/routing-report.ts <state dir>/routing`, counts per tier and rung, for each delegation once:

- `accept` and `request_changes`: its latest verdict, unless that verdict rests on a same-rung review;
- `same-rung accept` and `same-rung request_changes`: its latest verdict when that verdict rests on a same-rung review (see Reviewers below), counted apart from the others;
- `ungated`: an editing delegation whose latest gate requirement is gate action none, whether or not it got a verdict anyway;
- `missing`: an editing delegation whose latest gate requirement needs a verdict, and that has no verdict recorded after its latest edit record. A verdict recorded later, in a resumed orchestrator session say, takes it out of `missing`.

Ungated delegations and missing verdicts are not verdicts, and neither is a learning observation. The report is where a skipped gate stays visible (ADR 0013). Delegations without a routing decision (forks, agent-model workers and unrouted workers) have no row; they are counted the same way on their own line, `unrouted delegations: ...`. For example:

```text
tier standard, rung anthropic/claude-sonnet-5:medium: decisions 3, accept 1, request_changes 0, same-rung accept 0, same-rung request_changes 1, ungated 1, missing 0, shadow agreement 1 of 2 (50%)
unrouted delegations: accept 1, request_changes 0, same-rung accept 1, same-rung request_changes 0, ungated 1, missing 1
```

A verdict is only ever `accept` or `request_changes`, recorded by the orchestrator with `subagents_verdict`. Verdicts are never read from a reviewer's structured output, and the pi-subagents `verdict-reviewer` agent is no longer shipped.

### Gate level

The gate level sets, per tier, what an editing delegation needs before it is judged: its gate action. *None* needs no verdict (the delegation is ungated), a *spot check* is the orchestrator's own verdict, and a *reviewer* is an independent reviewer worker (see Reviewers below).

| Tier | low | medium | high | max |
|---|---|---|---|---|
| mechanical | none | spot check | spot check | reviewer |
| standard | none | spot check | reviewer | reviewer |
| elevated | spot check | reviewer | reviewer | reviewer |
| critical | reviewer | reviewer | reviewer | reviewer |

A delegation without a tier (a fork, a worker on an agent definition's named model, or a worker the router did not route) counts as elevated. The tier is the one its latest decision, fork or agent-model record names (see Reviewers below). At max, every reviewer is told to rerun the Result's Verified by commands.

The level is `orchestrator.subagents.gateLevel` in personal settings, default `medium`; a project may override it when personal settings allow project overrides (see `orchestrator.subagents` settings below). `/pi-orchestrator gate <level>` sets it for the current orchestrator session, higher or lower, until the next session start (a new or resumed session, or a reload); `/pi-orchestrator gate` shows the level in force and whether it comes from settings or the session. Any other argument prints `usage: /pi-orchestrator gate [low|medium|high|max]` and changes nothing. The setting is read each time the level is needed, so a changed setting applies at once unless the session has its own level.

The orchestrator may raise the level for one delegation, never lower it: `subagents_verdict` with `gateLevel` above the level in force and a `gateLevelReason`. The verdict is then held to the raised level, so a raise that calls for a reviewer needs one named, and the verdict record keeps the raise as `gateLevelRaise: { from, to, reason }`, its reason redacted and cut like other free text. A reviewer's rules follow the level in force when it starts, so to have a reviewer rerun the Verified by commands below max, the orchestrator says so in its task.

The gate level reads the same everywhere: the editing delegation's line in its Result, `subagents_verdict`, the commit block and turn-end notice, a reviewer's rules and the orchestrator protocol.

### Reviewers

Where the gate level calls for one (see Gate level above), an editing delegation needs an independent reviewer before its verdict. At medium that is an elevated or critical delegation, and one without a tier. Where the orchestrator's own spot check is enough, a reviewer is allowed too.

A reviewer is a `subagents` item whose `review` is the delegation id and whose `task` says what to check:

```json
{ "items": [{ "review": "<delegation id>", "task": "Check that the new validation rule covers empty input" }] }
```

The reviewed delegation must be a finished editing delegation of this orchestrator session; otherwise the item fails without starting a worker and names why (unknown, did not edit, still running, a worker's own worker, another session's). `review` excludes `fork` and `resume`, and a worker's own `subagents` call cannot start a reviewer. An `agent` gives the reviewer its instructions and tools, but its `model` and `thinking` are ignored: the reviewer is always routed.

The reviewer is routed through the auto model with two routing constraints (see How routing decides below): a minimum tier, the delegation's tier or elevated for one without a tier, and an excluded rung, the rung the delegation ran on. The tier and rung come from the delegation's latest decision, fork or agent-model record; for a routed decision, the tier it routed at and the rung it ran on, which is the session model in shadow mode and on refusal. For a delegation without such a record, the rung is the one the worker board saw serve it; with neither, the item fails, since the reviewer could not be kept off that rung. In shadow mode and with routing off, the reviewer runs on the session model even when that is the implementer's rung. It still has a fresh context; its saved outcome and the verdict it backs mark it as a *same-rung review*, which the routing report counts apart (see Verdicts above). In live mode, if routing refuses and the session-model fallback would be the excluded rung, the review fails instead:

```text
no other rung is left: this worker would fall back to the orchestrator session model anthropic/claude-sonnet-4-5:high, which its routing constraints exclude
```

Switching the session model or making another rung available lets a live review run.

The reviewer's system prompt carries the reporting rules, then review rules: check the change itself against the delegation's task, read the changed files and the diff, rerun nothing from its Verified by section unless the task says to (at the max gate level instead: rerun every command there and say what each gave, naming one that would edit under Could not check), change nothing, and answer accept or request changes with the reasons, first in its Confirmed section. Editing calls are denied with a reason; reading, searching, building and testing remain allowed. This applies to a resumed reviewer and a worker it starts too. After them it gets the reviewed delegation: its tier, its saved session file, its task and any later instruction (a resume task or a steering message), its Result, cut at 50 KB like a tool result, and the files its `edit` and `write` calls named. These come from the delegation's saved worker session, or the worker board's copy of its messages when the session was not saved; a fork's copy of the orchestrator's branch is left out. Changes made through `bash`, `ctx_execute` or a worker it started are not listed, and the reviewer is told to check `git status` and `git diff`. An agent definition's instructions follow the review rules.

The reviewer's decision record has `reviewedDelegationId`: the delegation it reviewed. Its saved outcome keeps the same link, so a resumed reviewer keeps its review rules and still counts. A compaction summary of a reviewer is routed without its constraints, like any compaction summary; it only condenses the reviewer's own context.

`subagents_verdict` takes a reviewer whose review completed, of the same delegation, started after that delegation's latest edit. A verdict naming such a reviewer is taken at any tier.

### Retries

After `request_changes`, start a new attempt with the failed delegation's id and your feedback as its `task`:

```json
{ "items": [{ "retry": "<delegation id>", "task": "notes.md:1 needs the heading the task asked for" }] }
```

A retry gets the failed attempt's task and later instructions, a pointer to its saved transcript when available, your feedback and the same agent definition. It is a new delegation with its own Result and verdict. `retry` excludes `agent`, `fork`, `resume` and `review`, and only the orchestrator can start it. An attempt without edits or without a latest `request_changes` verdict cannot be retried.

With live routing, the effort ladder tries the next supported effort on the same model, then a surviving listed rung in the same tier, then higher tiers. Every candidate passes the hard filters. The retry is forced onto the chosen rung; the subagents side writes an effort-ladder record when it starts, linked by `previousDecisionId` to the failed attempt, and the router writes an ordinary decision record naming what ran. In shadow mode the ladder record names the would-be rung, but the retry runs on the session model. With routing off there is no tier map to climb: the retry runs on the session model and its ladder record has step `unplaced` and no rung. A fork, a named-model worker, a refused route or an attempt whose rung is no longer in the tier map is also unplaced: with routing on its retry routes normally, without a forced rung. The `request_changes` reply explains why the ladder could not place it. An unplaced retry still counts as a climb.

One task may climb at most twice, including a retry of a retry or two retries of the same attempt. The third climb is refused, even after another `request_changes` verdict; an exhausted ladder is refused too. The reason tells the orchestrator to take the task back to the user rather than work around the limit.

### Orchestrator protocol

The orchestrator's own session carries the orchestrator protocol as the `orchestrator_protocol` section of its system prompt: delegate exploration and substantial work to workers, keep small known actions (a single lookup, a small edit, a build or test run, a commit), expect no exploratory call to be denied, and hand the rest of the research to a worker once the exploration nudge appears after the configured threshold, which it names, treat a worker's Result as evidence to check before acting on it, judge each editing delegation's Result and record the verdict with `subagents_verdict`, since its git commit and git push wait for every verdict that is needed (see Verdicts above), follow the gate level in force, which it names with what each tier needs and how to raise it for one delegation (see Gate level above), and start a reviewer where the level calls for one and name it in the verdict (see Reviewers above). After `request_changes`, it can retry the delegation with feedback on the effort ladder, at most twice; when refused, it takes the task back to the user (see Retries above). The text lives in `src/subagents/orchestrator-protocol.ts`. The section is added when each user prompt starts its agent loop, so it holds for every turn of that loop and returns after a compaction. There is no per-prompt reminder line. Workers, forked workers and sessions in a pi-subagents child process never get it; a fork's copied conversation holds the orchestrator's section, and pi removes it from the fork's own prompt.

A run that a message starts without a user prompt, such as a background call's completion notice or a worker's question, has the protocol for its first turn only: pi rebuilds the prompt of its later turns without the section, until the next user prompt adds it again.

### Exploration nudge

No exploratory call of the orchestrator's own session is ever denied (ADR 0013). After `orchestrator.subagents.explorationNudge` exploratory calls (default 3) in one user prompt, each further exploratory call still runs, and its result ends with an exploration nudge that counts the calls so far. The 4th call's result ends with:

```text
4 exploratory calls this prompt: consider handing the rest to a worker.
```

- **Exploratory:** `read`, pi's `grep`, `find` and `ls` tools, `web_search`, `fetch_content`, `get_search_content`, `source_check`, the `ctx_*` tools (`ctx_execute`, `ctx_execute_file`, `ctx_search`, `ctx_batch_execute`, `ctx_fetch_and_index`), `mcp` and `mcpScript`, and `bash` searches, listings and reads (`rg`, `grep`, `find`, `ls`, `cat`, `git log`, `git show`, `git diff` and similar). A spot check of a worker's Result counts like any other.
- **Never counted:** `edit`, `write`, the subagents tools (`subagents`, `subagents_status`, `subagents_message`, `subagents_verdict`), an `mcp` install or sign-in (`action` `install`, `auth-start` or `auth-complete`), other tools, and `bash` builds, test runs and version-control actions (`npm test`, `npm run build`, `node --test`, `tsc`, `cargo test`, `git commit`, `git push`, `git add` and similar).
- **Unrecognised `bash` counts.** So does any command that redirects output into a file (`> notes.md`, `| tee log`) or rewrites files (`sed -i`, `eslint --fix`, `npm run format`).

A chained command (`&&`, `||`, `;`) is as strong as its strongest part: anything unrecognised, then a version-control action, then a search, then a build or test run. `cd src && rg foo` is a search, `git add -A && git commit -m x` a version-control action, and `rg foo && npm test` a search. A search that only filters a pipe adds nothing, so `npm test 2>&1 | tail -20` is a test run.

`beans prime`, `beans show` and `beans list` are reads, after `beans`' own `--beans-path` and `--config` options and their values; any other `beans` command is unrecognised. A command run through `rtk` has the kind of the command it runs: its Claude Code hook, which pi-claude-hooks runs as a `tool_call` hook, rewrites the command in place, so `git show` can reach this package as `rtk git show` and `head -5 x` as `rtk read x --max-lines 5`. So `rtk read` is a read like `cat`, and `rtk lint` is `eslint`. `rtk err`, `rtk test`, `rtk summary` and `rtk proxy` are unrecognised, as `sh -c` is: the first three join their arguments and run them through a shell, and `proxy` splits a lone argument with spaces into a command, so `rtk err cat x ';' rm -rf src` removes `src`. rtk's hook never produces them. The commit gate reads `rtk git commit` as a commit, and sees through those four no better than through `sh -c`.

The count starts again at each user prompt: each prompt the user sends, one typed while the orchestrator runs included. A run that a message starts, such as a background call's completion notice or a worker's question, goes on counting the last prompt's calls; so does a user message another extension sends. The threshold is read at the session's start and at each user prompt. A malformed setting keeps the default, and the failure is logged once to stderr.

The nudge binds only the orchestrator's own session. Workers, forked workers and sessions in a pi-subagents child process are never nudged. It comes with the subagents extension, because it sends the orchestrator to the `subagents` tool: switching that extension off drops the nudge too.

### Status and wait

The `subagents_status` tool, `{ "id"?: string, "wait"?: boolean }`, shows the orchestrator its session's running background calls:

- Without `id` it lists them: each call's id and done count, and each worker's delegation id, agent, state and short task.
- With a call id it gives a snapshot of each of the call's items; with a delegation id, a snapshot of that worker alone. A snapshot holds the worker's state, its current tool, the turns it has started, its elapsed time, the last 5 lines of its latest text and its session file.
- With a call id and `"wait": true` it blocks until the call has finished and returns its results, the same text and details as its completion notice. That notice is then not delivered: a result goes once, to a pending wait, otherwise as the notice. `wait` needs a call id; a delegation id or no id is refused.
- Ctrl+C during a wait stops only the wait. The workers run on, and the call's completion notice follows.
- A worker's `report` question ends a pending wait on its call, and a wait on a call with an unanswered question is refused (see Reports above).

A call that has finished is no longer listed; its results are in its completion notice. Workers do not get `subagents_status`, even when their agent definition's `tools:` list names it.

### Resume

A `resume` item uses a finished worker's delegation id and a new task instead of `agent` or `fork`. It continues that worker's saved session and original pin without a new routing decision. Unknown, running and not-started workers cannot be resumed, nor can workers from another orchestrator session or those without a recoverable pin. The original pin must still pass the hard filters; otherwise the item fails without re-routing. A preserved agent model's ban-list exception is rechecked against current settings. Later verdicts for the same delegation replace earlier ones in the routing report; the record retains all verdicts. A resume that edits asks for a verdict again (see Verdicts above). A resume item may be background: its delegation id stays the one it resumes.

Each item's result has a status:

| Status | Meaning |
|--------|---------|
| `completed` | The worker finished and returned its final text |
| `failed` | The worker's model call or setup failed, or the item names an unknown agent or a delegation it cannot review and no worker started; the result names why |
| `aborted` | The item's worker was running when the call was aborted |
| `not-started` | The item was still queued when the call was aborted |

A worker's session is saved under the orchestrator's session folder, and its session id is its delegation id. A fork's saved session starts with a copy of the active branch up to the fork point; a fork record names its model, effort, parent session id and fork point. Verdicts attach to fork records by delegation id. It loads the same installed extensions as the orchestrator, without the `subagents` tool itself unless its agent definition lists it (see Nested delegation below). A worker's final text over 50 KB is cut, with a pointer to its session file, which keeps the whole text.

While a call runs, pi shows one line per worker: its agent name (`worker` without one), `(fork)` for a fork, its short task, and its current tool or state: queued, running, done, error, aborted or not started. A fork or a worker on a preserved model also shows its model, marked `(ban-list exception)` when an exception let it run. Expanding the result shows each worker's final text or error.

### Worker widget

Below the editor, the orchestrator's session lists its active workers: foreground, background and nested, queued ones included. It is drawn as Claude Code's agent list, with `main`, the orchestrator's own agent, first and one row per worker:

```text
  ↑/↓ to select

❯ ● main
  ○ lead                   subagents                                           8m08s · ↓ 133k tokens
  ○ └ tester               Check the tests                                                     8m08s
  ○ worker (fork)          writing…                                                8m08s · ↓ 1 token
  ○ scout                  asking · Scout the config                                           8m08s
  ○ worker                 queued · Fix the typo
```

- The selected row has the `❯` cursor and a filled `●`; every other row is indented with a hollow `○`. `main` is selected while the editor has the keyboard; in the widget the hint adds `Enter to open · Esc to go back`.
- The agent name, `worker` without one, and `(fork)` for a fork, cut with `…` to a name column of 20.
- Its activity: `thinking…`, `writing…`, the name of the tool it runs (no arguments), or for a failed worker why it failed. Before its first activity, its short task. A worker that is not running says its worker state first: queued, asking, completed, failed or aborted. An activity stays at least 1.5 seconds before a newer one replaces it, so a row never changes with each streamed piece of text; a failure shows at once. The transcript view's header shows the same activity.
- Once it has started, against the right edge: its elapsed time and, once its replies used any, their tokens (input, output and cache together).
- A narrow terminal gives the name about a third of the row, and cuts the activity first, then the tokens, then the elapsed time. The model and turns are in the transcript view's header.

A worker started by another worker is indented under it. At most 6 workers are listed; a `+N more` line counts the rest. A finished worker stays about 10 seconds with its end state, then drops out, and the widget disappears when no worker is left. The widget only shows workers; it never steers them. A worker's own session shows no widget.

Down enters the widget when it would do nothing in the editor: the cursor is at the end of the editor's last line, you are not browsing the prompt history, no autocomplete list is open, and at least one worker is shown. On the last line, a first Down moves the cursor to the line's end as usual. Alt+a enters it too. In the widget, ↑ ↓ pick a worker and Enter opens its transcript view; leaving the transcript view comes back to the widget with that worker selected. ↑ on the first row, Esc or Ctrl+C go back to the editor with its text untouched, and any other key goes back to the editor and into it. When the selected worker drops out, the selection moves to the row in its place; when the widget empties, the editor gets the keyboard back. Down and alt+a do nothing when no worker is shown. A worker's own session does not bind either.

### Transcript view

The transcript view shows one worker's transcript in place of the orchestrator's session: any worker of the orchestrator's session, foreground, background or nested, running or finished. Leaving it returns to the orchestrator's session as it was, chat, editor text and worker widget included. How it looks depends on pi's TUI mode (see Regular TUI mode and Fullscreen TUI mode below).

Three ways open it. Alt+a on the worker widget, then Enter on the selected row, opens that worker (see Worker widget above). `/subagents` without arguments opens a picker of every worker of the session, finished ones included: one row per worker as the widget draws it, under a `↑/↓ to select · Enter to open · Esc to cancel` hint, its list number before its name, in board order, nested workers indented under their parent delegation. It has no `main` row, since the orchestrator has no transcript view. Arrow keys and Enter work as in the widget, and Esc or Ctrl+C cancels. Without a UI to pick in, the same command lists every worker as text instead, each with its model, worker state, elapsed time, turns and activity. `/subagents <delegation id>` or `/subagents <list number>` opens that worker directly, skipping the picker; a delegation id or list number that names no worker is refused.

The transcript looks like pi's own chat: the worker's replies with their thinking, its tool calls with their results, and the tool-output expand toggle. Two kinds of message are marked, so they stand out from the task and from ordinary tool calls:

- `◆ Report: progress` and `◆ Report: question` mark the worker's `report` calls, with a question's answer below it.
- `▸ Steer from the orchestrator` and `▸ Follow-up from the orchestrator` mark the messages `subagents_message` sent the worker.

A forked worker's transcript starts with the orchestrator's conversation it was copied from. A tool from another installed extension keeps its own drawing while the worker runs. In a finished worker's transcript, only pi's built-in tools, `subagents` and `report` keep theirs; other tools are drawn plainly.

#### Regular TUI mode

The view replaces pi's whole view, so it scrolls with the terminal's own scrollback, mouse wheel, selection and search. Opening it, leaving it and switching worker reprint the terminal and land at the bottom. While it is open, the orchestrator's output goes to the hidden chat and shows once you leave. The view is printed top to bottom:

```text
tester
anthropic/claude-haiku-4-5:low since 12:00:05 (escalated from mechanical to standard)
delegation 0199f0c2-5e0a-7c1b-9d3e-3f2a9c1e44b0 · parent delegation 0199f0b1-7c2d-7e3f-8a4b-5c6d7e8f9a0b (lead)
Check the tests, then report back which ones fail and why.
────────
…the whole transcript…
────────
running · 1m15s · 2 turns · 12.3k tok · $0.042 · bash · worker 2 of 3
orchestrator idle · 1 worker asking: worker 3 (reviewer)
←→ worker · x stop · ctrl+o tool output · Esc back
```

- The top is printed once and scrolls away: the worker's agent, its model and rung history, its delegation, and its whole task, wrapped without a limit.
- The whole transcript follows, not cut to the screen.
- The live lines come last and update in place: the workers it started, at most 6 as the worker widget draws them under a `↑/↓ to select · Enter to open` hint, the selected one with the cursor; the worker state, elapsed time, turns, tokens, cost, activity and which worker of how many it is; the orchestrator bar; and the key hints.

| Key | Action |
|-----|--------|
| ← → | Show the previous or next worker, in the order they were queued, each nested worker after its parent |
| ↑ ↓, Enter | Select one of the worker's nested workers, and open it |
| x | Stop this worker, after a `Stop this worker? y/n` confirmation. A running worker aborts, a queued one never starts; a nested worker's parent runs on |
| ctrl+o | Expand or collapse tool output |
| Esc, ctrl+c | Go back to the orchestrator's session |

#### Fullscreen TUI mode

The view is a full-screen overlay over the orchestrator's session, with a bar and a header pinned at the top:

```text
orchestrator idle · 1 worker asking: worker 3 (reviewer)
tester · running · 1m15s · 2 turns · 12.3k tok · $0.042 · bash · worker 2 of 3
anthropic/claude-haiku-4-5:low since 12:00:05 (escalated from mechanical to standard)
delegation 0199f0c2-5e0a-7c1b-9d3e-3f2a9c1e44b0 · parent delegation 0199f0b1-7c2d-7e3f-8a4b-5c6d7e8f9a0b (lead)
Check the tests
```

The bar shows whether the orchestrator is running or idle, and which workers are asking it a question, by their place among the workers. It updates live, but it only tells: it never closes the view or takes a key, and the question is answered in the orchestrator's session. Regular TUI mode shows the same bar among its live lines.

The header shows:

- The worker's agent and worker state; once it has started, its elapsed time, turns, tokens (input, output and cache together) and cost; its activity; then which worker of how many it is.
- Its model and effort. A routed worker shows `routing…` before its first request, then its rung history: each rung with the time it started serving, and the escalation that led to it. A forked worker and a worker on its agent definition's model show that fixed model.
- Its delegation id and, for a nested worker, its parent delegation and that worker's agent. A queued foreground worker gets its delegation id when it starts.
- Its task, wrapped to at most 3 lines, ending in `…` when it is longer.

Every line is cut to the terminal's width. On a narrow terminal the rung history drops its oldest rungs first, keeping the rung that serves the latest request, and the delegation ids shrink to their first eight characters. The workers it started are listed below the header. While the worker runs, the view follows the end of its transcript until you scroll.

| Key | Action |
|-----|--------|
| PgUp, PgDn | Scroll a page; paging back down to the end follows it again |
| Home, End | Go to the start; go to the end and follow it again |
| ← → | Show the previous or next worker, in the order they were queued, each nested worker after its parent |
| ↑ ↓, Enter | Select one of the worker's nested workers, and open it |
| x | Stop this worker, after a `Stop this worker? y/n` confirmation. A running worker aborts, a queued one never starts; a nested worker's parent runs on |
| ctrl+o | Expand or collapse tool output |
| Esc, ctrl+c | Go back to the orchestrator's session |

The view is read-only: answering and steering a worker stay with the orchestrator, through `subagents_message`, and x is the only thing it sends a worker. It never closes on its own. A worker that finishes while shown stays open with its end state, and a worker you stop stays open as aborted. A finished worker's transcript is read from its session file, which the view never changes. When the orchestrator's session is not saved, its workers' sessions are not saved either, and a finished worker shows the messages the session kept in memory.

### Agent definitions

An item's `agent` name picks a named, owner-written kind of worker: its instructions and the tools it may use. Agent definitions are markdown files with frontmatter (`name`, `description`, `tools`, `model`, `thinking`) and a body of instructions, read from `~/.pi/agent/agents/` and the project's `.pi/agents/`. A project's definition wins by name. `model` (`provider/model`, optionally with `:effort`) and `thinking` apply only when `agentDefinitionModel.use` is `"preserve"` (see below). A `tools:` list only narrows the orchestrator's tool set for that worker; it cannot add a tool the orchestrator itself does not have. Each definition's name and description are listed in the subagents tool's description at session start. `agent` is optional in a call: without it, a worker gets pi's default tools plus extension tools (except `subagents`) and no agent-specific instructions. Every worker also gets the `report` tool (see Reports above), and every worker except a fork gets the reporting rules before the definition's instructions (see Results above). pi-orchestrator ships no built-in definitions; the owner writes them.

### Nested delegation

A worker may start workers of its own only when its agent definition lists `subagents` in `tools:`. That is one level deep: the workers it starts never get the `subagents` tool, even when their own definition lists it. A worker's call is foreground only; asking for a background call fails the call before any worker starts. Its workers always run on the auto model and are routed, even when `agentDefinitionModel.use` is `"preserve"` and their definition names a model. Each of its calls has its own `maxParallel` limit, read from the same settings. The decision record of a worker started by another worker has `parentDelegationId`: the delegation id of the worker that started it.

### `orchestrator.subagents` settings

```json
{
  "orchestrator": {
    "subagents": {
      "maxParallel": 4,
      "maxBackgroundWorkers": 8,
      "agentDefinitionModel": { "use": "route", "allowBanned": false },
      "explorationNudge": 3,
      "gateLevel": "medium",
      "allowProjectOverrides": false
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `subagents.maxParallel` | At most this many of one call's items run at once; the rest queue. Default 4 |
| `subagents.maxBackgroundWorkers` | At most this many background workers, queued or running, across the session's background calls; a background call that would exceed it is refused. Default 8 |
| `subagents.agentDefinitionModel.use` | `"route"` (the default) ignores an agent definition's `model` and `thinking`, with one warning, and routes the worker as usual. `"preserve"` runs a worker whose definition names a model on that model and thinking, unrouted, and writes an agent-model record (delegation id, agent name, definition file, model, effort). A definition without a model is routed either way |
| `subagents.agentDefinitionModel.allowBanned` | Default `false`. With `"preserve"`, a worker whose agent definition names a model on the subagent ban list runs on it; with `false`, that item fails before a worker starts. For a definition from the project's `.pi/agents/` this also needs `allowProjectOverrides` in personal settings. With that flag on, a project's `agentDefinitionModel` replaces the personal one, `allowBanned` included. When the exception lets a worker run, its agent-model record gets `banListException: true`, its item result gets `banListException: true`, and its line is marked `(ban-list exception)`. The guard and the router extension do not stop such a worker. Under `"route"`, a `true` value has no effect and warns once per session. Every other path still refuses a banned model: the tier map drops its rungs, and the guard refuses a tool call that names it |
| `subagents.explorationNudge` | Exploratory calls the orchestrator's own session makes per user prompt before each further one's result carries the exploration nudge (see Exploration nudge above). A positive integer, default 3. Read at the session's start and at each user prompt. Without it, the old key `subagents.explorationBudget` is read in its place |
| `subagents.gateLevel` | How strictly the quality gate treats each tier: `low`, `medium`, `high` or `max`, default `medium` (see Gate level above). `/pi-orchestrator gate <level>` replaces it for one session. Read each time the gate level is needed; a malformed value keeps the default, and the failure is logged once to stderr |
| `subagents.allowProjectOverrides` | Personal settings only, default `false`. Lets a project's `.pi/settings.json` set every `orchestrator.subagents` key except this one. A project key replaces the personal value whole: a project's `agentDefinitionModel` replaces the personal object, it is not merged into it. Without the flag every project `orchestrator.subagents` key is ignored; with it, a project value for the flag itself is ignored. Each ignored key is logged once to stderr, as `pi-orchestrator subagents: ignored project settings key <key>`, the way the guard logs ignored ban-list keys |

## Settings

pi-orchestrator settings live under the `orchestrator` key in personal settings, `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`. The guard and the router extension read them at session start, so a change to their keys needs a new session. The subagents extension reads `orchestrator.subagents`, the subagent ban list and the agent definitions on every call, `orchestrator.subagents.explorationNudge` at the session's start and at each user prompt, and `orchestrator.subagents.gateLevel` each time the gate level is needed.

```json
{
  "orchestrator": {
    "subagentBanList": ["fable", "astra"],
    "sessionBanList": [],
    "routing": {
      "enabled": true,
      "mode": "shadow",
      "classifier": { "model": "anthropic/claude-haiku-4-5:off", "timeoutMs": 30000, "fallback": [] },
      "tiers": {
        "mechanical": ["anthropic/claude-haiku-4-5:low"],
        "standard": ["anthropic/claude-sonnet-5:medium"],
        "elevated": ["anthropic/claude-opus-5:high"],
        "critical": ["anthropic/claude-opus-5:xhigh"]
      }
    }
  }
}
```

| Key | Meaning |
|-----|---------|
| `subagentBanList` | Case-insensitive substrings of model ids that workers may never use. The guard refuses explicitly named banned models, and the router extension excludes them from the tier map and fallback. Empty when absent |
| `sessionBanList` | The same rule for the orchestrator's session model. While the session runs on a banned model, no turn runs. Empty when absent |
| `routing.enabled` | `true` switches routing on. Absent or `false`: a worker on the auto model runs on the orchestrator's session model without a decision record |
| `routing.mode` | `shadow` (the default) records a shadow decision while the worker runs on the orchestrator's session model. `live` runs the worker on the chosen rung |
| `routing.classifier` | The model that classifies each task, with its timeout and fallbacks. Every rung must name an installed model |
| `routing.tiers` | Four tiers, each a list of `provider/model:effort` rungs tried in order |

A project's `.pi/settings.json` may replace individual tiers under `orchestrator.routing.tiers`, and, when personal settings switch `orchestrator.subagents.allowProjectOverrides` on, `orchestrator.subagents` keys; nothing else. A project cannot change either ban list. The guard logs each ignored key once.

### How routing decides

A worker started on the auto model is identified by its pi session id (its delegation id). The router extension classifies its first request from the task text, agent role and named file paths. The task text is the first user message, the delegated prompt; context that other extensions append to the request is not part of it. Keyword signals (credentials, security, destructive operations) set a minimum tier. The first rung that passes the hard filters (subagent ban list, allowed-model list, installed model, approved recipient, usage limits, context window and task allowance) is chosen. If no rung survives, routing escalates through higher tiers, then refuses.

pi-orchestrator can set routing constraints for one worker, by its session id, before its first request. A reviewer gets a minimum tier and an excluded rung (see Reviewers above):

- A minimum tier raises a lower classified tier to it; escalation goes on from there as usual.
- An excluded rung is removed in every tier, with the reason `excluded rung`, so escalation cannot choose it either. The same model at another effort stays. A worker whose fallback after a live refusal would be the excluded rung fails with the reason, and no decision record is written for it. In shadow mode or with routing off, the reviewer may run on that rung as a same-rung review.
- A forced rung, with the tier it stands for, replaces the tier choice. It is pinned if it passes the hard filters. Otherwise routing refuses with the filter it failed, and the worker runs on the orchestrator's session model like any refused worker.

The classifier still runs, so the decision record keeps the tier and why, and its `constraints` field names the constraint. Constraints never lift a hard filter.

The usage limits come from usage observations, which the router extension reads from `usage-observations.json` in the state folder on every routing, so every session and project sees them. When a worker's rung fails with a limit error, the router extension records an observation for the rung's provider before the worker gets the error:

- A usage-limit error, such as Codex's `You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.` or Anthropic's `You're out of extra usage.`, marks the provider exhausted until the reset the text states, or for 5 hours when it states none: the usage window of the Claude and Codex subscriptions.
- A rate-limit error, such as Anthropic's `429 {"type":"error","error":{"type":"rate_limit_error",...}}`, marks the provider throttled until the time the text states, or for 5 minutes when it states none: long enough to spare the next few delegations, short enough that a per-minute limit doesn't keep the provider out for long.

An exhausted provider's rungs are removed with the reason `provider out of usage`, a throttled provider's with `provider throttled`, and the removal's detail names when the limit lifts. With routing not enabled, or switched off by an error, nothing is recorded.

The worker keeps the chosen rung as its pin across later requests and compaction. In live mode, a resumed worker can restore its pin from the decision record if the rung still passes the hard filters and the record was made under the same routing constraints. The auto model declares the largest context window in the tier map; an overflow on the pinned rung lets pi compact and retry on that rung. A compaction summary has a new session id and is classified separately. The classifier runs in the worker's process through its session model registry, without an extra `pi` process.

In live mode the worker runs on the chosen rung. In shadow mode the router extension records the shadow decision, but the worker runs on the orchestrator's session model. A routing refusal, disabled routing or an internal routing failure also runs the worker on that model. After a live refusal, if that model's provider is exhausted, the worker fails instead, before any request is sent, with a reason naming every limited provider and when its limit lifts; no decision record is written for it. The router extension sets `PI_ORCHESTRATOR_SESSION_MODEL` from the orchestrator's session model, including for a background worker at delegation time. If that variable is missing or names a model on the subagent ban list, the auto model request fails with a reason instead. A worker started on a real model is not routed; the guard still enforces the subagent ban list.

The orchestrator's main thread stays on the model picked in `/model`. Selecting `orchestrator/auto` there restores the previous model and warns; a saved `orchestrator/auto` default is also put back to the previous model. Without a previous model, it only warns, and the saved default stays unchanged. Only workers should run on the auto model.

## State

Runtime state lives in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-orchestrator/`, or in `PI_ORCHESTRATOR_STATE_DIR` when set. Nothing is written inside the package checkout.

| File | Contents | When absent |
|------|----------|-------------|
| `authorized-recipients.json` | Providers you approved as data recipients | No provider is approved, so every route refuses |
| `routing/*.jsonl` | One decision record per classified worker session (delegation id), fork and agent-model records, effort-ladder links for retries, verdicts, and the edit records and gate requirements of editing delegations, one file per day | Created on the first record |
| `model-catalog.json` | Prices, context windows and usage headroom | Built from installed models and a pinned models.dev snapshot |
| `refresh-state.json` | Throttling observations | No throttle |
| `usage-observations.json` | The latest usage observation per provider: state, percentage left and reset time when known, when it was observed, and whether it came from an error or response headers. Shared by all sessions and projects; a write holds `usage-observations.json.lock` for a moment | No limit known |

Decision records keep the first 200 characters of the task text, with credential-shaped text redacted. The redaction is best effort.

## Switching things off

- **Routing only**: set `orchestrator.routing.enabled` to `false` for the session-model fallback without records, or use `mode: "shadow"` to keep shadow decisions while workers run on the session model.
- **One extension**: filter the package in settings, or use `pi config`:

  ```json
  { "packages": [{ "source": "git:github.com/egonm12/pi-orchestrator", "extensions": ["!src/router/extension.ts"] }] }
  ```

  Use `!src/guard/extension.ts` to keep the router and drop the guard, or `!src/subagents/extension.ts` to drop only the built-in `subagents` tool, and with it the orchestrator protocol, the exploration nudge, the gate level and `/pi-orchestrator gate`, `subagents_verdict` and the commit block on unjudged edits, and keep routing for other subagent extensions.
- **Everything, for one run**: `pi --no-extensions`.
- **Uninstall**: `pi remove git:github.com/egonm12/pi-orchestrator`.

## Fail open

An internal routing failure prints one `pi-orchestrator router disabled: <reason>` line and sends auto model requests to the orchestrator's session model. If that model is unknown or on the subagent ban list, the request fails with a reason. The guard prints `pi-orchestrator guard disabled: <reason>` on an internal failure and stays inert. The guard refuses explicitly named banned worker models.

Debug and probe switches:

| Variable | Effect |
|----------|--------|
| `PI_ORCHESTRATOR_ROUTER_PROBE=1` | Print load, routing mode, classifier timings and each request's rung, pin and timing |
| `PI_ORCHESTRATOR_GUARD_PROBE=1` | Print load and the effective ban lists |
| `PI_ORCHESTRATOR_ROUTER_DEBUG=1`, `PI_ORCHESTRATOR_GUARD_DEBUG=1` | Print the stack on a failure |

## What the guard does not do

The guard protects against accidental mistakes, not a determined agent. It refuses banned models in `model` fields (including nested delegations) and nested `pi` runs that disable extensions or switch agent directory. `write`, `edit` and bash can write anywhere, and other extensions' processes are not checked.

## Known limits

- A worker started on a real model is not routed. A workflow's workers are routed only if the subagent extension starts them on `orchestrator/auto`.
- The task allowance is per session ($5 by default), not shared between the orchestrator and background workers.
- The built-in `subagents` tool runs its workers in the orchestrator's own process; it has no chains. Use another subagent extension for those. Its background workers end with the orchestrator's session.

## Development

```sh
npm install
npm test            # offline
npm run typecheck
PI_ORCHESTRATOR_LIVE=1 npm test   # also runs live pi sessions; needs credentials and spends usage
```

Domain vocabulary is in [CONTEXT.md](CONTEXT.md), and design decisions are in [docs/adr/](docs/adr/).
