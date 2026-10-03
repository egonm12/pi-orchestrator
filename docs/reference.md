# pi-orchestrator

A [pi](https://pi.dev) package with three extensions for sessions that delegate work to workers:

- **Subagents**: the built-in `subagents` tool. It starts workers in the orchestrator's own process, on the auto model `orchestrator/auto`, and gives the orchestrator's own session the orchestrator protocol, the exploration nudge, the `subagents_verdict` tool and a reminder in the result of git commit and git push while edits wait for a verdict.
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

1. Asks which models workers may never use: the subagent ban list. It first shows the rule: each entry blocks every model whose id contains it, case-insensitive, so `opus` excludes every Opus model. In the TUI it shows a checkbox list: `[x]` entries are banned, `[ ]` entries are not, ↑↓ moves, Space toggles, Enter saves the list, and Escape stops `init` with the old list in place and nothing written. Select `Type your own…` to add comma-separated entries. In RPC or other modes without custom terminal UI, it falls back to the select loop: pick an installed model family, `Type your own…`, `Remove an entry…` or `Done`; `Done` saves without another confirmation. A family is the model id without its provider, date and version parts: `claude-opus-4-5-20251101` is `claude-opus`, and when only one name part comes before the version the major version stays, so `gpt-5.6-luna` is `gpt-5`. On save it shows, for each entry, the installed models it matches. An entry that matches no installed model is kept, marked `matches no installed model yet`. When personal settings already have a tier map, the preview also names each tier the new list would leave with no rungs, such as `tier elevated would have no models left (all its rungs match opus)`; such a list cannot be saved, so edit the tier map in `~/.pi/agent/settings.json` first or ban less. Running `init` again starts from the ban list in personal settings.
2. Asks for the gate level and the worker limit (see Gate level and Worker limit below). When `init` runs in a project folder, one that holds a `.git` or `.pi` folder and is not your home folder, it first asks once where to write both: `Personal settings (all projects)` or `This project (.pi/settings.json)`. Elsewhere they go to personal settings without asking. The gate level is a select of `off`, `low`, `medium`, `high` and `max`, each with what it means, such as `off: no reviews or verdicts, saves tokens`. The worker limit is a select of 1, 2, 4, 6, 8, 12, 16 and 32, plus `Other…` for a whole number from 1 to 32; anything else asks again. In both selects the target's current value comes first, so Enter keeps it: for a project that is its own value, else your personal one, else the default (`medium`, 4). It is marked `(current)`, except a project's own value while personal `orchestrator.subagents.allowProjectOverrides` is not `true`: that one is marked `(project, ignored until overrides are allowed)`, since the subagents extension uses your personal value or the default instead. Keeping a value the target does not set itself writes nothing, so the target keeps inheriting it. The values are merged into `orchestrator.subagents` of the target file, keeping every other key; `.pi/settings.json` is created when missing. For a project, when personal `orchestrator.subagents.allowProjectOverrides` is not `true` and the project file gets a new value or already sets `gateLevel`, `workerLimit`, `maxParallel` or `maxBackgroundWorkers`, it asks `Allow project settings to override your personal gate level and worker limit?`. Yes sets the flag in personal settings only; no still writes any new project value and says the project's values are ignored until project overrides are allowed.
3. Builds an automatic starter routing map from eligible installed models with a published price: not banned, allowed for the harness, and sorted by output price. Models without a known published price are not used for the automatic starter, but they are still eligible for manual selection when they pass the ban list and allowed-model list. When personal settings already have a tier map, asks `Edit the routing map?` with the message `Yes opens the classifier and tier pickers with your current picks. No keeps the current map.` No, or Escape, keeps the current tier map and classifier. Yes opens the classifier and tier pickers with the current picks preselected instead of the automatic starter. If a current rung names a model that is no longer available or eligible, `init` warns and leaves that rung out of the picker.
4. In the routing picker, asks for one classifier model from all eligible models, with models that lack a known price marked `price unknown`. A fresh setup puts the starter classifier first. On rebuild, the existing classifier is first instead when it is still eligible, so pressing Enter keeps it. It then asks for that classifier's thinking level, showing only levels the model supports. Escape at the classifier keeps the existing classifier on rebuild, or the starter classifier on a fresh setup.
5. For each tier, asks for models from all eligible models in a checkbox list, including models marked `price unknown`. On a fresh setup, the starter picks are already checked. On rebuild, the current tier's configured models are checked instead, with each model's configured thinking level when the model still supports it. A tier missing from the current map falls back to the starter picks. Each row shows its thinking level, such as `[x] anthropic/claude-sonnet-4-5  ‹ medium ›`. ↑↓ moves, Space toggles the row, ←/→ cycles that row through thinking levels the model supports, and Enter confirms only when at least one model is ticked. An empty selection keeps the picker open and shows `Tick at least one model`. Left and right do not check an unchecked row; the changed level is kept if you check it later. The saved rung list follows the option order shown in the picker, not the order you toggled entries. Balanced routing normally chooses by provider usage and uses list order only to break ties; ordered tiers take the first survivor, and retries can climb to later entries. In modes without custom terminal UI, the picker falls back to the select loop and still saves selected models in option order; Done with no models selected shows the same warning and asks again. After confirmation, it asks for a thinking level for each picked model, again showing only supported levels and putting that tier's current or starter effort first. Escape at a tier keeps that tier's current picks on rebuild, or the starter picks on a fresh setup. Escape at a thinking-level select keeps the default effort for that model.
6. Writes the ban list and picked routing map into personal settings. A new tier map starts in **shadow** mode with its classifier. A rebuilt map replaces `orchestrator.routing.tiers` and the classifier you picked, while mode, tier order fields and other routing keys stay. The picked ban list replaces the old one. The ban list, tier map, classifier and approved recipients are always personal, whatever target you chose.
7. Asks you to approve each provider the map would send task text to. Only the providers you say yes to are approved. A declined provider's rungs are skipped.

Escape at the target select skips both the gate level and the worker limit; Escape at the gate level or worker limit select, or at the `Other…` input, skips that value only. A skipped value is not written, and `init` goes on with the next step. Escape at the overrides question counts as no.

Review the written map in `~/.pi/agent/settings.json`, then start a new session. Workers started through the built-in `subagents` tool always run on `orchestrator/auto` already; nothing else needs setting up for them.

`/pi-orchestrator` takes a subcommand as its first word: `init` comes with the router extension, `gate` and `workers` with the subagents extension (see Gate level and Worker limit below). With one of them switched off, its subcommands are gone and the other's stay. Without a subcommand, or with one it does not know, it prints the usage with every subcommand.

## Subagents tool

The `subagents` tool starts workers in the orchestrator's own process, by default on the auto model `orchestrator/auto`. The tool's schema lets a call hold at least one item and at most the worker limit read at session start, or set for the session with `/pi-orchestrator workers` (see Worker limit below). The call itself accepts up to 32 items:

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

A fork uses the session model and thinking level at call time, without routing. Later model changes do not move it, even while it is queued. It can use a banned session model as an exception to the subagent ban list; its fork record marks that exception. An `agent` on a fork supplies instructions and narrowed tools, but its `model` and `thinking` are ignored without a warning. A fork gets no reporting rules (see Results below). Forked workers never receive the `subagents` tool. Forks and ordinary workers may share a call. An item with `review` set to a finished editing delegation's id starts an independent reviewer for it (see Reviewers below). An item with `retry` set to a delegation whose latest verdict is `request_changes` starts a new attempt with `task` as feedback (see Retries below). Each item's worker waits for a slot of the worker limit, so items past it queue. An orchestrator's call runs in the background unless it sets `"background": false` (see Background calls below). A foreground call waits for every item; Ctrl+C aborts its running workers and drops queued ones.

### Background calls

An orchestrator's call without `background`, or with `"background": true` next to `items`, returns at once with its call id and one delegation id per item, in item order. The items run on while the orchestrator does other work, within the session's worker limit. When every item has finished, one completion notice arrives with the same result text as a foreground call, headed by the call id. It is delivered as a follow-up message: it starts a turn when the orchestrator is idle, and otherwise waits for the current turn to end.

With `"background": false` the call runs in the foreground instead: the orchestrator's turn stays in the tool call until every item has finished, and a message the user sends meanwhile waits until then, since pi delivers steering after the current turn's tool calls. Use it only for a short, bounded task whose result the orchestrator's next step needs. Leaving the option out used to mean a foreground call; a caller that relied on that must now set `false`. The default is the orchestrator's alone: in a session in a pi-subagents child process, a call without the option stays in the foreground, and `"background": true` still makes it a background call.

A background call is never refused for its number of workers: those past the worker limit queue. Ctrl+C leaves background workers running. `/subagents stop <id>` stops one: a call id stops the whole call (running workers abort, queued ones are not started), a delegation id stops that worker alone, and `all` stops every call. A stopped call still sends its notice. When the orchestrator's session ends, its background workers are aborted, and each call's notice, with status `aborted`, is recorded in the session without starting a turn. A worker's own `subagents` call cannot be background.

### Worker limit

`orchestrator.subagents.workerLimit` (default 4, at most 32) is how many workers run at the same time across the orchestrator's session, foreground and background calls together. Every worker takes a slot as it starts and gives it back when it ends. A worker without a free slot is queued, its worker state `queued` in `subagents_status`, the worker widget and the call's progress, until one frees: slots go first come first served, in item order within a call. No call is refused for its number of workers. A foreground call whose items wait behind background workers goes on as those finish; Ctrl+C drops its queued items. The limit is read on every call, so a changed setting holds from the next call: a higher one starts queued workers, a lower one lets running workers finish. A worker's own calls have slots of their own (see Nested delegation below).

`/pi-orchestrator workers <n>` sets the worker limit for the current session, over the settings, until the next session start: a new session, a resumed one or a reload starts from the settings again. `n` is a whole number from 1 to 32; a higher one is cut to 32 with a notice, as in settings. Anything else prints `usage: /pi-orchestrator workers [1-32]` and changes nothing. The limit holds from the next `subagents` call, and the tool is registered again with it, so its `maxItems` and description follow it. A worker's own calls keep the limit from settings. `/pi-orchestrator workers` without a number shows the limit in force and where it comes from: set for this session, project settings, personal settings or the default.

A background worker that asks a `report` question gives up its slot while it waits for the answer, since the answer only comes after the orchestrator's turn, which a foreground call waiting for a slot holds. A queued worker can take the freed slot. Once answered, the worker queues for a slot again and goes on when it gets one; its worker state stays `running` meanwhile, its `report` call still open. A worker stopped while it queues again, by `/subagents stop`, stopping its call or ending the session, ends without a slot. So the limit counts the workers actually running, and a foreground call never waits on a worker that waits for the orchestrator.

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

A delegation that edited needs the orchestrator's verdict, unless the gate level leaves it ungated (see Gate level below). When the worker's working directory is in a git repository, it edited when the working tree changed while its worker ran, or when the worker, or a worker it started (see Nested delegation below), ran `edit` or `write`, wherever they wrote. The tree is compared by a snapshot as the worker starts and one as it ends: `git status` with every untracked file, a fingerprint of each named file's content, and HEAD. A path whose content changed, appeared or went away differs, and so does every path a moved HEAD changed; a moved HEAD alone, as an empty commit, counts too. Staging alone, and ignored files, do not. Commands alone do not count there: `bash` or `ctx_execute` that changed nothing is research and asks for no verdict. Each worker takes its own snapshots, so a change made while several workers ran counts for each of them, whichever made it. A reviewer, and a worker it started, takes none. `git status` runs with `--no-optional-locks`, so a snapshot takes no `index.lock` while another worker adds or commits. When either snapshot cannot be taken, as when `git status` fails, the worker still runs and the command rule below decides for that run.

Without a git repository, the command rule decides: it edited when its worker, or a worker it started, ran one of these calls:

- `edit` or `write`;
- `bash` that is neither a read-only search nor a build or test run, as the exploration nudge classifies it (see Exploration nudge below): unrecognised commands, redirects into a file, and version-control actions such as `git commit` or `git checkout` all count; so does `powershell`;
- `ctx_execute` or `ctx_execute_file`, which run whatever code they are given, although the exploration nudge counts them as exploratory.

Only a call that ran counts: one a `tool_call` hook blocked, or one for a tool the worker does not have, edited nothing. Other tools, `mcp` and `ctx_batch_execute` included, do not count.

The first counted call in a worker's run writes an edit record into the routing record folder (see State below): the delegation id, the orchestrator session and the tool, with `nestedDelegationId` when a worker's own worker made it. In a git repository a run that ends with a changed working tree writes one more, with tool `working-tree` and `paths`, the changed paths relative to the worker's working directory (at most 100, with `omittedPaths` counting the rest). The fact outlives the worker, a pi reload and a resume of the orchestrator's session. A resumed delegation keeps its delegation id, and a resume that edits writes another edit record for it. The editing delegation's part of the tool result, and of a background call's completion notice, carries one line after the session file:

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

The gate reminds, it never blocks (ADR 0013). The orchestrator's `bash` calls that run `git commit` or `git push` always run, a push the owner asked for included. While any editing delegation of the orchestrator's session waits for a verdict, the result of such a call ends with a reminder, so the orchestrator records the verdicts or tells the user which are missing; a verdict never recorded stays counted as missing in the routing report (see below). A delegation waits from its latest edit record until a verdict of either kind, `accept` or `request_changes`, is recorded after it, so a resume that edits again waits again. An ungated delegation, one whose gate action is none at the gate level in force, never waits: neither the reminder nor the turn-end notice names it. The reminder names each waiting delegation, with its agent and whether it still runs when the orchestrator's process knows them:

```text
pi-orchestrator: git commit ran while 2 editing delegations wait for your verdict: delegation <id>, delegation <id> (agent scribe, still running). Judge each Result and record its verdict with `subagents_verdict`, or tell the user which verdicts are missing.
```

A commit or push is found anywhere in the command: in a chain or a pipe (`npm test && git commit -m x`, `git status; git push`), after git's own options (`git -C <dir> commit`, `git -c k=v push`), through `env` or `xargs`. A command the bash reader cannot follow, such as `git commit -m "$(cat <<'EOF' ...)"`, is matched by its text: `git`, git's options, then `commit` or `push`. Other `bash`, `git add` included, gets no reminder. When the record folder cannot be read, a commit or push still runs, and its result says the gate cannot tell whether a delegation waits, with the reason.

At the end of each orchestrator turn with delegations waiting, a notice names them the same way, and asks for each verdict. It is sent like a worker's progress report: shown at once, read by the model at its next request, and never starting a turn, so it follows a final reply without holding it back. It repeats only when the waiting delegations change, and once at the first turn end of each user prompt. Workers, forked workers and sessions in a pi-subagents child process commit and push unhindered.

When a run of an editing delegation ends, the orchestrator's copy of the extension writes its gate requirement into the routing record folder: the delegation id, the gate level in force at that moment and the gate action at it (`none`, `spot-check` or `reviewer`). A resume that edits again writes a fresh one, and the latest counts; a run that did not edit writes none, and a worker's own worker leaves it to the delegation its edits count for. The requirement is written when the worker ends, not at pi's `session_shutdown`, which also fires for a reload, a resume, a new session and a fork.

The routing report, `node src/routing/routing-report.ts <state dir>/routing`, counts per tier and rung, for each delegation once:

- `accept` and `request_changes`: its latest verdict, unless that verdict rests on a same-rung review;
- `same-rung accept` and `same-rung request_changes`: its latest verdict when that verdict rests on a same-rung review (see Reviewers below), counted apart from the others;
- `ungated`: an editing delegation whose latest gate requirement is gate action none, whether or not it got a verdict anyway;
- `missing`: an editing delegation whose latest gate requirement needs a verdict, and that has no verdict recorded after its latest edit record. A verdict recorded later, in a resumed orchestrator session say, takes it out of `missing`.

Ungated delegations and missing verdicts are not verdicts, and neither is a learning observation. The report is where a skipped gate stays visible (ADR 0013). Delegations without a routing decision (forks, agent-model workers and unrouted workers) have no row; they are counted the same way on their own line, `unrouted delegations: ...`. `unclassified decisions: ...` counts the decisions no classifier model could classify. Then each decision gets a `classification` line with its tier, its cause and the model's reason; a record written before ADR 0015 whose keyword floor raised its tier also names the floor. For example:

```text
tier standard, rung anthropic/claude-sonnet-5:medium: decisions 3, accept 1, request_changes 0, same-rung accept 0, same-rung request_changes 1, ungated 1, missing 0, shadow agreement 1 of 2 (50%)
unclassified decisions: 1
unrouted delegations: accept 1, request_changes 0, same-rung accept 1, same-rung request_changes 0, ungated 1, missing 1
classification 01a0f3c2-...: standard, model:anthropic/claude-haiku-4-5:off: a read-only investigation of one queue; it changes nothing
```

A verdict is only ever `accept` or `request_changes`, recorded by the orchestrator with `subagents_verdict`. Verdicts are never read from a reviewer's structured output, and the pi-subagents `verdict-reviewer` agent is no longer shipped.

### Gate level

The gate level sets, per tier, what an editing delegation needs before it is judged: its gate action. *None* needs no verdict (the delegation is ungated), a *spot check* is the orchestrator's own verdict, and a *reviewer* is an independent reviewer worker (see Reviewers below).

| Tier | off | low | medium | high | max |
|---|---|---|---|---|---|
| mechanical | none | none | spot check | spot check | reviewer |
| standard | none | none | spot check | reviewer | reviewer |
| elevated | none | spot check | reviewer | reviewer | reviewer |
| critical | none | reviewer | reviewer | reviewer | reviewer |

At `off` there is no quality gate in the orchestrator's session. `subagents_verdict` leaves its active tools and refuses a call that reaches it anyway, the orchestrator protocol says nothing of verdicts, the gate level, reviewers or retries, an editing delegation's Result gets no gate line, and a `git commit` or `git push` result and a turn end say nothing of verdicts, even when the record folder cannot be read. An editing delegation's gate requirement is still written, at `off` with action `none`, so the routing report counts it as ungated. A `review` item still starts a reviewer when asked for one.

A delegation without a tier (a fork, a worker on an agent definition's named model, or a worker the router did not route) counts as elevated. The tier is the one its latest decision, fork or agent-model record names (see Reviewers below). At max, every reviewer is told to rerun the Result's Verified by commands.

The level is `orchestrator.subagents.gateLevel` in personal settings, default `medium`; a project may override it, higher or lower, `off` included, when personal settings allow project overrides (see `orchestrator.subagents` settings below). `/pi-orchestrator gate <level>` sets it for the current orchestrator session, higher or lower, until the next session start (a new or resumed session, or a reload); `/pi-orchestrator gate` shows the level in force and whether it comes from settings or the session. Any other argument prints `usage: /pi-orchestrator gate [off|low|medium|high|max]` and changes nothing. The setting is read each time the level is needed, so a changed setting applies at once unless the session has its own level. Whether `subagents_verdict` is active follows the level as each prompt starts its run and each time `/pi-orchestrator gate <level>` sets it; the protocol text follows it on every request.

The orchestrator may raise the level for one delegation, never lower it: `subagents_verdict` with `gateLevel` above the level in force and a `gateLevelReason`. `off` is never a raise target. The verdict is then held to the raised level, so a raise that calls for a reviewer needs one named, and the verdict record keeps the raise as `gateLevelRaise: { from, to, reason }`, its reason redacted and cut like other free text. A reviewer's rules follow the level in force when it starts, so to have a reviewer rerun the Verified by commands below max, the orchestrator says so in its task.

The gate level reads the same everywhere: the editing delegation's line in its Result, `subagents_verdict`, the commit reminder and turn-end notice, a reviewer's rules and the orchestrator protocol.

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

The reviewer's system prompt carries the reporting rules, then review rules: check the change itself against the delegation's task, read the changed files and the diff, rerun nothing from its Verified by section unless the task says to (at the max gate level instead: rerun every command there and say what each gave, naming one that would edit under Could not check), change nothing, and answer accept or request changes with the reasons, first in its Confirmed section. Editing calls are denied with a reason; reading, searching, building and testing remain allowed. A call a `codemode` script makes runs through the same check, so a script's `edit`, `write` or editing `bash` is denied as well. A reviewer may call an MCP tool only when its server marks it read-only (`readOnlyHint`); any other MCP tool may change files or other systems and is denied with a reason. This applies to a resumed reviewer and a worker it starts too. After them it gets the reviewed delegation: its tier, its saved session file, its task and any later instruction (a resume task or a steering message), its Result, cut at 50 KB like a tool result, and the files it changed. These come from the delegation's saved worker session, or the worker board's copy of its messages when the session was not saved; a fork's copy of the orchestrator's branch is left out. In a git repository the list holds the paths its `edit` and `write` calls named and then the paths of its `working-tree` edit records, and the reviewer is told these can hold changes of workers that ran at the same time. Without one it holds only the `edit` and `write` paths, and the reviewer is told that changes made through `bash`, `ctx_execute` or a worker it started are not listed. Either way it is told to check `git status` and `git diff`. An agent definition's instructions follow the review rules.

The reviewer's decision record has `reviewedDelegationId`: the delegation it reviewed. Its saved outcome keeps the same link, so a resumed reviewer keeps its review rules and still counts. A compaction summary of a reviewer is routed without its constraints, like any compaction summary; it only condenses the reviewer's own context.

`subagents_verdict` takes a reviewer whose review completed, of the same delegation, started after that delegation's latest edit. A verdict naming such a reviewer is taken at any tier.

### Retries

After `request_changes`, start a new attempt with the failed delegation's id and your feedback as its `task`:

```json
{ "items": [{ "retry": "<delegation id>", "task": "notes.md:1 needs the heading the task asked for" }] }
```

A retry gets the failed attempt's task and later instructions, a pointer to its saved transcript when available, your feedback and the same agent definition. It is a new delegation with its own Result and verdict. `retry` excludes `agent`, `fork`, `resume` and `review`, and only the orchestrator can start it. An attempt without edits or without a latest `request_changes` verdict cannot be retried.

A retry keeps the tier of the delegation it retries: the router routes it on that delegation's recorded classification and does not call the classifier, so the words of your feedback cannot raise its tier. Its decision record's cause is `retry:<delegation id>`, and a retry of a retry keeps the same tier. An attempt without a decision record (a fork, a named-model worker, one that ran with routing off) has no tier to keep, so with routing on its retry is classified as usual.

With live routing, the effort ladder tries the next supported effort on the same model, then a surviving listed rung in the same tier, then higher tiers. Every candidate passes the hard filters. The retry is forced onto the chosen rung; the subagents side writes an effort-ladder record when it starts, linked by `previousDecisionId` to the failed attempt, and the router writes an ordinary decision record naming what ran. In shadow mode the ladder record names the would-be rung, but the retry runs on the session model. With routing off there is no tier map to climb: the retry runs on the session model and its ladder record has step `unplaced` and no rung. A fork, a named-model worker, a refused route or an attempt whose rung is no longer in the tier map is also unplaced: with routing on its retry routes normally, without a forced rung. The `request_changes` reply explains why the ladder could not place it. An unplaced retry still counts as a climb.

One task may climb at most twice, including a retry of a retry or two retries of the same attempt. The third climb is refused, even after another `request_changes` verdict; an exhausted ladder is refused too. The reason tells the orchestrator to take the task back to the user rather than work around the limit.

### Orchestrator protocol

The orchestrator's own session carries the orchestrator protocol as the `orchestrator_protocol` section of its system prompt: delegate exploration and substantial work to workers, keep the background default for work of uncertain length and set `background: false` only for a short, bounded task whose result its next step needs, wait on a background call only when it cannot go on without the results, keep small known actions (a single lookup, a small edit, a build or test run, a commit), expect no exploratory call to be denied, and hand the rest of the research to a worker once the exploration nudge appears after the configured threshold, which it names, treat a worker's Result as evidence to check before acting on it, judge each editing delegation's Result and record the verdict with `subagents_verdict`, know that its git commit and git push always go through and that their result names each editing delegation still waiting for a verdict, so it records those or tells the user which are missing (see Verdicts above), follow the gate level in force, which it names with what each tier needs and how to raise it for one delegation (see Gate level above), and start a reviewer where the level calls for one and name it in the verdict (see Reviewers above). After `request_changes`, it can retry the delegation with feedback on the effort ladder, at most twice; when refused, it takes the task back to the user (see Retries above). At gate level `off` the protocol keeps only the delegation rules, the exploration nudge and the check of a worker's Result: the entries on verdicts, the gate level, reviewers and retries are left out. The text lives in `src/subagents/orchestrator-protocol.ts`. The section is added when each user prompt starts its agent loop, so it holds for every turn of that loop and returns after a compaction. There is no per-prompt reminder line. Workers, forked workers and sessions in a pi-subagents child process never get it; a fork's copied conversation holds the orchestrator's section, and pi removes it from the fork's own prompt.

A run that a message starts without a user prompt, such as a background call's completion notice, a worker's report or question, or a gate reminder, has the protocol on every request too: before each request of the orchestrator's session, a request whose prompt lacks the current section gets it back after its last system message. Only that request changes, not the transcript. When an extension loaded earlier forces the whole system prompt (it returns `systemPrompt` from `before_agent_start`), the protocol is appended to that forced text.

When the usage store holds observations (see How routing decides below), the protocol ends with one usage line, read from `usage-observations.json` for each request, such as `usage: anthropic exhausted until 14:00 · openai-codex 62% left`. Per provider, in name order, it shows an exhausted or throttled limit with the local time it lifts (`until about 16:30` when the error stated no reset, so the time is the 5-hour or 5-minute estimate), and otherwise the percentage left when known, or `low` or `available`. A provider whose limit has lifted is left out, and with nothing left to show, or an empty store, there is no line. The line changes within a run as the store changes, and never appears twice. Under a forced prompt it keeps the value the run started with, because pi sends the forced text unchanged for the whole run. Workers never get it, since they never get the protocol.

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
- A wait holds the orchestrator's turn as a foreground call does. The protocol and the tool's description tell the orchestrator to wait only when it cannot go on without the results, and otherwise to let the completion notice bring them.
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

### MCP, codemode and tool_search in workers

pi's CLI loads three built-in extensions besides the installed ones: codemode, tool_search and MCP. An SDK session gets them only when they are passed to it, so the subagents tool passes them to every worker, as the CLI does: as `builtin:codemode`, `builtin:tool-search` and `builtin:mcp`, which give way to an installed extension that registers the same tool or command and which `-builtin:<name>` in the `extensions` setting turns off. A worker reads `mcp.json` from the agent dir and, when the orchestrator trusts the project, the project's `.pi/mcp.json`; it reads the project's settings and extensions only then too. It starts its own connections to the servers, and closes them when it ends. Its tools follow the same settings as the orchestrator's: `defaultTools`, `codemode.mode`, and each server's `exposure`, so a server with `direct` exposure declares its tools, and the MCP extension activates codemode for `codemode` and `codemode-deferred` servers and tool_search for `deferred` ones. pi's llama.cpp built-in is not exported to extensions, so workers go without it.

A `tools:` list also narrows these. A worker with one registers only the tools it names, so an MCP tool, `codemode` or `tool_search` reaches it only when the list names it and the orchestrator has it. An MCP tool the orchestrator reaches only through codemode or tool_search, one with `codemode` or `deferred` exposure, is kept while the orchestrator has codemode or tool_search active, even though it is not active itself. When the list names such a tool but neither discovery tool, the worker gets the orchestrator's active discovery tools added: a `codemode` tool's script, or `tool_search`, can then reach the named tool, and only the named tools. A deferred tool stays undeclared until the worker's `tool_search` loads it. The subagents tools stay hidden unless the list names `subagents` (see Nested delegation below).

### Nested delegation

A worker may start workers of its own only when its agent definition lists `subagents` in `tools:`. That is one level deep: the workers it starts never get the `subagents` tool, even when their own definition lists it. A worker's call is foreground only: leaving `background` out keeps it in the foreground, and asking for a background call fails the call before any worker starts. Its workers always run on the auto model and are routed, even when `agentDefinitionModel.use` is `"preserve"` and their definition names a model. Each of its calls has worker slots of its own, as many as the worker limit read from the same settings. They do not count against the orchestrator's slots: the calling worker holds one of those while it waits for its own workers, so sharing them could leave it waiting on itself. A worker that delegates can therefore have up to the worker limit's workers of its own running besides the orchestrator's. The decision record of a worker started by another worker has `parentDelegationId`: the delegation id of the worker that started it.

### `orchestrator.subagents` settings

```json
{
  "orchestrator": {
    "subagents": {
      "workerLimit": 4,
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
| `subagents.workerLimit` | The worker limit: at most this many workers run at once across the orchestrator's session, foreground and background calls together (see Worker limit above). A positive integer, default 4, at most 32: a higher value is cut to 32, and a warning is logged once to stderr. A project's value, under `allowProjectOverrides`, may be higher or lower than the personal one. Read on every call; the tool's `maxItems` and description take the value at session start. `/pi-orchestrator workers <n>` overrides it for the session |
| `subagents.maxParallel`, `subagents.maxBackgroundWorkers` | Deprecated aliases of `workerLimit`, still accepted without a warning. Without `workerLimit`, `maxParallel` is read, then `maxBackgroundWorkers`. Under `allowProjectOverrides`, a project that sets any of the three keys sets the limit by the same order, over every personal one. Each is checked under its own name: a value that is not a positive integer fails the call, as one of `workerLimit` does |
| `subagents.agentDefinitionModel.use` | `"route"` (the default) ignores an agent definition's `model` and `thinking`, with one warning, and routes the worker as usual. `"preserve"` runs a worker whose definition names a model on that model and thinking, unrouted, and writes an agent-model record (delegation id, agent name, definition file, model, effort). A definition without a model is routed either way |
| `subagents.agentDefinitionModel.allowBanned` | Default `false`. With `"preserve"`, a worker whose agent definition names a model on the subagent ban list runs on it; with `false`, that item fails before a worker starts. For a definition from the project's `.pi/agents/` this also needs `allowProjectOverrides` in personal settings. With that flag on, a project's `agentDefinitionModel` replaces the personal one, `allowBanned` included. When the exception lets a worker run, its agent-model record gets `banListException: true`, its item result gets `banListException: true`, and its line is marked `(ban-list exception)`. The guard and the router extension do not stop such a worker. Under `"route"`, a `true` value has no effect and warns once per session. Every other path still refuses a banned model: the tier map drops its rungs, and the guard refuses a tool call that names it |
| `subagents.explorationNudge` | Exploratory calls the orchestrator's own session makes per user prompt before each further one's result carries the exploration nudge (see Exploration nudge above). A positive integer, default 3. Read at the session's start and at each user prompt. Without it, the old key `subagents.explorationBudget` is read in its place |
| `subagents.gateLevel` | How strictly the quality gate treats each tier: `off`, `low`, `medium`, `high` or `max`, default `medium` (see Gate level above). `off` removes the quality gate. A project's value, under `allowProjectOverrides`, may be higher or lower than the personal one. `/pi-orchestrator gate <level>` replaces it for one session. Read each time the gate level is needed; a malformed value keeps the default, and the failure is logged once to stderr |
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
        "standard": { "order": "ordered", "rungs": ["anthropic/claude-sonnet-5:medium"] },
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
| `routing.classifier` | The model that classifies each task, with its timeout and fallbacks. Every rung must name an installed model. When none of them answers, the task is unclassified and runs as elevated |
| `routing.tiers` | Four tiers, each a list of `provider/model:effort` rungs, or an object with `rungs` and optional `order`: `balanced` (default) or `ordered`. A project tier replaces the personal tier, including its order |

A project's `.pi/settings.json` may replace individual tiers under `orchestrator.routing.tiers`, and, when personal settings switch `orchestrator.subagents.allowProjectOverrides` on, `orchestrator.subagents` keys; nothing else. A project cannot change either ban list. The guard logs each ignored key once.

### How routing decides

A worker started on the auto model is identified by its pi session id (its delegation id). The router extension classifies its first request from the task text, agent role and named file paths. The task text is the first user message, the delegated prompt; context that other extensions append to the request is not part of it. Only the classifier model chooses the tier (ADR 0015): its rubric judges the action the task asks for, not the subject it touches, so a review, audit or investigation that changes nothing is never critical, and a prohibition such as "do not delete anything" is a constraint, not a risk. No keyword list raises or replaces its answer. The decision record keeps the model's reason (`why`) and risk reasons. When no classifier rung answers (timeout, invalid answer, out of usage or no allowance left), the task is unclassified: it runs as elevated, and its decision record's cause is `unclassified`. A retry is not classified: it keeps the tier of the delegation it retries (see Retries). The hard filters (subagent ban list, allowed-model list, installed model, approved recipient, usage limits, context window and task allowance) remove ineligible rungs. Among the survivors of one tier, `balanced` chooses the provider with the fewest pinned delegations in the previous 5 hours, across the owner's sessions, projects and tiers. Only live pinned rungs count, including earlier workers in a parallel fan-out; shadow recommendations do not. A provider the usage store holds under 10% left for counts 5 extra delegations, so the other provider takes the next few delegations; it is never removed. It is still chosen when it is the only survivor or the other provider has more than 5 delegations more; at exactly 5 more the scores tie and list order decides. The decision record keeps the pinned counts in `providerCounts` and names such a provider in `lowUsageProviders`. List order breaks ties. `ordered` keeps first-survivor preference. If no rung survives, routing escalates through higher tiers, then refuses. The effort ladder still tries a higher effort on the same model before the next listed rungs and higher tiers.

pi-orchestrator can set routing constraints for one worker, by its session id, before its first request. A reviewer gets a minimum tier and an excluded rung (see Reviewers above):

- A minimum tier raises a lower classified tier to it; escalation goes on from there as usual.
- An excluded rung is removed in every tier, with the reason `excluded rung`, so escalation cannot choose it either. The same model at another effort stays. A worker whose fallback after a live refusal would be the excluded rung fails with the reason, and no decision record is written for it. In shadow mode or with routing off, the reviewer may run on that rung as a same-rung review.
- A forced rung, with the tier it stands for, replaces the tier choice. It is pinned if it passes the hard filters. Otherwise routing refuses with the filter it failed, and the worker runs on the orchestrator's session model like any refused worker.

The classifier still runs, so the decision record keeps the tier and why, and its `constraints` field names the constraint. A retry is the exception: it keeps the classification of the delegation it retries. Constraints never lift a hard filter.

The usage limits come from usage observations, which the router extension reads from `usage-observations.json` in the state folder on every routing, so every session and project sees them. When a worker's rung fails with a limit error, the router extension records an observation for the rung's provider before the worker gets the error:

- A usage-limit error, such as Codex's `You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min.` or Anthropic's `You're out of extra usage.`, marks the provider exhausted until the reset the text states, or for 5 hours when it states none: the usage window of the Claude and Codex subscriptions.
- A rate-limit error, such as Anthropic's `429 {"type":"error","error":{"type":"rate_limit_error",...}}`, marks the provider throttled until the time the text states, or for 5 minutes when it states none: long enough to spare the next few delegations, short enough that a per-minute limit doesn't keep the provider out for long.

An exhausted provider's rungs are removed with the reason `provider out of usage`, a throttled provider's with `provider throttled`, and the removal's detail names when the limit lifts. With routing not enabled, or switched off by an error, nothing is recorded. If `usage-observations.json` can't be written, routing stays on: the router extension prints one `pi-orchestrator router warning: could not save the usage observation for <provider> ...` line per provider, and the process that saw the limit error keeps the observation, still avoids the provider and saves the observation with its next write that succeeds. Until then other sessions don't see it. A failed write never lets that process route a worker to a provider it saw limited.

Quota headers add a percentage left. pi hands each provider response's status and headers to `after_provider_response`, which names no provider, so the router extension attributes them to the request in flight in the same session: a worker's rung on the auto model, or the model the session's own request was sent with. Only the headers the live check captured are read (`src/fixtures/usage/README.md`):

- Anthropic, on the installed packages' path: `anthropic-ratelimit-unified-5h-utilization` and `-7d-utilization`, a fraction used, with their `-reset` times.
- OpenAI Codex over SSE: `x-codex-primary-used-percent` and `x-codex-secondary-used-percent`, a whole percentage used, with their `-reset-at` times. Codex over WebSocket, pi's default transport, fires no `after_provider_response`, so it gives no headers; only its limit errors count.

The provider's percentage left is its tightest window's, with that window's reset, recorded as a `header` observation: `low` under 10% left, else `available`. It holds for at most five hours after observation, or until that window's reset when sooner, so a cached percentage cannot survive an early reset the extension did not observe. Only a 2xx response is read, and headers never make a provider exhausted or throttled: no limit response has been captured yet, so limits still come from limit errors only. A value outside the captured shape is skipped. A header never replaces an exhausted or throttled observation that still holds, even one stamped earlier that another session commits after it: while the limit holds it wins over any header observed before it lifts, whichever write lands first, and once it lifts a newer header replaces it. A reading past its window reset or more than five hours old is left out of the usage line. A reading the store already holds is not written again while it remains fresh, so a worker's every response does not write the shared file.

When the limit error answers a worker's first request in live mode, before the rung has produced anything, the worker fails over: the router extension records the observation, routes the task again with the same classification and constraints, and pins the worker to the rung that survives. That rung is always on another provider, because the new observation removes the refused one. The worker sees only the new rung's answer, never the refused rung's error or a second start. Several failovers in a row are possible, and each refused provider stays out. A limit error after the rung's first output, on a later request, on a resumed pin, in shadow mode, after a refusal's session-model fallback, or with no other provider's rung left fails the worker with the provider's error. The observation is recorded all the same, so the orchestrator can start a new worker, which routing sends elsewhere.

The worker keeps the chosen rung as its pin across later requests and compaction; a failover on its first request is the one way the pin moves. The pin is the auto model's router state on the worker's session branch, so a resumed worker continues on it; the decision record is the audit trail, not the source of the pin. A worker session saved before the pin was router state cannot be resumed. The auto model declares the largest context window in the tier map; an overflow on the pinned rung lets pi compact and retry on that rung. A compaction summary has a new session id and is classified separately. The classifier runs in the worker's process through its session model registry, without an extra `pi` process.

In live mode the worker runs on the chosen rung. In shadow mode the router extension records the shadow decision, but the worker runs on the orchestrator's session model. A routing refusal, disabled routing or an internal routing failure also runs the worker on that model. After a live refusal, if that model's provider is exhausted, the worker fails instead, before any worker request is sent (the classifier has already run), with a reason naming every limited provider and when its limit lifts; no decision record is written for it. The router extension sets `PI_ORCHESTRATOR_SESSION_MODEL` from the orchestrator's session model, including for a background worker at delegation time. If that variable is missing or names a model on the subagent ban list, the auto model request fails with a reason instead. A worker started on a real model is not routed; the guard still enforces the subagent ban list.

The orchestrator's main thread stays on the model picked in `/model`. Selecting `orchestrator/auto` there restores the previous model and warns; a saved `orchestrator/auto` default is also put back to the previous model. Without a previous model, it only warns, and the saved default stays unchanged. Only workers should run on the auto model.

## State

Runtime state lives in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-orchestrator/`, or in `PI_ORCHESTRATOR_STATE_DIR` when set. Nothing is written inside the package checkout.

| File | Contents | When absent |
|------|----------|-------------|
| `authorized-recipients.json` | Providers you approved as data recipients | No provider is approved, so every route refuses |
| `routing/*.jsonl` | One decision record per classified worker session (delegation id), fork and agent-model records, effort-ladder links for retries, failover records (each linked to the refused attempt's decision by its time and rung, with the limit, the reset when stated and the rung the worker moved to, next to the decision for that rung), verdicts, and the edit records and gate requirements of editing delegations, one file per day | Created on the first record |
| `model-catalog.json` | Prices, context windows and usage headroom | Built from installed models and a pinned models.dev snapshot |
| `refresh-state.json` | Throttling observations | No throttle |
| `usage-observations.json` | The latest usage observation per provider: state, percentage left and reset time when known, when it was observed, and whether it came from an error or response headers. Shared by all sessions and projects; a write holds `usage-observations.json.lock` for a moment. A lock whose writer no longer runs, or older than 10 seconds, is broken, and temporary files that dead or hung writers left are removed on the next write | No limit known |

Decision records keep the first 200 characters of the task text, with credential-shaped text redacted. The redaction is best effort.

## Switching things off

- **Routing only**: set `orchestrator.routing.enabled` to `false` for the session-model fallback without records, or use `mode: "shadow"` to keep shadow decisions while workers run on the session model.
- **One extension**: filter the package in settings, or use `pi config`:

  ```json
  { "packages": [{ "source": "git:github.com/egonm12/pi-orchestrator", "extensions": ["!src/router/extension.ts"] }] }
  ```

  Use `!src/guard/extension.ts` to keep the router and drop the guard, or `!src/subagents/extension.ts` to drop only the built-in `subagents` tool, and with it the orchestrator protocol, the exploration nudge, the gate level and `/pi-orchestrator gate`, the worker limit and `/pi-orchestrator workers`, `subagents_verdict` and the commit reminder on unjudged edits, and keep routing for other subagent extensions.
- **Everything, for one run**: `pi --no-extensions`.
- **Uninstall**: `pi remove git:github.com/egonm12/pi-orchestrator`.

## Fail open

An internal routing failure prints one `pi-orchestrator router disabled: <reason>` line and sends auto model requests to the orchestrator's session model. A usage observation that can't be saved is not such a failure: it prints a `pi-orchestrator router warning:` line and routing goes on (see How routing decides). If that model is unknown or on the subagent ban list, the request fails with a reason. The guard prints `pi-orchestrator guard disabled: <reason>` on an internal failure and stays inert. The guard refuses explicitly named banned worker models.

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
