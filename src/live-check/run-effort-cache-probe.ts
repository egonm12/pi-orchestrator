import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  PROBE_MODELS,
  assistantMessageOf,
  cacheKept,
  cacheSensitivity,
  probePlan,
  runError,
  toolResultChange,
  usageOf,
  type ProbeModel,
  type ProbeStep,
  type StepUsage,
} from "../models/effort-cache-probe.ts";
import { PROBE_RAW_ENV, PROBE_STEP_ENV } from "./effort-cache-probe.ts";
import { scrubText } from "./quota-capture.ts";

// Live runner for bean pi-orchestrator-zv3l. For one model it sends the probe
// plan (src/models/effort-cache-probe.ts) step by step through pi, so the
// requests use pi's own credentials, transport and OAuth shaping. Each step is
// one `pi --mode json` process, with the probe extension swapping its payload.
// Each process runs with pi's normal settings, so the orchestrator guard and the
// installed Anthropic subscription package load as they do in a session. The
// runner never passes `-ne` or another agent directory: the guard refuses both.
// It stops at the first error reply or non-zero exit, and never prints a secret:
// only usage numbers, stop reasons and scrubbed error text.
//
// Usage (spends model quota, so `--confirm` is required):
//   node src/live-check/run-effort-cache-probe.ts <haiku|sonnet|opus|astra|sol> --confirm [--only=R1,C2]
// `--only` runs a subset of the steps (a diagnostic) and prints no verdicts.

const STEP_TIMEOUT_MS = 240_000;
const EXTENSION = resolve(import.meta.dirname, "effort-cache-probe.ts");

export function piArgs(model: ProbeModel, step: ProbeStep): string[] {
  return ["--mode", "json", "-p", "--no-session", "-e", EXTENSION,
    "--model", `${model.provider}/${model.id}`, "--thinking", step.topEffort, `effort cache probe ${step.id}`];
}

function runPi(args: readonly string[], stepFile: string, rawFile: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((done, fail) => {
    const env = { ...process.env, [PROBE_STEP_ENV]: stepFile, [PROBE_RAW_ENV]: rawFile };
    const child = spawn("pi", [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), STEP_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => { clearTimeout(timer); fail(error); });
    child.on("close", (code) => { clearTimeout(timer); done({ stdout, stderr, code }); });
  });
}

interface CallRecord {
  readonly model: string;
  readonly step: string;
  readonly purpose: string;
  readonly topEffort: string;
  readonly usage: StepUsage;
  readonly durationMs: number;
  readonly error?: string;
}

function describe(record: CallRecord): string {
  const u = record.usage;
  const reasoning = u.reasoning === undefined ? "n/a" : String(u.reasoning);
  const outcome = record.error === undefined ? `stop ${u.stopReason}` : `ERROR ${record.error}`;
  return `${record.step} ${record.model} top ${record.topEffort}: input ${u.input}, cacheRead ${u.cacheRead}, cacheWrite ${u.cacheWrite}, ` +
    `output ${u.output}, reasoning ${reasoning}, thinking chars ${u.thinkingChars} (${outcome}, ${record.durationMs} ms)`;
}

async function main(argv: readonly string[]): Promise<number> {
  const [key, ...flags] = argv;
  if (!key || !Object.hasOwn(PROBE_MODELS, key)) {
    process.stderr.write(`usage: run-effort-cache-probe.ts <${Object.keys(PROBE_MODELS).join("|")}> --confirm [--only=R1,C2]\n`);
    return 2;
  }
  if (!flags.includes("--confirm")) {
    process.stderr.write("this sends live requests that spend model quota: pass --confirm\n");
    return 2;
  }
  const model: ProbeModel = PROBE_MODELS[key as keyof typeof PROBE_MODELS];
  const only = flags.find((flag) => flag.startsWith("--only="))?.slice("--only=".length).split(",");
  const plan = probePlan(model).filter((step) => only === undefined || only.includes(step.id));
  const workDir = mkdtempSync(join(tmpdir(), `effort-cache-probe-${key}-`));
  const callLog = join(workDir, "calls.jsonl");
  const rawFile = join(workDir, "raw-usage.jsonl");
  process.stdout.write(`probe ${model.id} (${model.provider}, ${model.path}): ${plan.length} requests, log ${callLog}, raw usage ${rawFile}\n`);

  const records = new Map<string, CallRecord>();
  for (const step of plan) {
    const stepFile = join(workDir, `${step.id}.json`);
    writeFileSync(stepFile, JSON.stringify({ id: step.id, overrides: step.overrides }));
    const started = Date.now();
    const { stdout, stderr, code } = await runPi(piArgs(model, step), stepFile, rawFile);
    const message = assistantMessageOf(stdout);
    const error = runError(message, code, stderr);
    const record: CallRecord = {
      model: model.id,
      step: step.id,
      purpose: step.purpose,
      topEffort: step.topEffort,
      usage: usageOf(message),
      durationMs: Date.now() - started,
      ...(error === undefined ? {} : { error: scrubText(error) }),
    };
    appendFileSync(callLog, `${JSON.stringify(record)}\n`);
    records.set(step.id, record);
    process.stdout.write(`${describe(record)}\n`);
    if (error !== undefined) {
      process.stdout.write(`STOPPED at ${step.id}: the run ends here, nothing after it was sent. Log: ${callLog}\n`);
      return 1;
    }
  }

  if (only !== undefined) return 0;
  const usage = (id: string): StepUsage => records.get(id)?.usage ?? usageOf(undefined);
  const cache = cacheKept({ control: usage("C2"), changed: usage("R2"), written: usage("R1") });
  const sensitivity = cacheSensitivity({ control: usage("C2"), negative: usage("NC") });
  const tool = toolResultChange({ control: usage("TA"), changed: usage("TB"), reference: usage("TH") });
  process.stdout.write(`cache kept (R2 vs C2): ${cache.verdict}. ${cache.reason}\n`);
  process.stdout.write(`cache test sensitivity (NC vs C2): ${sensitivity.verdict}. ${sensitivity.reason}\n`);
  process.stdout.write(`tool_result change applied: ${tool.verdict}. ${tool.reason}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error: unknown) => {
    process.stderr.write(`${scrubText(error instanceof Error ? error.message : String(error))}\n`);
    process.exit(1);
  });
}
