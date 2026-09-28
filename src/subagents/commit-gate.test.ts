import assert from "node:assert/strict";
import { test } from "node:test";
import { commitDenial, gatedGitAction, UnjudgedNotices } from "./commit-gate.ts";

// The commit gate (ADR 0010): while an editing delegation waits for a verdict,
// the orchestrator's git commit and git push are denied, and a turn end names
// the delegations. Seams: `gatedGitAction` over a bash command, the deny text,
// and `UnjudgedNotices` over the unjudged delegations at each turn end.

test("git commit and git push are found in chains, pipes and after git's own options; other git and other commands are not", () => {
  const cases: readonly [string, "commit" | "push" | undefined][] = [
    ["git commit -m wip", "commit"],
    ["git push", "push"],
    ["npm test && git add -A && git commit -m x", "commit"],
    ["npm test; git push origin main", "push"],
    ["git status | cat && git push", "push"],
    ["git -C ../other commit -am x", "commit"],
    ["git -c user.name=me commit -m x", "commit"],
    ["git --no-pager -C sub push --force-with-lease", "push"],
    ["cd repo\ngit commit -F - <<'EOF'\nfix: a\nEOF", "commit"],
    ["git add -A", undefined],
    ["git log --oneline -5", undefined],
    ["git commit-tree HEAD^{tree}", undefined],
    ["rg 'git push' README.md", undefined],
    ["echo git commit", undefined],
    ["npm test", undefined],
  ];
  for (const [command, action] of cases) assert.equal(gatedGitAction(command), action, command);
});

test("a command the reader cannot follow is matched by its text, so a commit message from a command substitution is caught", () => {
  const cases: readonly [string, "commit" | "push" | undefined][] = [
    ["git commit -m \"$(cat <<'EOF'\nfix: a\nEOF\n)\"", "commit"],
    ["echo \"$(date)\" && git -C repo push", "push"],
    ["rg \"$(git log -1 --format=%s)\" notes.md", undefined],
    ["git log --grep \"$(echo push)\"", undefined],
  ];
  for (const [command, action] of cases) assert.equal(gatedGitAction(command), action, command);
});

test("the deny names each unjudged delegation and says how to proceed", () => {
  assert.equal(commitDenial("commit", ["delegation a1 (agent scout)"]),
    "pi-orchestrator: git commit is denied while an editing delegation waits for your verdict: delegation a1 (agent scout). " +
    "Judge each Result and record its verdict with `subagents_verdict`, then commit.");
  assert.equal(commitDenial("push", ["delegation a1", "delegation b2 (still running)"]),
    "pi-orchestrator: git push is denied while 2 editing delegations wait for your verdict: delegation a1, delegation b2 (still running). " +
    "Judge each Result and record its verdict with `subagents_verdict`, then push.");
});

const label = (id: string) => `delegation ${id}`;
const waiting = (...ids: readonly string[]) => ids.map((id) => ({ delegationId: id, lastEdit: `2026-09-28T10:00:0${ids.indexOf(id)}.000Z` }));

test("a turn end names the unjudged delegations once, and again only when they change or at the next user prompt", () => {
  const notices = new UnjudgedNotices();
  const first = notices.atTurnEnd(waiting("a"), label);
  assert.equal(first, "pi-orchestrator: an editing delegation waits for your verdict: delegation a. " +
    "Judge each Result and record its verdict with `subagents_verdict`; git commit and git push are denied until then.");
  assert.equal(notices.atTurnEnd(waiting("a"), label), undefined, "nothing changed");
  assert.match(notices.atTurnEnd(waiting("a", "b"), label) ?? "", /2 editing delegations wait for your verdict: delegation a, delegation b\./);
  assert.equal(notices.atTurnEnd(waiting("a", "b"), label), undefined);
  assert.equal(notices.atTurnEnd([], label), undefined, "nothing waits");
  assert.equal(notices.atTurnEnd(waiting("a"), label), first, "a delegation that waits again is named again");
  notices.userPrompt();
  assert.equal(notices.atTurnEnd(waiting("a"), label), first, "a new user prompt gets the notice once more");
  assert.equal(notices.atTurnEnd(waiting("a"), label), undefined);
});

test("a resume that edits again after the verdict is a new wait, named again", () => {
  const notices = new UnjudgedNotices();
  assert.ok(notices.atTurnEnd([{ delegationId: "a", lastEdit: "2026-09-28T10:00:00.000Z" }], label));
  assert.ok(notices.atTurnEnd([{ delegationId: "a", lastEdit: "2026-09-28T11:00:00.000Z" }], label));
});
