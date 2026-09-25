import { writeFileSync } from "node:fs";
import { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { sessionClassifierModelCall } from "../routing/session-classifier-call.ts";
import { classifyTier, loadClassifierChain } from "../routing/tier-classifier.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Test-only pi extension for the classifier's live check (ADR 0004). At session
// start it classifies the cases named in PI_ORCHESTRATOR_CLASSIFIER_CASES
// through the running session's own model registry, the path the router uses,
// writes the records to PI_ORCHESTRATOR_CLASSIFIER_OUT and exits. No child pi.

interface ProbeCase {
  readonly name: string;
  readonly task: string;
  readonly paths: readonly string[];
}

export default function classifierProbe(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const out = process.env.PI_ORCHESTRATOR_CLASSIFIER_OUT;
    const rung = process.env.PI_ORCHESTRATOR_CLASSIFIER_RUNG;
    const cases = JSON.parse(process.env.PI_ORCHESTRATOR_CLASSIFIER_CASES ?? "[]") as ProbeCase[];
    if (!out || !rung) return;
    try {
      if (ctx.modelRegistry === undefined) throw new Error("pi supplied no model registry");
      const baseModel = rung.replace(/:[a-z]+$/, "");
      const owner = new TaskAllowanceOwner(newTaskLedger({ taskId: "classifier-live" }));
      const allowance = { owner, catalog: buildCatalog({ modelIds: [baseModel] }) };
      const chain = loadClassifierChain({ model: rung, timeoutMs: 120_000, fallback: [] });
      const callModel = sessionClassifierModelCall(ctx.modelRegistry);
      const records = [];
      for (const live of cases) {
        const record = await classifyTier({ task: live.task, role: "worker", paths: live.paths }, { chain, callModel, allowance });
        records.push({ name: live.name, record });
      }
      writeFileSync(out, JSON.stringify({ refusals: chain.refusals, records, settled: owner.snapshot().settled.map((c) => c.label) }));
    } catch (error) {
      writeFileSync(out, JSON.stringify({ error: String(error) }));
    }
    process.exit(0);
  });
}
