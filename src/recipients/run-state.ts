// Ticket 07: once execution has started, switching is no longer a free choice.
//
// This is a NARROW seam, not a recovery system. Ticket 17 builds checkpoints
// and restart reconciliation properly. What is needed here is the single
// structural guarantee the ticket asks for: work that has started cannot be
// reassigned to another model until it has been stopped or checkpointed and
// then reconciled, so a second model cannot repeat actions the first already
// took.
//
// The phases:
//
//   planned ---markStarted--> started ---stopRun-------> stopped ------.
//                                \                                      \
//                                 `--checkpointRun--> checkpointed ------+--reconcileRun--> reconciled
//                                 \                                                              |
//                                  `--completeRun--> completed                            reassignRun
//                                                                                                |
//                                                                                                v
//                                                                                     planned (new model)
//
// `reassignRun` is reachable ONLY from `reconciled`. From `started` it fails.
//
// WHY "NO DUPLICATED EFFECTS" IS STRUCTURAL HERE
// `markStarted` is the only function that appends to `delegations`. Reassignment
// does not delegate; it returns a run ready to be started again. So while the
// first delegation is unreconciled, `reassignRun` fails, `markStarted` is never
// reached for the second model, and `delegations.length` stays 1. The absence of
// a duplicate is a consequence of where the append lives, not of a convention
// asking callers to be careful.
//
// Every transition is pure: it returns a new state and never mutates the input,
// and on refusal it returns the input state unchanged so a caller cannot half-
// apply a rejected transition.

import { isProhibitedModel } from "../policy/model-resolution.ts";

export type RunPhase =
  | "planned"
  | "started"
  | "stopped"
  | "checkpointed"
  | "reconciled"
  | "completed";

export type RunEventKind =
  | "planned"
  | "started"
  | "stopped"
  | "checkpointed"
  | "reconciled"
  | "completed"
  | "reassigned";

export interface RunEvent {
  readonly kind: RunEventKind;
  readonly at: string;
  readonly model: string;
  readonly detail?: string;
}

/** An actual delegation: work handed to a model. Appended only by markStarted. */
export interface RunDelegation {
  readonly model: string;
  readonly startedAt: string;
}

export interface Checkpoint {
  /** What the first model had already done when it was interrupted. Free-form
   *  here on purpose -- ticket 17 defines the real reconciliation payload. */
  readonly completedActions: readonly string[];
  readonly at: string;
}

export interface RunState {
  readonly runId: string;
  readonly taskId: string;
  readonly phase: RunPhase;
  /** The model this run is currently assigned to. */
  readonly model: string;
  readonly delegations: readonly RunDelegation[];
  readonly history: readonly RunEvent[];
  readonly checkpoint?: Checkpoint;
  /** Set by reconcileRun. Reassignment requires it. */
  readonly reconciledActions?: readonly string[];
}

export type RunTransitionFailureCode =
  | "prohibited_model"
  | "already_started"
  | "not_started"
  | "unreconciled_work"
  | "not_reconciled"
  | "already_completed"
  | "nothing_to_reconcile";

export type RunTransition =
  | { readonly ok: true; readonly state: RunState }
  | {
      readonly ok: false;
      readonly code: RunTransitionFailureCode;
      readonly message: string;
      /** The input state, unchanged. */
      readonly state: RunState;
    };

function event(kind: RunEventKind, model: string, at: string, detail?: string): RunEvent {
  return detail === undefined ? { kind, at, model } : { kind, at, model, detail };
}

function now(at?: string): string {
  return at ?? new Date().toISOString();
}

class ProhibitedRunModelError extends Error {
  readonly code = "prohibited_model";

  constructor(model: string) {
    super(`pi-orchestration-harness: cannot plan run on prohibited model '${model}'.`);
    this.name = "ProhibitedRunModelError";
  }
}

export function planRun(input: {
  readonly runId: string;
  readonly taskId: string;
  readonly model: string;
  readonly at?: string;
}): RunState {
  if (isProhibitedModel(input.model)) throw new ProhibitedRunModelError(input.model);
  const at = now(input.at);
  return {
    runId: input.runId,
    taskId: input.taskId,
    phase: "planned",
    model: input.model,
    delegations: [],
    history: [event("planned", input.model, at)],
  };
}

/**
 * Hand the work to the model. The ONLY function that records a delegation, which
 * is what makes a duplicate structurally impossible while a run is
 * unreconciled.
 */
export function markStarted(state: RunState, at?: string): RunTransition {
  if (isProhibitedModel(state.model)) {
    return {
      ok: false,
      code: "prohibited_model",
      state,
      message: `pi-orchestration-harness: cannot start run ${state.runId} on prohibited model '${state.model}'.`,
    };
  }
  if (state.phase === "started") {
    return {
      ok: false,
      code: "already_started",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is already started on ` +
        `'${state.model}'. Starting it again would delegate the same task twice.`,
    };
  }
  if (state.phase === "completed") {
    return {
      ok: false,
      code: "already_completed",
      state,
      message: `pi-orchestration-harness: run ${state.runId} has already completed.`,
    };
  }
  if (state.phase !== "planned") {
    return {
      ok: false,
      code: "unreconciled_work",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is '${state.phase}', not ` +
        "'planned'. Reconcile it and reassign before starting work again.",
    };
  }
  const stamp = now(at);
  return {
    ok: true,
    state: {
      ...state,
      phase: "started",
      delegations: [...state.delegations, { model: state.model, startedAt: stamp }],
      history: [...state.history, event("started", state.model, stamp)],
    },
  };
}

export function stopRun(state: RunState, reason: string, at?: string): RunTransition {
  if (state.phase !== "started") {
    return {
      ok: false,
      code: "not_started",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is '${state.phase}'; only a ` +
        "started run can be stopped.",
    };
  }
  const stamp = now(at);
  return {
    ok: true,
    state: {
      ...state,
      phase: "stopped",
      history: [...state.history, event("stopped", state.model, stamp, reason)],
    },
  };
}

export function checkpointRun(
  state: RunState,
  completedActions: readonly string[],
  at?: string,
): RunTransition {
  if (state.phase !== "started") {
    return {
      ok: false,
      code: "not_started",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is '${state.phase}'; only a ` +
        "started run can be checkpointed.",
    };
  }
  const stamp = now(at);
  return {
    ok: true,
    state: {
      ...state,
      phase: "checkpointed",
      checkpoint: { completedActions: [...completedActions], at: stamp },
      history: [
        ...state.history,
        event(
          "checkpointed",
          state.model,
          stamp,
          `${completedActions.length} completed action(s) recorded`,
        ),
      ],
    },
  };
}

/**
 * Reconcile what actually happened before anyone else touches the task.
 *
 * Reachable only from `stopped` or `checkpointed`: reconciling a run that is
 * still executing would be reconciling a moving target, which is the mistake
 * that lets two models act on the same task.
 */
export function reconcileRun(state: RunState, at?: string): RunTransition {
  if (state.phase !== "stopped" && state.phase !== "checkpointed") {
    return {
      ok: false,
      code: "nothing_to_reconcile",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is '${state.phase}'. Stop or ` +
        "checkpoint it first; a run that is still executing cannot be reconciled.",
    };
  }
  const stamp = now(at);
  const actions = state.checkpoint?.completedActions ?? [];
  return {
    ok: true,
    state: {
      ...state,
      phase: "reconciled",
      reconciledActions: [...actions],
      history: [
        ...state.history,
        event(
          "reconciled",
          state.model,
          stamp,
          `${actions.length} completed action(s) reconciled; a replacement must not repeat them`,
        ),
      ],
    },
  };
}

/**
 * Assign the task to a different model.
 *
 * Refused from `started`: the first model is still holding the work, and a
 * second delegation would duplicate whatever it has already done. Refused from
 * `stopped`/`checkpointed` too -- halting is not the same as knowing what was
 * already done, and the ticket asks for both.
 *
 * Returns a run in `planned` on the new model, with the delegation history and
 * the reconciled actions intact. It does NOT delegation: `markStarted` does that,
 * and keeping the append in one place is what makes the no-duplicate guarantee
 * structural.
 */
export function reassignRun(
  state: RunState,
  newModel: string,
  at?: string,
): RunTransition {
  if (isProhibitedModel(newModel)) {
    return {
      ok: false,
      code: "prohibited_model",
      state,
      message: `pi-orchestration-harness: cannot reassign run ${state.runId} to prohibited model '${newModel}'.`,
    };
  }
  if (state.phase === "started") {
    return {
      ok: false,
      code: "unreconciled_work",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is still started on ` +
        `'${state.model}'. Stop or checkpoint it and reconcile before ` +
        `reassigning to '${newModel}'; launching a second model now would ` +
        "repeat actions the first one may already have taken.",
    };
  }
  if (state.phase !== "reconciled") {
    return {
      ok: false,
      code: "not_reconciled",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is '${state.phase}', not ` +
        `'reconciled'. Reconcile the interrupted work before reassigning to ` +
        `'${newModel}'.`,
    };
  }
  const stamp = now(at);
  return {
    ok: true,
    state: {
      ...state,
      phase: "planned",
      model: newModel,
      history: [
        ...state.history,
        event(
          "reassigned",
          newModel,
          stamp,
          `reassigned from '${state.model}' after reconciliation`,
        ),
      ],
    },
  };
}

export function completeRun(state: RunState, at?: string): RunTransition {
  if (state.phase !== "started") {
    return {
      ok: false,
      code: "not_started",
      state,
      message:
        `pi-orchestration-harness: run ${state.runId} is '${state.phase}'; only a ` +
        "started run can complete.",
    };
  }
  const stamp = now(at);
  return {
    ok: true,
    state: {
      ...state,
      phase: "completed",
      history: [...state.history, event("completed", state.model, stamp)],
    },
  };
}

/** True when a different model may be assigned right now. */
export function canReassign(state: RunState): boolean {
  return state.phase === "reconciled";
}

export const RUN_RECORD_PREFIX = "RUN=";

export function formatRunRecord(state: RunState): string {
  return `${RUN_RECORD_PREFIX}${JSON.stringify({
    runId: state.runId,
    taskId: state.taskId,
    phase: state.phase,
    model: state.model,
    delegations: state.delegations,
    reconciledActions: state.reconciledActions ?? null,
    canReassign: canReassign(state),
  })}`;
}
