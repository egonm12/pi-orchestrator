import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildCatalog, loadCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState, loadRefreshState } from "../catalog/refresh-lifecycle.ts";
import { banListsFromSettings, readSettingsFile, subagentBanListEntry } from "../policy/ban-lists.ts";
import { loadAuthorizationOrEmpty } from "../recipients/authorization.ts";
import { NO_BUDGET_CONSTRAINT } from "../recipients/authorized-delegation.ts";
import { allowanceConstraint, newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { readRoutingRecords } from "../routing/decision-record.ts";
import { failedHardFilter } from "../routing/tier-router.ts";
import { deriveProviderUsage } from "../router/evidence.ts";
import { stateDir } from "../router/extension.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS, type ThinkingLevel } from "../models/model-info.ts";
import { isRunningWorkerSession } from "./worker-sessions.ts";
import { loadSubagentsSettings } from "./settings.ts";
import { workerSessionDir, type WorkerSetup, type WorkerStatus } from "./worker.ts";

export interface ResumeWorker {
  readonly file: string;
  readonly release: () => void;
  readonly pin: { readonly model: string; readonly effort: ThinkingLevel };
  readonly namedModel?: WorkerSetup["namedModel"];
  /** The delegation is a forked worker's, so its pin is the session model it forked on (ADR 0008). */
  readonly fork?: boolean;
  readonly instructions?: string;
  readonly tools?: readonly string[];
}

const RESUMING = Symbol.for("pi-orchestrator.subagents.resuming");
type ProcessGlobal = typeof globalThis & { [RESUMING]?: Set<string> };
const resuming = (): Set<string> => (globalThis as ProcessGlobal)[RESUMING] ??= new Set();

/** Saved outcomes distinguish failed or aborted workers from unfinished ones across /resume. */
export function saveWorkerOutcome(file: string | undefined, status: WorkerStatus, setup?: Pick<WorkerSetup, "instructions" | "tools">): void {
  if (!file || !existsSync(file)) return;
  const previous = existsSync(`${file}.outcome.json`) ? JSON.parse(readFileSync(`${file}.outcome.json`, "utf8")) as Record<string, unknown> : {};
  writeFileSync(`${file}.outcome.json`, JSON.stringify({ ...previous, status,
    ...(setup?.instructions === undefined ? {} : { instructions: setup.instructions }),
    ...(setup?.tools === undefined ? {} : { tools: setup.tools }) }));
}

function lastStatus(file: string): WorkerStatus | undefined {
  const outcome = `${file}.outcome.json`;
  if (existsSync(outcome)) {
    try {
      const status = (JSON.parse(readFileSync(outcome, "utf8")) as { status?: string }).status;
      if (status === "completed" || status === "failed" || status === "aborted") return status;
    } catch { /* A corrupt outcome cannot authorize a resume. */ }
    return undefined;
  }
  // Sessions saved before outcomes were introduced can be resumed when their last assistant turn finished.
  const entries = SessionManager.open(file).getEntries();
  const last = entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant").at(-1);
  if (last?.type !== "message" || last.message.role !== "assistant") return undefined;
  return last.message.stopReason === "aborted" ? "aborted" : last.message.stopReason === "error" ? "failed" :
    last.message.stopReason === "stop" ? "completed" : undefined;
}

/** The record is the authority for the real pin, not the hypothetical shadow rung. */
function savedPin(id: string): { model: string; effort: ThinkingLevel; namedModel?: WorkerSetup["namedModel"]; fork?: boolean } | undefined {
  const records = readRoutingRecords(join(stateDir(), "routing"));
  const record = records.filter((entry) => entry.delegationId === id &&
    (entry.recordType === "decision" || entry.recordType === "agent-model" || (entry as { recordType: string }).recordType === "fork")).at(-1);
  if (!record) return undefined;
  if (record.recordType === "agent-model") {
    return { model: record.model, effort: record.effort as ThinkingLevel, namedModel: {
      model: record.model, effort: record.effort as ThinkingLevel, agent: record.agent, definitionFile: record.definitionFile,
      ...(record.banListException ? { banListException: true } : {}),
    } };
  }
  if (record.recordType === "decision") {
    const ranOn = record.ranOn ?? (record.mode === "live" && record.route.outcome === "chosen" ? record.route.rung.rung : undefined);
    if (!ranOn) return undefined;
    const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(ranOn);
    return thinkingSuffix ? { model: baseModel, effort: thinkingSuffix.slice(1) as ThinkingLevel } : undefined;
  }
  // ADR 0008's fork record is introduced on the parallel forked-worker branch.
  const fork = record as unknown as { model?: string; effort?: string };
  return fork.model && fork.effort ? { model: fork.model, effort: fork.effort as ThinkingLevel, fork: true } : undefined;
}

export function prepareResume(id: string, task: string, setup: Pick<WorkerSetup, "cwd" | "agentDir" | "orchestratorSession">): ResumeWorker {
  const refuse = (why: string): never => { throw new Error(`cannot resume worker ${id}: ${why}`); };
  if (!/^[0-9a-f-]{36}$/i.test(id)) refuse("unknown delegation id");
  if (isRunningWorkerSession(id) || resuming().has(id)) refuse("worker is still running");
  const dir = workerSessionDir(setup.orchestratorSession);
  const file = SessionManager.findById(setup.cwd, id, dir);
  if (!file) return refuse("unknown delegation id under this orchestrator session");
  if (!lastStatus(file)) refuse("worker is not finished or was not started");
  const pin = savedPin(id);
  if (!pin || !THINKING_LEVELS.includes(pin.effort)) return refuse("no recoverable pin");
  const personal = readSettingsFile(join(setup.agentDir, "settings.json")) ?? {};
  const banLists = banListsFromSettings(personal).banLists;
  const banned = subagentBanListEntry(pin.model, banLists);
  let banListException = false;
  if (pin.namedModel && banned) {
    const { settings, allowProjectOverrides } = loadSubagentsSettings(setup.agentDir, setup.cwd);
    banListException = settings.agentDefinitionModel.use === "preserve" && settings.agentDefinitionModel.allowBanned &&
      (dirname(pin.namedModel.definitionFile) === join(setup.agentDir, "agents") || allowProjectOverrides);
  }
  if (banned && !banListException) refuse(`pin ${pin.model} is on the subagent ban list (entry '${banned}')`);
  const folder = stateDir();
  const catalogFile = join(folder, "model-catalog.json");
  const evidence = {
    catalog: existsSync(catalogFile) ? loadCatalog(catalogFile) : buildCatalog({ modelIds: [pin.model] }),
    refreshState: existsSync(join(folder, "refresh-state.json")) ? loadRefreshState(join(folder, "refresh-state.json")) : emptyRefreshState(),
    authorization: loadAuthorizationOrEmpty(join(folder, "authorized-recipients.json")),
  };
  const failure = failedHardFilter({ model: pin.model }, {
    catalog: evidence.catalog, authorization: evidence.authorization, providerUsage: deriveProviderUsage(evidence, new Date()),
    estimatedPromptTokens: Buffer.byteLength(task, "utf8"),
    allowance: banListException ? NO_BUDGET_CONSTRAINT : allowanceConstraint(
      new TaskAllowanceOwner(newTaskLedger({ taskId: `resume:${id}` })), evidence.catalog,
      { role: "subtask", maxInputTokens: Buffer.byteLength(task, "utf8") },
    ),
    banLists: { ...banLists, ...(banListException ? { subagentBanList: [] } : {}) },
  });
  if (failure) refuse(`pin ${pin.model} fails ${failure.reason}: ${failure.detail}`);
  const outcome = existsSync(`${file}.outcome.json`) ? JSON.parse(readFileSync(`${file}.outcome.json`, "utf8")) as { instructions?: unknown; tools?: unknown } : {};
  resuming().add(id);
  return { file, release: () => { resuming().delete(id); }, pin: { model: pin.model, effort: pin.effort },
    ...(typeof outcome.instructions === "string" ? { instructions: outcome.instructions } : {}),
    ...(Array.isArray(outcome.tools) && outcome.tools.every((tool) => typeof tool === "string") ? { tools: outcome.tools as string[] } : {}),
    ...(pin.namedModel ? { namedModel: { ...pin.namedModel, banListException } } : {}), ...(pin.fork ? { fork: true } : {}) };
}
