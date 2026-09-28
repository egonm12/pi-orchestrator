# pi-orchestrator

A [pi](https://pi.dev) package with three extensions for sessions that delegate work to workers:

- **Subagents**: the built-in `subagents` tool. It starts workers in the orchestrator's own process, on the auto model `orchestrator/auto`, and gives the orchestrator's own session the orchestrator protocol and the exploration budget.
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

`/pi-orchestrator` takes a subcommand as its first word: `init` comes with the router extension, `budget` with the subagents extension (see Exploration budget below). With one of them switched off, its subcommand is gone and the other stays. Without a subcommand, or with one it does not know, it prints the usage with every subcommand.

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

A fork uses the session model and thinking level at call time, without routing. Later model changes do not move it, even while it is queued. It can use a banned session model as an exception to the subagent ban list; its fork record marks that exception. An `agent` on a fork supplies instructions and narrowed tools, but its `model` and `thinking` are ignored without a warning. A fork gets no reporting rules (see Results below). Forked workers never receive the `subagents` tool. Forks and ordinary workers may share a call. At most `orchestrator.subagents.maxParallel` items (default 4) run at once, the rest queue. The orchestrator waits for every item; Ctrl+C aborts running workers and drops queued ones.

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

### Orchestrator protocol

The orchestrator's own session carries the orchestrator protocol as the `orchestrator_protocol` section of its system prompt: delegate exploration and substantial work to workers, keep small known actions (a single lookup, a small edit, a build or test run, a commit), stay within the exploration budget, which it names with the configured threshold, and treat a worker's Result as evidence to check before acting on it. The text lives in `src/subagents/orchestrator-protocol.ts`. The section is added when each user prompt starts its agent loop, so it holds for every turn of that loop and returns after a compaction. There is no per-prompt reminder line. Workers, forked workers and sessions in a pi-subagents child process never get it; a fork's copied conversation holds the orchestrator's section, and pi removes it from the fork's own prompt.

A run that a message starts without a user prompt, such as a background call's completion notice or a worker's question, has the protocol for its first turn only: pi rebuilds the prompt of its later turns without the section, until the next user prompt adds it again.

### Exploration budget

The orchestrator's own session may make `orchestrator.subagents.explorationBudget` exploratory calls (default 3) per user prompt. The next one is denied, and the model gets the reason as the call's result:

```text
pi-orchestrator: 3 exploratory calls this prompt. Hand the rest of the research to a worker with `subagents`.
```

- **Exploratory:** `read`, pi's `grep`, `find` and `ls` tools, `web_search`, `fetch_content`, `get_search_content`, `source_check`, the `ctx_*` tools (`ctx_execute`, `ctx_execute_file`, `ctx_search`, `ctx_batch_execute`, `ctx_fetch_and_index`), `mcp` and `mcpScript`, and `bash` searches, listings and reads (`rg`, `grep`, `find`, `ls`, `cat`, `git log`, `git show`, `git diff` and similar). A spot check of a worker's Result counts like any other.
- **Never counted:** `edit`, `write`, the subagents tools (`subagents`, `subagents_status`, `subagents_message`), an `mcp` install or sign-in (`action` `install`, `auth-start` or `auth-complete`), other tools, and `bash` builds, test runs and version-control actions (`npm test`, `npm run build`, `node --test`, `tsc`, `cargo test`, `git commit`, `git push`, `git add` and similar).
- **Unrecognised `bash` counts.** So does any command that redirects output into a file (`> notes.md`, `| tee log`) or rewrites files (`sed -i`, `eslint --fix`, `npm run format`).

A chained command (`&&`, `||`, `;`) is as strong as its strongest part: anything unrecognised, then a version-control action, then a search, then a build or test run. `cd src && rg foo` is a search, `git add -A && git commit -m x` a version-control action, and `rg foo && npm test` a search. A search that only filters a pipe adds nothing, so `npm test 2>&1 | tail -20` is a test run.

The count starts again at each user prompt: each prompt the user sends, one typed while the orchestrator runs included. A run that a message starts, such as a background call's completion notice or a worker's question, goes on counting the last prompt's calls; so does a user message another extension sends. The threshold is read at the session's start and at each user prompt. A malformed setting keeps the default, and the failure is logged once to stderr.

`/pi-orchestrator budget off` lifts the budget for one user prompt: while the orchestrator runs, for the rest of the current prompt; while it is idle, for the next user prompt, not for a run a message starts before it. pi runs the command at once, even while the orchestrator runs. The model cannot lift the budget: no tool does it, and nothing it writes is read as the command.

The budget binds only the orchestrator's own session. Workers, forked workers and sessions in a pi-subagents child process are never budgeted. It comes with the subagents extension, because its deny sends the orchestrator to the `subagents` tool: switching that extension off drops the budget too.

### Status and wait

The `subagents_status` tool, `{ "id"?: string, "wait"?: boolean }`, shows the orchestrator its session's running background calls:

- Without `id` it lists them: each call's id and done count, and each worker's delegation id, agent, state and short task.
- With a call id it gives a snapshot of each of the call's items; with a delegation id, a snapshot of that worker alone. A snapshot holds the worker's state, its current tool, the turns it has started, its elapsed time, the last 5 lines of its latest text and its session file.
- With a call id and `"wait": true` it blocks until the call has finished and returns its results, the same text and details as its completion notice. That notice is then not delivered: a result goes once, to a pending wait, otherwise as the notice. `wait` needs a call id; a delegation id or no id is refused.
- Ctrl+C during a wait stops only the wait. The workers run on, and the call's completion notice follows.
- A worker's `report` question ends a pending wait on its call, and a wait on a call with an unanswered question is refused (see Reports above).

A call that has finished is no longer listed; its results are in its completion notice. Workers do not get `subagents_status`, even when their agent definition's `tools:` list names it.

### Resume

A `resume` item uses a finished worker's delegation id and a new task instead of `agent` or `fork`. It continues that worker's saved session and original pin without a new routing decision. Unknown, running and not-started workers cannot be resumed, nor can workers from another orchestrator session or those without a recoverable pin. The original pin must still pass the hard filters; otherwise the item fails without re-routing. A preserved agent model's ban-list exception is rechecked against current settings. Later verdicts for the same delegation replace earlier ones in the routing report; the record retains all verdicts. A resume item may be background: its delegation id stays the one it resumes.

Each item's result has a status:

| Status | Meaning |
|--------|---------|
| `completed` | The worker finished and returned its final text |
| `failed` | The worker's model call or setup failed, or the item names an unknown agent and no worker started; the result names why |
| `aborted` | The item's worker was running when the call was aborted |
| `not-started` | The item was still queued when the call was aborted |

A worker's session is saved under the orchestrator's session folder, and its session id is its delegation id. A fork's saved session starts with a copy of the active branch up to the fork point; a fork record names its model, effort, parent session id and fork point. Verdicts attach to fork records by delegation id. It loads the same installed extensions as the orchestrator, without the `subagents` tool itself unless its agent definition lists it (see Nested delegation below). A worker's final text over 50 KB is cut, with a pointer to its session file, which keeps the whole text.

While a call runs, pi shows one line per worker: its agent name (`worker` without one), `(fork)` for a fork, its short task, and its current tool or state: queued, running, done, error, aborted or not started. A fork or a worker on a preserved model also shows its model, marked `(ban-list exception)` when an exception let it run. Expanding the result shows each worker's final text or error.

### Worker widget

Below the editor, the orchestrator's session lists its active workers: foreground, background and nested, queued ones included. Each worker has one line:

```text
lead · anthropic/claude-sonnet-4-5:high ↑elevated · running · 1m15s · 2 turns · subagents
└ tester · routing… · running · 1m15s · 0 turns · Check the tests
worker (fork) · anthropic/claude-opus-4-5:high · running · 1m15s · 1 turn · writing…
worker · routing… · queued · Fix the typo
```

- The agent name, `worker` without one, and `(fork)` for a fork.
- The model and effort. A routed worker shows `routing…` until its first request, then the rung serving its latest request, and `↑<tier>` when its routing decision escalated to that tier. A fork or a worker on a preserved agent model shows its fixed model.
- The worker state: queued, running, asking, completed, failed or aborted.
- Once it has started: its elapsed time and the turns it has started.
- Its activity: `thinking…`, `writing…`, the name of the tool it runs (no arguments), or for a failed worker why it failed. Before its first event, its short task. An activity stays at least 1.5 seconds before a newer one replaces it, so a line never changes with each streamed piece of text; a failure shows at once. The transcript view's header shows the same activity.

A worker started by another worker is indented under it. At most 6 workers are listed; a `+N more` line counts the rest. A finished worker stays about 10 seconds with its end state, then drops out, and the widget disappears when no worker is left. The widget only shows workers; it never steers them. A worker's own session shows no widget.

Down enters the widget when it would do nothing in the editor: the cursor is at the end of the editor's last line, you are not browsing the prompt history, no autocomplete list is open, and at least one worker is shown. On the last line, a first Down moves the cursor to the line's end as usual. Alt+a enters it too. In the widget, ↑ ↓ pick a worker and Enter opens its transcript view; leaving the transcript view comes back to the widget with that worker selected. ↑ on the first row, Esc or Ctrl+C go back to the editor with its text untouched, and any other key goes back to the editor and into it. When the selected worker drops out, the selection moves to the row in its place; when the widget empties, the editor gets the keyboard back. Down and alt+a do nothing when no worker is shown. A worker's own session does not bind either.

### Transcript view

The transcript view shows one worker's transcript in place of the orchestrator's session: any worker of the orchestrator's session, foreground, background or nested, running or finished. Leaving it returns to the orchestrator's session as it was, chat, editor text and worker widget included. How it looks depends on pi's TUI mode (see Regular TUI mode and Fullscreen TUI mode below).

Three ways open it. Alt+a on the worker widget, then Enter on the selected row, opens that worker (see Worker widget above). `/subagents` without arguments opens a picker of every worker of the session, finished ones included: one line per worker as the widget shows it, numbered in board order, nested workers indented under their parent delegation; arrow keys and Enter work as in the widget, and Esc or Ctrl+C cancels. Without a UI to pick in, the same command lists every worker as text instead. `/subagents <delegation id>` or `/subagents <list number>` opens that worker directly, skipping the picker; a delegation id or list number that names no worker is refused.

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
- The live lines come last and update in place: the workers it started, at most 6 as the worker widget draws them, the selected one marked; the worker state, elapsed time, turns, tokens, cost, activity and which worker of how many it is; the orchestrator bar; and the key hints.

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
      "explorationBudget": 3,
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
| `subagents.explorationBudget` | Exploratory calls the orchestrator's own session may make per user prompt before the next is denied (see Exploration budget above). A positive integer, default 3. Read at the session's start and at each user prompt |
| `subagents.allowProjectOverrides` | Personal settings only, default `false`. Lets a project's `.pi/settings.json` set every `orchestrator.subagents` key except this one. A project key replaces the personal value whole: a project's `agentDefinitionModel` replaces the personal object, it is not merged into it. Without the flag every project `orchestrator.subagents` key is ignored; with it, a project value for the flag itself is ignored. Each ignored key is logged once to stderr, as `pi-orchestrator subagents: ignored project settings key <key>`, the way the guard logs ignored ban-list keys |

## Settings

pi-orchestrator settings live under the `orchestrator` key in personal settings, `${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json`. The guard and the router extension read them at session start, so a change to their keys needs a new session. The subagents extension reads `orchestrator.subagents`, the subagent ban list and the agent definitions on every call, and `orchestrator.subagents.explorationBudget` at the session's start and at each user prompt.

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

pi-orchestrator can set routing constraints for one worker, by its session id, before its first request:

- A minimum tier raises a lower classified tier to it; escalation goes on from there as usual.
- An excluded rung is removed in every tier, with the reason `excluded rung`, so escalation cannot choose it either. The same model at another effort stays.
- A forced rung, with the tier it stands for, replaces the tier choice. It is pinned if it passes the hard filters. Otherwise routing refuses with the filter it failed, and the worker runs on the orchestrator's session model like any refused worker.

The classifier still runs, so the decision record keeps the tier and why, and its `constraints` field names the constraint. Constraints never lift a hard filter.

The worker keeps the chosen rung as its pin across later requests and compaction. In live mode, a resumed worker can restore its pin from the decision record if the rung still passes the hard filters and the record was made under the same routing constraints. The auto model declares the largest context window in the tier map; an overflow on the pinned rung lets pi compact and retry on that rung. A compaction summary has a new session id and is classified separately. The classifier runs in the worker's process through its session model registry, without an extra `pi` process.

In live mode the worker runs on the chosen rung. In shadow mode the router extension records the shadow decision, but the worker runs on the orchestrator's session model. A routing refusal, disabled routing or an internal routing failure also runs the worker on that model. The router extension sets `PI_ORCHESTRATOR_SESSION_MODEL` from the orchestrator's session model, including for a background worker at delegation time. If that variable is missing or names a model on the subagent ban list, the auto model request fails with a reason instead. A worker started on a real model is not routed; the guard still enforces the subagent ban list.

The orchestrator's main thread stays on the model picked in `/model`. Selecting `orchestrator/auto` there restores the previous model and warns; a saved `orchestrator/auto` default is also put back to the previous model. Without a previous model, it only warns, and the saved default stays unchanged. Only workers should run on the auto model.

## State

Runtime state lives in `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-orchestrator/`, or in `PI_ORCHESTRATOR_STATE_DIR` when set. Nothing is written inside the package checkout.

| File | Contents | When absent |
|------|----------|-------------|
| `authorized-recipients.json` | Providers you approved as data recipients | No provider is approved, so every route refuses |
| `routing/*.jsonl` | One decision record per classified worker session (delegation id), one file per day | Created on the first record |
| `model-catalog.json` | Prices, context windows and usage headroom | Built from installed models and a pinned models.dev snapshot |
| `refresh-state.json` | Throttling observations | No throttle |

Decision records keep the first 200 characters of the task text, with credential-shaped text redacted. The redaction is best effort.

## Switching things off

- **Routing only**: set `orchestrator.routing.enabled` to `false` for the session-model fallback without records, or use `mode: "shadow"` to keep shadow decisions while workers run on the session model.
- **One extension**: filter the package in settings, or use `pi config`:

  ```json
  { "packages": [{ "source": "git:github.com/egonm12/pi-orchestrator", "extensions": ["!src/router/extension.ts"] }] }
  ```

  Use `!src/guard/extension.ts` to keep the router and drop the guard, or `!src/subagents/extension.ts` to drop only the built-in `subagents` tool, and with it the orchestrator protocol, the exploration budget and `/pi-orchestrator budget`, and keep routing for other subagent extensions.
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

The guard protects against accidental mistakes, not a determined agent. It refuses banned models in `model` fields (including nested delegations), `write` and `edit` paths inside the agent directory (except its `sessions/` subtree, where subagent extensions keep run artifacts), and nested `pi` runs that disable extensions or switch agent directory. Bash can still write anywhere, and other extensions' processes are not checked.

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
