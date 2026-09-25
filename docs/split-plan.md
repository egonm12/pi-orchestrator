# Split plan: router and guard out of `~/.pi`

Brief for the session that carries out the split. Every decision below was settled with the owner in a grilling session on 2026-09-25. Do not reopen them; if one turns out to be impossible, stop and ask.

The source is the `pi-orchestration-harness` repo rooted at `~/.pi`, at commit `d561c98`. This repo is `~/development/sandbox/pi-extensions/pi-orchestrator`, to be published as the public repo `github.com/egonm12/pi-orchestrator`. `pi-extensions` is a plain folder, not a repo.

## End goal of this repo

One pi package, `pi-orchestrator`, installed with `pi install git:github.com/egonm12/pi-orchestrator`. It holds three extensions that pi's package filters can switch off one by one:

- **Router**: fills in the model on `subagent` calls that name none (exists, moves now).
- **Guard**: the personal ban-list guard (exists, moves now).
- **Orchestrator enforcement**: keeps the main session in the orchestrator role with a per-turn budget on exploratory commands (ADR 0005). Not part of this split. It gets its own design session afterwards, with `~/development/sandbox/claude-plugins/plugins/orchestrator/` as the reference.

Vocabulary: use `CONTEXT.md` (moved from `~/.pi/CONTEXT.md`). The canonical terms are **worker** (not execution agent), **delegation** (not dispatch or spawn) and **delegation id** (not dispatch attempt id).

## Package shape

- `package.json` with `"keywords": ["pi-package"]`, a `pi.extensions` manifest that lists the router and guard entries, and `@earendil-works/pi-coding-agent` as a `"*"` peer dependency. It has no runtime dependencies. Do not bundle host packages. Import pi's types from the peer dependency instead of `harness/types/pi-extension.ts`.
- Code under `src/`, laid out like `harness/` today (`src/routing/`, `src/router/`, `src/guard/` and so on).
- Tests: `npm test` runs offline. Live tests (router and guard session tests, routing acceptance, latency) run only with `PI_ORCHESTRATOR_LIVE=1`. `npm run typecheck` runs `tsc --noEmit`.
- A GitHub Actions workflow runs the offline tests and the typecheck on a clean clone.
- On the owner's machine the package is installed from the local path (`pi install ~/development/sandbox/pi-extensions/pi-orchestrator`). Other machines install from git. Git installs follow the default branch until orchestrator enforcement ships; after that, releases get tags.

## Behaviour changes in step 2

- **Settings key**: `harness.routing`, `harness.subagentBanList` and `harness.sessionBanList` become `orchestrator.routing`, `orchestrator.subagentBanList` and `orchestrator.sessionBanList`. The old keys are not read. `orchestrator.enforcement` is reserved for later.
- **Empty defaults**: remove the hard-coded `DEFAULT_BAN_LISTS` value `["fable", "astra"]` (`policy/ban-lists.ts:34`). The package ships no ban list and no tier map.
- **Fresh install**: when tiers or the approved-recipients store are missing, print one line at session start that names what is missing and points to `/pi-orchestrator init`. That command writes a starter tier map from the installed models plus a ban list into personal settings, and asks the owner to approve each provider as a recipient. Recipients stay fail closed (ticket 07); never approve one silently.
- **State**: decision records and `authorized-recipients.json` move from `<checkout>/harness/state/` (`DEFAULT_STATE_DIR`, `router/extension.ts:40`) to `${PI_CODING_AGENT_DIR:-~/.pi/agent}/pi-orchestrator/`. Nothing is written inside the package checkout, because pi reconciles git checkouts on update.
- **Fail open per handler**: pi blocks a tool when a `tool_call` handler throws. Wrap every handler so that it logs one line and lets the call through. The router must never block a call.
- **Installers removed**: `router/activate.ts`, `guard/activate.ts`, the `HARNESS_CHECKOUT` gate (`activation/extension-gate.ts`) and the shim `~/.pi/agent/extensions/pi-harness-router.ts`. Pi's package loading replaces them.
- **pi-subagents helpers reimplemented**: pi loads packages with separate module roots, and pi-subagents' `exports` map does not expose these helpers. Reimplement only what the router needs, with tests, from the behaviour of the installed version (0.71.0):
  - `shared/model-info.js`: `toModelInfo`, `splitKnownThinkingSuffix`, `getSupportedThinkingLevels` and the `ModelInfo` type. Used by `router/extension.ts`, `routing/{tier-map,tier-classifier,session-classifier-call,effort-ladder}.ts` and `policy/{model-resolution,ban-lists}.ts`.
  - `runs/shared/model-scope.js`: used by `routing/{tier-router,tier-map}.ts` and `policy/model-resolution.ts`.
  - `agents/agents.js` (`discoverAgents`, `resolveAgentName`), `agents/agent-scope.js` (`resolveExecutionAgentScope`) and `runs/shared/model-resolution.js` (`INHERIT_MODEL`, `resolveEffectiveSubagentModel`). Used only by `router/extension.ts` to tell whether an agent's frontmatter already names a model.
  - An upstream PR asking pi-subagents to export these is a later follow-up, not part of this split.

## What moves

Paths are relative to `~/.pi/harness/`.

**Source (36 files)**

- `budget/task-allowance.ts`
- `catalog/{epistemic,model-catalog,refresh-lifecycle,snapshot,upstream-mapping}.ts` and `catalog/vendor/models-dev.snapshot.json` (loaded through `import.meta.url`, so it works from a package)
- `guard/{boundaries,extension}.ts`
- `policy/{ban-lists,canonical-path,model-resolution}.ts`
- `recipients/{authorization,authorized-dispatch}.ts`
- `router/{evidence,extension,measure-latency}.ts`
- `routing/{classifier-reply,classifier,decision-record,effort-ladder,routing-policy,routing-report,session-classifier-call,skip-reasons,tier-answer-schema,tier-classifier,tier-map,tier-router,tier-rubric,verdicts}.ts` and `routing/verdict-reviewer.md`
- `types/pi-extension.ts` (only until the peer-dependency types replace it)
- `fixtures/{guarded-agent-dir,live-pi-session,pi-launch-log,provider-double,temp-repo}.ts`

**Tests (23 files)**

`acceptance/routing-acceptance`, `budget/task-allowance`, `catalog/{model-catalog,refresh-lifecycle}`, `fixtures/pi-launch-log`, `guard/{boundaries,extension,session}`, `policy/{ban-lists,model-resolution}`, `recipients/discovery-authorization`, `router/{extension,measure-latency,session}`, `routing/{decision-record,pi-classifier-compatibility,routing-policy,routing-report,session-classifier-call,tier-classifier,tier-map,tier-router,verdicts}`, all as `.test.ts`. Add `policy/live-model.test.ts` together with its source.

**Test support (9 files)**: `fixtures/{catalog-facts,installed-model-info,installed-models,routing-decision,session-model-registry}.ts`, `policy/live-model.ts`, `recipients/run-state.ts`, `reporting/accounting.ts`, `policy/orchestrator-launch.ts`. Move the first seven. For the last three, see "Imports to cut" below.

**Docs**: `~/.pi/CONTEXT.md`, `~/.pi/docs/adr/0001` to `0005`, and `router/README.md` and `guard/README.md` as input for the new `README.md`. The new README covers install, `init`, settings, state and the off switches. It does not carry ticket history.

## What does not move

- **Ticket 03's hard boundary** (rejected by ADR 0005): `policy/{orchestrator-boundary,orchestrator-launch,registry-probe,project-precedence}.ts`, `approval/gated-actions.ts`, `activation/plan.ts`.
- **Code that has been replaced**: `routing/pi-classifier-call.ts` (ADR 0004) and `routing/routed-dispatch.ts`.
- **Everything else in the harness**, bounded recovery included. It is archived in `~/.pi`, and a piece is brought over and adapted only when a feature needs it.

## Imports to cut

Found by walking the import graph at `d561c98`. Each of these points from moved code to code that does not move:

| Importer | Imports | Fix |
|---|---|---|
| `router/extension.ts` | `activation/extension-gate.ts` (`HARNESS_CHECKOUT`) | Replaced by the new state dir |
| `router/measure-latency.ts`, `router/{extension,session}.test.ts`, `acceptance/routing-acceptance.test.ts` | `router/activate.ts` | Load the package with `pi -e <checkout>` or a package entry in the guarded agent dir |
| `fixtures/guarded-agent-dir.ts`, `router/extension.test.ts`, `guard/session.test.ts` | `guard/activate.ts` | Same |
| `routing/tier-classifier.test.ts`, `routing/pi-classifier-compatibility.test.ts` | `routing/pi-classifier-call.ts` | Rewrite the live classifier check to use the in-session path (`session-classifier-call.ts`). Update ADR 0004's last consequence bullet to say `pi-classifier-call.ts` stayed in the archive |
| `routing/routing-policy.test.ts`, `policy/ban-lists.test.ts` | `routing/routed-dispatch.ts` | Remove those cases, or keep them against `routing-policy.ts` alone |
| `policy/model-resolution.test.ts` | `policy/orchestrator-launch.ts` | Remove the cases that exercise the launch allowlist |
| `routing/tier-classifier.test.ts` | `reporting/accounting.ts` | Move `accounting.ts` only if the remaining cases need it; otherwise cut the import |
| `recipients/discovery-authorization.test.ts` | `recipients/run-state.ts` | Same judgement |

## Order of work

Make each step its own commit or commits, and check it before you start the next.

1. **Import verbatim.** Make one commit that copies the files above with only path changes (`harness/` to `src/`, and relative paths fixed). The commit message names the source: `Import router and guard from pi-orchestration-harness d561c98`. Do not use `git filter-repo`. Cut the imports listed above. Done when `npm test` and `npm run typecheck` pass offline.
2. **Make it installable.** Apply every item under "Package shape" and "Behaviour changes in step 2". Done when a clean clone passes CI and `pi -e <checkout>` loads both extensions with no errors.
3. **Rename the terms.** Change execution agent to worker, dispatch to delegation, and dispatch attempt id to delegation id, in code, in the decision record fields and in the docs. Leave `subagent` wherever it names pi-subagents' tool or mechanism. Done when a grep for `dispatch` and `execution agent` finds only deliberate uses.
4. **Switch the owner's agent dir.**
   - Write and run a one-off migration script. Do not ship it; delete it or keep it outside `src/`. It moves `~/.pi/harness/state/routing/*.jsonl`, renaming the field to delegation id, and `~/.pi/harness/state/authorized-recipients.json` into `~/.pi/agent/pi-orchestrator/`.
   - Rename the `harness.*` keys in `~/.pi/agent/settings.json` to `orchestrator.*`.
   - Delete the shim `~/.pi/agent/extensions/pi-harness-router.ts`, then run `pi install ~/development/sandbox/pi-extensions/pi-orchestrator`.
   - Done when a live session routes a `subagent` call and writes a decision record in the new state dir.
5. **Archive in `~/.pi`.** Tag `d561c98` or the commit after it as `archive/harness`. Delete `harness/`, `CONTEXT.md`, `docs/adr/`, `tsconfig.json` and the harness scripts and dependencies from `package.json` (or the whole `package.json` if nothing is left), and update `.gitignore`. `~/.pi` stays a git repo. Done when `~/.pi` holds no harness code and pi still starts cleanly.

Then create `github.com/egonm12/pi-orchestrator` as a public repo, push, and check CI. Ask the owner before you create or push the remote.

## Loose ends noted for later

- Verdicts, the reviewer agent and the effort ladder move but are not wired in. Nothing records a verdict today, although the glossary calls verdicts the router's only feedback signal. Wire them up during the orchestrator enforcement design, because the orchestrator is the role that asks for reviews.
- The orchestrator enforcement session decides what counts as an exploratory command in pi, the per-turn budget, the deny message, the worker agent, how the protocol loads, and whether the Claude plugin's reminder and hint lines carry over.
