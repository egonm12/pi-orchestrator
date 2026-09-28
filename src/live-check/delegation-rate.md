# Live measurement: the delegation rate again

Ticket: bean `pi-orchestrator-53x3` (parent `pi-orchestrator-cml8`, user story 19). ADR 0013 said the delegation rate must be measured again once the protocol reaches every run, and that the decision is revisited if the rate stays near 6 of 29. The owner runs this measurement on their own sessions. Its result goes into the bean and is referenced from ADR 0013.

`delegation-rate.ts` is a script, not an extension. It never loads into pi and never changes a session. It reads pi's session files after the fact.

## What is measured

The method follows the baseline so the two figures can be compared. The baseline is ADR 0005's measurement: Claude Code with the orchestrator plugin, on advice alone, 75 prompts from real sessions labelled by hand, 23 September 2026.

| Term | Definition |
|------|------------|
| Prompt | One user message in an orchestrator session, from that message to the next user message. Runs that a completion notice, a report or a gate reminder wakes belong to the prompt before them. |
| Orchestrator session | A main pi session (a top-level file in a project folder under `~/.pi/agent/sessions`) whose recorded system prompt held the orchestrator protocol at least once. Workers' sessions live in `subagents/` and are never read. |
| Needed (denominator) | A plain prompt the owner labelled `delegate`: answering it needs an investigation. |
| Delegated (numerator) | A needed prompt in which the orchestrator started at least one worker: a `subagents` call (each item counts), or a pi-subagents `subagent` call. An attempt counts even if routing refused it: it measures the decision to delegate. |
| Headline rate | delegated / needed, over plain prompts only. The baseline routed slash commands apart, so its 29 hold no skill prompts. Skill prompts are reported on their own line. |
| Baseline | 6 of 29 (21%). Secondary: 15 of 29 needed prompts ran more than 2 exploratory commands without delegating. Its two labellers agreed on 88% of route labels. |

The summary also reports, as context and not part of the decision:

- quick prompts (`self`) that started a worker anyway, which is the over-delegation ADR 0013 mentions
- needed prompts with more than 2 exploratory calls before the first worker, or in total when none was started (the baseline's 15 of 29). Exploratory calls are counted the way the exploration nudge counts them.
- exploration nudges and gate reminders seen in tool results, and wake-ups by `subagents-*` messages
- the models the orchestrator ran on, and how many prompts followed a recorded system prompt with the protocol

## Decision threshold

The decision compares the headline with the baseline by a one-sided Fisher exact test (is the new rate higher than 6 of 29?).

| Summary's last line | When | What it means for ADR 0013 |
|---------------------|------|-----------------------------|
| `DECISION: INSUFFICIENT SAMPLE` | fewer than 29 plain prompts labelled `delegate` | no decision yet; extend the window once (step 6) |
| `DECISION: IMPROVED` | p < 0.05 | the decision stands |
| `DECISION: NEAR BASELINE` | p ≥ 0.05 with at least 29 needed | revisit ADR 0013 with this evidence, as its consequences say |

At exactly 29 needed prompts, IMPROVED takes at least 13 delegated (45%, p = 0.046). 12 of 29 gives p = 0.077.

## Before you start

- pi loads pi-orchestrator from this checkout (`~/.pi/agent/settings.json` packages lists `../../development/sandbox/pi-extensions/pi-orchestrator`), so the sessions run the code at this checkout's `HEAD`. It has to include commit `318435c` (protocol on every run), which is the script's default `--since`.
- Run the protocol live check (`protocol-probe.md`, bean `pi-orchestrator-6yxt`) first, or at least once during the window. This measurement's `protocol` count comes from the system prompts pi records in the transcript. The fix that keeps the protocol on runs a message starts works per request and does not show in the transcript, so only the probe proves it per request.
- Decide the window **before** you start, for example 7 days, and write down its start and end. Do not run `summarize` before the window ends: stopping when the number looks good biases the result.
- Work as usual in any projects and do not change how you prompt. The baseline had 29 needed prompts in 75. At a similar mix, 29 needed prompts takes about 75 prompts.
- Note `pi --version`, `git rev-parse --short HEAD` in this repository at the start and at the end, your `orchestrator.subagents.explorationNudge` setting (default 3) and your gate level.

## Run it

From the repository root:

1. Work through the window.

2. Extract the window's prompts. `--until` is exclusive. The output folder defaults to `~/.pi/agent/pi-orchestrator/live-check/delegation-rate-<time>/`, and the script refuses a folder inside this repository.

   ```sh
   cd /Users/egonmeijers/development/sandbox/pi-extensions/pi-orchestrator
   OUT="$HOME/.pi/agent/pi-orchestrator/live-check/delegation-rate-1"
   node src/live-check/delegation-rate.ts extract --since 2026-09-29T00:08:31+02:00 --until <end, ISO> --out "$OUT"
   ```

   It prints how many session files it read, how many orchestrator sessions and prompts it found, and the two files it wrote.

3. Label blind. Open `$OUT/labels.jsonl` in an editor and do **not** open `$OUT/outcomes.jsonl`. Each line is `{"id":…,"route":"","kind":…,"text":…}`, in id order, not time order. Set `route` on every line from the text alone, using the baseline's criteria:

   | `route` | When |
   |---------|------|
   | `delegate` | Answering needs an investigation: reading or searching several files, comparing versions, tracing a failure, reviewing code, judging risks, or a multi-step implementation. |
   | `self` | Answering is quick: a single known lookup, a small visible edit, a direct action like commit or push, a decision, a yes or no, or a short conversational reply. |
   | `skip` | Not a prompt you typed: a message another extension sent (such as `[GOAL CONFIRMATION …]`), a pasted continuation of the previous prompt, or a prompt about this measurement itself. |

   A skill prompt reads as `/skill:<name> <what you typed>`. Label it by the work it asks for.

4. Optional second labeller, for agreement: copy the file with the routes blanked, and have someone else, or yourself a few days later, label the copy the same way.

   ```sh
   node -e 'const fs=require("fs");const [a,b]=process.argv.slice(1);fs.writeFileSync(b,fs.readFileSync(a,"utf8").split("\n").filter(Boolean).map(l=>JSON.stringify({...JSON.parse(l),route:""})).join("\n")+"\n",{mode:0o600})' "$OUT/labels.jsonl" "$OUT/labels-second.jsonl"
   ```

   The second file only feeds the agreement line. The decision uses the first.

5. Summarize:

   ```sh
   node src/live-check/delegation-rate.ts summarize "$OUT"
   node src/live-check/delegation-rate.ts summarize "$OUT" --second-labels "$OUT/labels-second.jsonl"
   ```

   It refuses while any line is unlabelled or has a route other than `delegate`, `self` or `skip`. It prints counts and hashed ids only, and ends with the `DECISION` line.

6. On `INSUFFICIENT SAMPLE` only: extend the window once, by the same length, and extract into a **new** folder. Your labels carry over by id, so you only label the new lines:

   ```sh
   node src/live-check/delegation-rate.ts extract --since 2026-09-29T00:08:31+02:00 --until <new end> --out "$OUT-2" --labels-from "$OUT/labels.jsonl"
   ```

   Then repeat steps 3 and 5 on `$OUT-2`. If it is still insufficient, record the result as insufficient.

## Anonymization

- `labels.jsonl` holds your prompt text. It stays on your machine, is written with mode 600, and must never be committed or pasted. `outcomes.jsonl` holds no text, paths, project names or session ids, only counts, the time, the model and hashed ids.
- The summary holds only counts, the models and hashed ids (`not delegated although needed` lists the ids, so you can look those prompts up in your own labels file). It is the only part that goes into the bean.
- When the result is recorded, delete the folders: `rm -r "$OUT" "$OUT-2"`.

## Record the result

Append to the bean, and tick its second and third acceptance criteria:

```sh
beans update pi-orchestrator-53x3 --body-append "## Measurement result

Window: <since> to <until>. pi <version>. pi-orchestrator <commit at start>..<commit at end>. explorationNudge <n>, gate level <level>. Labellers: <who>.

\`\`\`text
<summary output, verbatim>
\`\`\`

<one or two sentences: anything unusual in the window, such as a project that was mostly one kind of work>"
```

Then add the result to ADR 0013's consequences, in one line such as `Remeasured <date>: delegated <x> of <n> needed (<p>%), p = <p> against 6 of 29: <decision>. See bean pi-orchestrator-53x3.` On `NEAR BASELINE`, open a bean to revisit the decision.

## Limits

- The labeller is not blind to their own memory of the session. A second labeller a few days later reduces that.
- Entries are read in file order. A session branched with `/tree` puts both branches' calls under the prompt before them.
- A user message another extension sent looks like a typed one in the transcript. Mark it `skip`. Its calls are then left out, and they do not count toward the prompt before it.
- The baseline was Claude Code with a different harness. The comparison is the one ADR 0013 asks for, not a controlled experiment.
