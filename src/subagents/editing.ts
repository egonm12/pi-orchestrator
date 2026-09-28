import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { appendRoutingRecord, buildEditRecord, type EditRecord, type RoutingRecord, type Verdict, type VerdictRecord } from "../routing/decision-record.ts";
import { classifyToolCall } from "./tool-call-kind.ts";
import { snapshotWorkingTree, workingTreeChanges } from "./working-tree.ts";

// Editing delegations (ADR 0010). A delegation edited when its worker, or a
// worker it started, changed files; the orchestrator must then record a
// verdict on it (./verdict.ts). In a git repository that is when the working
// tree changed while the worker ran (./working-tree.ts), or when it ran edit
// or write, which count wherever they write (pi-orchestrator-6c1p). Commands
// alone do not count there: bash that changed nothing is research. The tree
// is compared per worker, so a change made while workers overlapped counts
// for each of them. Where there is no repository to compare, the command rule
// decides: any editing tool call (isEditingToolCall) counts.
//
// The fact is kept as edit records in the routing record folder, keyed by the
// delegation id and naming the orchestrator session, so it outlives the
// worker and a pi reload. A run writes one at its first counted tool call,
// so a running worker's edit waits for a verdict at once, and one naming the
// changed paths as it ends with a changed tree, for its reviewer's file list.
// A resumed delegation writes more when it edits again, and a verdict
// recorded before that edit no longer covers it.
//
// A worker's own worker writes the record under the delegation that started
// it, with its own id beside it. Workers run in the orchestrator's process
// and each extension gets a fresh module copy, so the running delegations are
// kept on the process's global object, as worker-sessions.ts keeps its marks.

/** Tools that run whatever code they are given. The exploration nudge counts
 *  them as exploratory (ADR 0013); in a worker they may edit (owner decision
 *  2026-09-28). */
const ARBITRARY_CODE_TOOLS = new Set(["ctx_execute", "ctx_execute_file"]);

/** Whether a tool call edits: `edit` or `write`, bash (or powershell) that is
 *  neither read-only nor a build or test run, and the arbitrary-code tools. */
export function isEditingToolCall(toolName: string, input: unknown): boolean {
  if (ARBITRARY_CODE_TOOLS.has(toolName)) return true;
  const kind = classifyToolCall(toolName, input);
  return kind === "edit" || kind === "version-control" || kind === "unrecognised";
}

/** Why a reviewer's editing call is denied (ADR 0010, owner decision 2026-09-28). */
export const REVIEWER_EDIT_DENIED = "pi-orchestrator: a reviewer changes nothing, and this call would edit. " +
  "Name the shortfall in your Result instead; reading, searching, building and testing stay allowed.";

/** The extension that denies every editing call in a reviewer's session, and
 *  in a worker a reviewer started, so a reviewer never becomes an editing
 *  delegation. A denied call runs nothing, so it writes no edit record. */
export const READ_ONLY_REVIEWER: InlineExtension = {
  name: "pi-orchestrator-read-only-reviewer",
  factory: (pi) => { pi.on("tool_call", (event) => isEditingToolCall(event.toolName, event.input) ? { block: true, reason: REVIEWER_EDIT_DENIED } : undefined); },
};

/** The tool name a working-tree edit record carries. */
export const WORKING_TREE_TOOL = "working-tree";

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
  /** Ends the run's tracking once the worker has ended: compares the working
   *  tree, records a change, and says whether the worker, or a worker it
   *  started, edited in this run. A second call gives the same answer. */
  finish(): boolean;
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
  /** The worker's working directory, whose repository's tree is compared. */
  readonly cwd: string;
  /** A reviewer, or a worker it started: it never edits, so the tree, which
   *  the reviewed work may still change, is not compared. */
  readonly readOnly?: boolean;
}

/** Tracks one run of a worker from before its session starts until `finish`. */
export function trackEdits(setup: EditTrackingSetup): EditTracking {
  const { sessionId, parentDelegationId } = setup;
  // The parent runs for as long as its worker does, so it is found; the
  // fallback keeps a worker running if it is not.
  const run: DelegationRun = (parentDelegationId === undefined ? undefined : runs().get(parentDelegationId)) ??
    { delegationId: parentDelegationId ?? sessionId, orchestratorSession: setup.orchestratorSession, edited: false };
  runs().set(sessionId, run);
  const before = setup.readOnly ? undefined : snapshotWorkingTree(setup.cwd);
  let editedHere = false;
  let recorded = false;
  // The tool of the latest call the command rule counts, for when the tree cannot be compared as the worker ends.
  let commandRuleTool: string | undefined;
  const markEdited = () => { editedHere = true; run.edited = true; };
  const record = (tool: string, paths?: readonly string[]): boolean => {
    try {
      appendRoutingRecord(setup.recordDir, buildEditRecord({
        delegationId: run.delegationId, orchestratorSession: run.orchestratorSession, tool,
        ...(run.delegationId === sessionId ? {} : { nestedDelegationId: sessionId }),
        ...(paths === undefined ? {} : { paths }),
      }));
      return true;
    } catch (error) {
      process.stderr.write(`pi-orchestrator subagents: could not record delegation ${run.delegationId}'s edit: ${error instanceof Error ? error.message : String(error)}\n`);
      return false;
    }
  };
  const extension: InlineExtension = {
    name: "pi-orchestrator-edit-tracking",
    factory: (pi) => { pi.on("tool_result", (event) => {
      // tool_result follows only a call that ran: one a hook blocked edited nothing.
      if (!isEditingToolCall(event.toolName, event.input)) return;
      commandRuleTool = event.toolName;
      // In a repository only edit and write count as calls; the tree comparison catches the rest.
      if (before !== undefined && classifyToolCall(event.toolName, event.input) !== "edit") return;
      markEdited();
      // The next editing call tries again.
      if (!recorded) recorded = record(event.toolName);
    }); },
  };
  let finished: boolean | undefined;
  return {
    extension,
    finish: () => {
      if (finished !== undefined) return finished;
      if (runs().get(sessionId) === run) runs().delete(sessionId);
      if (before !== undefined) {
        const after = snapshotWorkingTree(setup.cwd);
        if (after === undefined) {
          if (commandRuleTool !== undefined) {
            markEdited();
            if (!recorded) recorded = record(commandRuleTool);
          }
        } else {
          const changes = workingTreeChanges(before, after, setup.cwd);
          if (changes.paths.length > 0 || changes.moved) {
            markEdited();
            record(WORKING_TREE_TOOL, changes.paths);
          }
        }
      }
      finished = run.delegationId === sessionId ? run.edited : editedHere;
      return finished;
    },
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
