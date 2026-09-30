import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendRoutingRecord,
  buildEffortLadderRecord,
  buildUnplacedLadderRecord,
  type EffortLadderRecord,
  type LadderMode,
  type RoutingRecord,
} from "../routing/decision-record.ts";
import type { LadderChoice } from "../routing/effort-ladder.ts";
import type { ResolvedTierMap, TierRung } from "../routing/tier-map.ts";
import type { RoutingConstraints } from "../routing/tier-router.ts";
import type { RiskTier } from "../routing/classifier.ts";
import { orchestratorRouter, type OrchestratorRouter } from "../router/orchestrator-router.ts";
import { editingDelegationProblem } from "./quality-gate.ts";
import { readWorkerOutcome } from "./resume.ts";
import { delegationMaterial, type ReviewMaterial } from "./review.ts";
import { workerBoard } from "./worker-board.ts";

// Retries on the effort ladder (ADR 0010). When the orchestrator records
// request_changes on an editing delegation, subagents_verdict (./verdict.ts)
// names the next rung, and a subagents item `retry: <delegation id>` with the
// feedback as its task starts a new delegation on it.
//
// The record story. When a retry starts, before its worker's first request,
// this module writes its effort-ladder record: keyed by the retry's delegation
// id, linked to the failed attempt by `previousDecisionId`, with the step, the
// skipped rungs and the rung (../routing/decision-record.ts). It is the climb,
// and it is counted from then on, however the worker ends. The worker is
// routed with a forced rung, so the router writes the retry's ordinary
// decision record with `constraints.forcedRung` naming the same rung and
// `ranOn` what it ran on. Readers take the ladder record for the link and the
// decision record for what ran (./quality-gate.ts, ../routing/verdicts.ts).
// In shadow mode the forced rung is the one the retry would use, and it runs
// on the session model like any worker. With routing off the router writes
// nothing, so the ladder record is the retry's only record.
//
// Where the ladder climbs from. The failed attempt's latest decision record
// names its tier and rung: the chosen rung in live mode, the would-be rung in
// shadow mode, a retry's forced rung. An attempt the ladder cannot place is
// retried unplaced: routing is off at the retry (no tier map is loaded then),
// it has no decision record (it ran with routing off, it is a fork, or its
// agent definition names its model), its route refused, its rung has left
// the tier map, or the climb failed (its record says with what error). The
// climb runs in the router extension's module copy, through the router it
// published (../router/orchestrator-router.ts). An unplaced retry runs
// without a forced rung: routed as usual, or on the session model with
// routing off. Its record names no rung, says why, and counts as a climb.
//
// A task climbs at most twice. The climbs of one task are the ladder records
// that lead back to the same first attempt, a retry of a retry and a second
// retry of the same attempt alike; a third is refused, and so is a climb the
// ladder has no rung for, with the instruction to take the task back to the
// user.
//
// The retry's task is the failed attempt's own task and later instructions,
// from its saved worker session or, when it was not saved, from the worker
// board, with the orchestrator's feedback. It follows the failed attempt's
// agent definition, as the board or its saved outcome names it.

/** Climbs one task may make on the effort ladder. */
export const MAX_CLIMBS = 2;

/** Where the ladder climbs from: the failed attempt's tier and rung, or why it cannot place it. */
type LadderPosition =
  | { readonly placed: true; readonly tier: RiskTier; readonly rung: TierRung; readonly kindOfWork: string }
  | { readonly placed: false; readonly why: string };

function ladderPosition(records: readonly RoutingRecord[], id: string): LadderPosition {
  const own = records.filter((record) => record.delegationId === id);
  const latest = own.filter((record) => record.recordType === "decision" || record.recordType === "fork" || record.recordType === "agent-model").at(-1);
  if (latest?.recordType === "fork") return { placed: false, why: `delegation ${id} is a forked worker, which runs unrouted on the session model` };
  if (latest?.recordType === "agent-model") return { placed: false, why: `delegation ${id}'s agent definition names its model, so it was not routed` };
  if (latest?.recordType !== "decision") return { placed: false, why: `no routing decision names delegation ${id}'s rung: it ran with routing off` };
  const { route } = latest;
  if (route.outcome !== "chosen") return { placed: false, why: `delegation ${id}'s route refused every rung, so it ran on the session model` };
  return { placed: true, tier: route.tier, rung: route.rung as TierRung, kindOfWork: latest.classification.kindOfWork };
}

/** The attempts of `id`'s task from its first attempt to `id`, and its climbs so far. */
function climbsOf(records: readonly RoutingRecord[], id: string): { readonly chain: readonly string[]; readonly climbs: number } {
  const previous = new Map<string, string>();
  for (const record of records) if (record.recordType === "effort-ladder") previous.set(record.delegationId, record.previousDecisionId);
  // A retry's id is new and never its own previous attempt, so a chain ends; the guard only stops a damaged folder.
  const chainTo = (last: string): string[] => {
    const chain = [last];
    for (let at = previous.get(last); at !== undefined && !chain.includes(at); at = previous.get(at)) chain.unshift(at);
    return chain;
  };
  const chain = chainTo(id);
  return { chain, climbs: [...previous.keys()].filter((retry) => chainTo(retry)[0] === chain[0]).length };
}

/** What a retry of a failed attempt would do now, or why it may not start. */
export type RetryPlan =
  | { readonly kind: "refused"; readonly why: string }
  | { readonly kind: "placed"; readonly mode: OrchestratorRouter["mode"]; readonly climb: number; readonly choice: LadderChoice; readonly kindOfWork: string;
      readonly tierMap: ResolvedTierMap }
  | { readonly kind: "unplaced"; readonly mode: LadderMode; readonly climb: number; readonly why: string };

/** The next climb for the failed attempt `id` of the orchestrator session
 *  `sessionId`, whose retry's task is `taskText`. */
export function planRetry(sessionId: string, id: string, records: readonly RoutingRecord[], taskText: string, at: Date): RetryPlan {
  const { chain, climbs } = climbsOf(records, id);
  if (climbs >= MAX_CLIMBS) {
    return { kind: "refused", why: `its task has climbed the effort ladder ${climbs === 2 ? "twice" : `${climbs} times`} already ` +
      `(delegations ${chain.join(", ")}). Take the task back to the user` };
  }
  const climb = climbs + 1;
  const router = orchestratorRouter(sessionId);
  if (router === undefined) return { kind: "unplaced", mode: "off", climb, why: "routing is off, so no tier map is loaded to climb" };
  const position = ladderPosition(records, id);
  if (!position.placed) return { kind: "unplaced", mode: router.mode, climb, why: position.why };
  let decision;
  try {
    decision = router.climbEffortLadder({ delegationId: id, tier: position.tier, rung: position.rung }, taskText, at);
  } catch (error) {
    // The verdict is recorded before its reply plans the retry, so a failed climb is reported, not thrown.
    return { kind: "unplaced", mode: router.mode, climb, why: `the effort ladder failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (decision.step === "no-position") {
    return { kind: "unplaced", mode: router.mode, climb, why: `its rung ${position.rung.rung} has no position in the ${position.tier} tier of the tier map` };
  }
  if (decision.step === "blocker") {
    return { kind: "refused", why: `the effort ladder is exhausted after ${position.rung.rung}: no rung is left in tiers ` +
      `${decision.tiersTried.join(", ")}. Take the task back to the user` };
  }
  return { kind: "placed", mode: router.mode, climb, choice: decision, kindOfWork: position.kindOfWork, tierMap: router.tierMap };
}

/** One line on where a planned retry runs. */
export function planText(plan: Exclude<RetryPlan, { kind: "refused" }>): string {
  const climb = `climb ${plan.climb} of ${MAX_CLIMBS}`;
  if (plan.kind === "unplaced") {
    return `The effort ladder cannot place it: ${plan.why}. A retry runs ${plan.mode === "off" ? "on the session model" : "routed as usual"}, ${climb}.`;
  }
  const { rung, tier, step } = plan.choice;
  return plan.mode === "live" ? `The next effort-ladder rung is ${rung.rung} at the ${tier} tier (step ${step}), ${climb}.`
    : `The next effort-ladder rung is ${rung.rung} at the ${tier} tier (step ${step}), ${climb}; in shadow mode the retry runs on the session model.`;
}

/** One line on where a started retry of `id` runs, for its Result. */
function startedText(id: string, plan: Exclude<RetryPlan, { kind: "refused" }>): string {
  const retry = `Retry of delegation ${id}, climb ${plan.climb} of ${MAX_CLIMBS}`;
  if (plan.kind === "unplaced") {
    return `${retry}: the effort ladder cannot place it (${plan.why}), so it runs ${plan.mode === "off" ? "on the session model" : "routed as usual"}.`;
  }
  const { rung, tier, step } = plan.choice;
  return plan.mode === "live" ? `${retry}: it runs on ${rung.rung} at the ${tier} tier (step ${step}).`
    : `${retry}: in shadow mode it runs on the session model; the effort ladder's rung would be ${rung.rung} at the ${tier} tier (step ${step}).`;
}

/** Why the delegation `id` may not be retried, or `undefined` when it may: a
 *  finished editing delegation of this orchestrator session whose latest
 *  verdict, recorded after its latest edit, is request_changes. */
function retryProblem(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string, records: readonly RoutingRecord[]): string | undefined {
  const checked = editingDelegationProblem(ctx, records, id);
  if (checked.problem !== undefined) {
    const { problem } = checked;
    return problem.kind === "running" ? "it is still running"
      : problem.kind === "nested" ? `it is a worker's own worker; its edits count for delegation ${problem.delegationId}, so retry that one`
      : problem.kind === "research" ? "it did not edit; only an editing delegation whose latest verdict is request_changes is retried"
      : problem.kind === "unknown" ? "unknown delegation id" : "it belongs to another orchestrator session";
  }
  const latest = records.filter((record) => record.delegationId === id && (record.recordType === "edit" || record.recordType === "verdict")).at(-1);
  if (latest?.recordType !== "verdict") return "its latest edit has no verdict; record request_changes with subagents_verdict first";
  if (latest.verdict !== "request_changes") return `its latest verdict is ${latest.verdict}; only a delegation whose latest verdict is request_changes is retried`;
  return undefined;
}

/** The retry's task: the failed attempt's task and later instructions with the feedback. */
export function retryTask(id: string, feedback: string, material: ReviewMaterial): string {
  const [task, ...later] = material.tasks;
  return [
    `Retry of delegation ${id}, whose changes were requested. Do its task again and address every point of the feedback. ` +
      "Its changes are still in the working tree unless the feedback says otherwise. " +
      (material.sessionFile === undefined ? "Its session was not saved." : `Its saved session, with the whole transcript: ${material.sessionFile}`),
    `<feedback>\n${feedback}\n</feedback>`,
    `<task>\n${task}\n</task>`,
    ...later.map((text) => `<later-instruction>\n${text}\n</later-instruction>`),
  ].join("\n\n");
}

/** A retry's task and agent definition, before it is checked or planned. */
export interface RetrySetup {
  readonly task: string;
  readonly agent?: string;
  /** The failed attempt's label, which the retry's worker row keeps (CONTEXT.md, Label). */
  readonly label?: string;
}

/** The task, agent definition and label of a retry of `id` with `feedback`;
 *  throws when the failed attempt's task is not known. */
export function retrySetup(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string, feedback: string,
  records: readonly RoutingRecord[]): RetrySetup {
  const material = delegationMaterial(ctx, id, records);
  if (material.tasks.length === 0) {
    throw new Error(`cannot retry delegation ${id}: its task is not known, as neither its saved session nor this session's worker board has it`);
  }
  const onBoard = workerBoard().byDelegation(id);
  const saved = material.sessionFile === undefined ? undefined : readWorkerOutcome(material.sessionFile);
  const agent = onBoard?.agent ?? saved?.agent, label = onBoard?.label ?? saved?.label;
  return { task: retryTask(id, feedback, material), ...(agent === undefined ? {} : { agent }), ...(label === undefined ? {} : { label }) };
}

/** A retry that has started its climb. */
export interface StartedRetry {
  /** The routing constraints of a placed retry: its forced rung. */
  readonly constraints?: RoutingConstraints;
  /** The ladder record written for it. */
  readonly record: EffortLadderRecord;
  /** One line on where it runs, for its Result. */
  readonly text: string;
}

/** Checks and plans a retry of the failed attempt `id` as delegation
 *  `delegationId`, then writes its effort-ladder record. Throws with the reason when it may not start. */
export function startRetry(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string, setup: RetrySetup,
  options: { readonly delegationId: string; readonly recordDir: string; readonly records: readonly RoutingRecord[]; readonly at: Date }): StartedRetry {
  const { delegationId, recordDir, records, at } = options;
  const problem = retryProblem(ctx, id, records);
  if (problem !== undefined) throw new Error(`cannot retry delegation ${id}: ${problem}`);
  const plan = planRetry(ctx.sessionManager.getSessionId(), id, records, setup.task, at);
  if (plan.kind === "refused") throw new Error(`cannot retry delegation ${id}: ${plan.why}.`);
  const common = { delegationId, at, previousDecisionId: id, taskText: setup.task, agentRole: setup.agent ?? "unknown" };
  const record = plan.kind === "unplaced"
    ? buildUnplacedLadderRecord({ ...common, mode: plan.mode, detail: plan.why })
    : buildEffortLadderRecord({ ...common, mode: plan.mode, step: plan.choice.step, skipped: plan.choice.skipped,
      kindOfWork: plan.kindOfWork, tierMap: plan.tierMap, route: plan.choice });
  appendRoutingRecord(recordDir, record);
  return {
    record, text: startedText(id, plan),
    ...(plan.kind === "placed" ? { constraints: { forcedRung: { rung: plan.choice.rung, tier: plan.choice.tier } } } : {}),
  };
}
