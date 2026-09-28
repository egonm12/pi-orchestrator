import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { appendRoutingRecord, buildEditRecord, type EditRecord, type RoutingRecord, type Verdict, type VerdictRecord } from "../routing/decision-record.ts";
import { classifyToolCall } from "./tool-call-kind.ts";

// Editing delegations (ADR 0010). A delegation edited when its worker, or a
// worker it started, ran an editing tool call; the orchestrator must then
// record a verdict on it (./verdict.ts). The fact is kept as an edit record in
// the routing record folder, keyed by the delegation id and naming the
// orchestrator session, so it outlives the worker and a pi reload. Each run
// of a worker writes at most one: a resumed delegation writes another when it
// edits again, and a verdict recorded before that edit no longer covers it.
//
// A worker's own worker writes the record under the delegation that started
// it, with its own id beside it. Workers run in the orchestrator's process
// and each extension gets a fresh module copy, so the running delegations are
// kept on the process's global object, as worker-sessions.ts keeps its marks.

/** Tools that run whatever code they are given. The exploration budget counts
 *  them as exploratory (ADR 0005); in a worker they may edit (owner decision
 *  2026-09-28). */
const ARBITRARY_CODE_TOOLS = new Set(["ctx_execute", "ctx_execute_file"]);

/** Whether a tool call edits: `edit` or `write`, bash (or powershell) that is
 *  neither read-only nor a build or test run, and the arbitrary-code tools. */
export function isEditingToolCall(toolName: string, input: unknown): boolean {
  if (ARBITRARY_CODE_TOOLS.has(toolName)) return true;
  const kind = classifyToolCall(toolName, input);
  return kind === "edit" || kind === "version-control" || kind === "unrecognised";
}

/** One run of a delegation: the orchestrator's delegation its edits count for. */
interface DelegationRun {
  readonly delegationId: string;
  readonly orchestratorSession: string;
  /** Its worker, or a worker it started, has edited in this run. */
  edited: boolean;
}

const RUNS = Symbol.for("pi-orchestrator.subagents.editing-runs");
type ProcessGlobal = typeof globalThis & { [RUNS]?: Map<string, DelegationRun> };
const runs = (): Map<string, DelegationRun> => (globalThis as ProcessGlobal)[RUNS] ??= new Map();

export interface EditTracking {
  /** The worker's extension that watches its executed tool calls. */
  readonly extension: InlineExtension;
  /** Whether the worker, or a worker it started, edited in this run. */
  edited(): boolean;
  /** Ends the run's tracking, once the worker has ended. */
  stop(): void;
}

export interface EditTrackingSetup {
  /** The worker's session id: its delegation id. */
  readonly sessionId: string;
  /** Set when a worker, not the orchestrator, started this one. */
  readonly parentDelegationId?: string;
  /** The session that made the delegation; for a worker's own worker, the
   *  delegation that started it names the orchestrator's instead. */
  readonly orchestratorSession: string;
  readonly recordDir: string;
}

/** Tracks one run of a worker from before its session starts until `stop`. */
export function trackEdits(setup: EditTrackingSetup): EditTracking {
  const { sessionId, parentDelegationId } = setup;
  // The parent runs for as long as its worker does, so it is found; the
  // fallback keeps a worker running if it is not.
  const run: DelegationRun = (parentDelegationId === undefined ? undefined : runs().get(parentDelegationId)) ??
    { delegationId: parentDelegationId ?? sessionId, orchestratorSession: setup.orchestratorSession, edited: false };
  runs().set(sessionId, run);
  let editedHere = false;
  let recorded = false;
  const extension: InlineExtension = {
    name: "pi-orchestrator-edit-tracking",
    factory: (pi) => { pi.on("tool_result", (event) => {
      // tool_result follows only a call that ran: one a hook blocked edited nothing.
      if (!isEditingToolCall(event.toolName, event.input)) return;
      editedHere = true;
      run.edited = true;
      if (recorded) return;
      try {
        appendRoutingRecord(setup.recordDir, buildEditRecord({
          delegationId: run.delegationId, orchestratorSession: run.orchestratorSession, tool: event.toolName,
          ...(run.delegationId === sessionId ? {} : { nestedDelegationId: sessionId }),
        }));
        recorded = true;
      } catch (error) {
        // The next editing call tries again.
        process.stderr.write(`pi-orchestrator subagents: could not record delegation ${run.delegationId}'s edit: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }); },
  };
  return {
    extension,
    edited: () => run.delegationId === sessionId ? run.edited : editedHere,
    stop: () => { if (runs().get(sessionId) === run) runs().delete(sessionId); },
  };
}

/** What the record folder says about one delegation's edits. */
export type DelegationEdits =
  | {
      readonly kind: "edited";
      /** The orchestrator session that made the delegation. */
      readonly orchestratorSession: string;
      /** Its latest verdict, if one was recorded. */
      readonly verdict?: Verdict;
    }
  /** A worker's own worker edited, and its edits count for `delegationId`. */
  | { readonly kind: "nested"; readonly delegationId: string }
  | { readonly kind: "none" };

/** The edits of `delegationId` in `records`, the record folder in file order. */
export function delegationEdits(records: readonly RoutingRecord[], delegationId: string): DelegationEdits {
  const edits = records.filter((record): record is EditRecord => record.recordType === "edit");
  const own = edits.filter((record) => record.delegationId === delegationId).at(-1);
  if (own !== undefined) {
    const verdict = records.filter((record): record is VerdictRecord => record.recordType === "verdict" && record.delegationId === delegationId).at(-1);
    return {
      kind: "edited",
      orchestratorSession: own.orchestratorSession,
      ...(verdict === undefined ? {} : { verdict: verdict.verdict }),
    };
  }
  const nested = edits.find((record) => record.nestedDelegationId === delegationId);
  return nested === undefined ? { kind: "none" } : { kind: "nested", delegationId: nested.delegationId };
}

/** An editing delegation that waits for a verdict. */
export interface UnjudgedDelegation {
  readonly delegationId: string;
  /** Its latest edit record's timestamp: a later edit is a new wait. */
  readonly lastEdit: string;
}

/** The editing delegations of `orchestratorSession` in `records`, the record
 *  folder in file order, whose latest edit record has no verdict after it,
 *  in the order of their latest edits. A verdict of either kind judges a delegation. */
export function unjudgedDelegations(records: readonly RoutingRecord[], orchestratorSession: string): UnjudgedDelegation[] {
  const waiting = new Map<string, UnjudgedDelegation>();
  for (const record of records) {
    if (record.recordType === "edit" && record.orchestratorSession === orchestratorSession) {
      waiting.delete(record.delegationId);
      waiting.set(record.delegationId, { delegationId: record.delegationId, lastEdit: record.timestamp });
    } else if (record.recordType === "verdict") waiting.delete(record.delegationId);
  }
  return [...waiting.values()];
}
