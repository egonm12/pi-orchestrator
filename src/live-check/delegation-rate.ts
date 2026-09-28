import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parseSkillBlock } from "@earendil-works/pi-coding-agent";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { classifyToolCall } from "../subagents/tool-call-kind.ts";
import { hasProtocol } from "./protocol-probe.ts";

// Live measurement for bean pi-orchestrator-53x3 (ADR 0013): how often the
// orchestrator delegates a prompt that needs delegation, now that the
// exploration nudge, the reminding gate and the protocol on every run are in.
// The owner works normally in pi, then runs this script over their own
// session files; see delegation-rate.md.
//
// It follows the baseline's method (ADR 0005, the Claude Code orchestrator
// plugin's 75 labelled prompts): each typed prompt is labelled by hand,
// blind to what the orchestrator did, as delegate (answering needs an
// investigation) or self (quick), and the rate is the share of delegate
// prompts in which the orchestrator started a worker.
//
// `extract` writes two files outside the repository: labels.jsonl holds the
// prompt text for the owner to label and nothing about the outcome;
// outcomes.jsonl holds counts only, no text, paths or session ids. Ids are
// hashes. `summarize` prints only counts and hashed ids, safe to paste into
// the bean.

/** A typed prompt as it was sent: plain text or a /skill: prompt. */
export type PromptKind = "plain" | "skill";

/** The owner's label: delegate (needs an investigation), self (quick), or skip (not a real prompt, such as one another extension sent). */
export type Route = "delegate" | "self" | "skip";

/** One prompt to label: its text, and no outcome. */
export interface LabelRow {
  readonly id: string;
  /** Empty until the owner labels it. */
  readonly route: Route | "";
  readonly kind: PromptKind;
  readonly text: string;
}

/** What the orchestrator did from one prompt to the next, as counts. */
export interface PromptOutcome {
  readonly id: string;
  /** A hash of the session id: prompts from one session share it. */
  readonly session: string;
  readonly at: string;
  readonly kind: PromptKind;
  /** provider/model of the first reply to the prompt. */
  readonly model?: string;
  /** Whether the latest system prompt pi recorded before the prompt held the orchestrator protocol. */
  readonly protocol: boolean;
  /** Workers started: each `subagents` item, and each pi-subagents `subagent` call. */
  readonly delegations: number;
  /** Exploratory calls (read-only or unrecognised, as the nudge counts them) in the whole span. */
  readonly exploratory: number;
  /** Exploratory calls before the first worker was started; all of them when none was. */
  readonly exploratoryBeforeDelegation: number;
  /** Tool results that carried the exploration nudge. */
  readonly nudges: number;
  /** git commit or push results that carried the gate's reminder. */
  readonly gateReminders: number;
  /** subagents-* messages after the prompt: completion notices, reports and questions, gate notices. Each is a notice,
   *  not a run: one delivered while the orchestrator was busy woke nothing, so this is not a count of wake-ups. */
  readonly subagentMessages: number;
}

/** Prompts to label and their outcomes, read from session files. */
export interface SessionPrompts {
  readonly labels: readonly LabelRow[];
  readonly outcomes: readonly PromptOutcome[];
  /** Lines that were not JSON. */
  readonly badLines: number;
}

const NUDGE = /\d+ exploratory calls? this prompt: consider handing the rest to a worker\./;
const GATE_REMINDER = /pi-orchestrator: git (?:commit|push) ran while /;

type Entry = Record<string, unknown> & { readonly type?: unknown; readonly id?: unknown; readonly timestamp?: unknown };
interface Message { readonly role?: unknown; readonly content?: unknown; readonly sections?: unknown; readonly provider?: unknown; readonly model?: unknown }

/** A short stable hash of `parts`. */
function hashId(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "")).join("");
}

/** The system prompt a session's system messages add up to, replayed the way pi replays them: every
 *  message's text is kept, and its sections patch the ones before it (a string sets a section, null
 *  removes it, an omitted section stays). A message that only declares tools changes neither. */
class SystemPrompt {
  private readonly texts: string[] = [];
  private readonly sections = new Map<string, string>();

  apply(message: Message): void {
    const text = textOf(message.content);
    if (text.length > 0) this.texts.push(text);
    const patch = message.sections;
    if (!patch || typeof patch !== "object") return;
    for (const [name, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === null) this.sections.delete(name);
      else if (typeof value === "string") this.sections.set(name, value);
    }
  }

  /** Whether the replayed prompt holds the orchestrator protocol. */
  hasProtocol(): boolean {
    const section = this.sections.get("orchestrator_protocol");
    return (section !== undefined && section.length > 0) || hasProtocol([...this.texts, ...this.sections.values()].join("\n\n"));
  }
}

interface Span {
  readonly id: string;
  readonly session: string;
  readonly at: string;
  readonly kind: PromptKind;
  readonly text: string;
  readonly protocol: boolean;
  model?: string;
  delegations: number;
  exploratory: number;
  exploratoryBeforeDelegation: number;
  nudges: number;
  gateReminders: number;
  subagentMessages: number;
}

/** A parsed session file. */
interface SessionFile {
  readonly sessionId: string;
  /** The header's time: a fork's header is written after its parent's. */
  readonly startedAt: string;
  readonly entries: readonly Entry[];
  readonly badLines: number;
}

function parseSession(text: string): SessionFile {
  const entries: Entry[] = [];
  let badLines = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try { entries.push(JSON.parse(line) as Entry); } catch { badLines++; }
  }
  const header = entries.find((entry) => entry.type === "session");
  return { sessionId: typeof header?.id === "string" ? header.id : "unknown", startedAt: typeof header?.timestamp === "string" ? header.timestamp : "", entries, badLines };
}

/** Whether any system prompt the file records holds the orchestrator protocol. */
function everHadProtocol(file: SessionFile): boolean {
  const systemPrompt = new SystemPrompt();
  for (const entry of file.entries) {
    const message = entry.message as Message | undefined;
    if (entry.type !== "message" || message?.role !== "system") continue;
    systemPrompt.apply(message);
    if (systemPrompt.hasProtocol()) return true;
  }
  return false;
}

/** The prompts of every orchestrator session among `texts` (each a session file's text), and the
 *  ids of the copies left out, one per copy. pi copies entries into a forked session with their ids and timestamps unchanged,
 *  so an entry is counted once across files by its id and timestamp: a copied prompt is the same prompt,
 *  and what the fork did after its last copied prompt counts toward that prompt. Files are read in the
 *  order they started, so a parent comes before its forks. An entry without an id is never matched. */
export function promptsOfSessions(texts: readonly string[]): SessionPrompts & { readonly orchestratorFiles: number; readonly copiedPrompts: readonly string[] } {
  const files = texts.map(parseSession).map((file, order) => ({ file, order }))
    .sort((a, b) => a.file.startedAt.localeCompare(b.file.startedAt) || a.order - b.order).map(({ file }) => file);
  const spans = new Map<string, Span>();
  const seen = new Set<string>();
  let badLines = 0;
  let orchestratorFiles = 0;
  const copiedPrompts: string[] = [];
  for (const file of files) {
    badLines += file.badLines;
    if (!everHadProtocol(file)) continue;
    orchestratorFiles++;
    const session = hashId("session", file.sessionId);
    const systemPrompt = new SystemPrompt();
    let span: Span | undefined;
    file.entries.forEach((entry, index) => {
      if (entry.type === "session") return;
      const key = typeof entry.id === "string" ? `${entry.id}\0${String(entry.timestamp ?? "")}` : `${file.sessionId}\0line ${index}`;
      const message = (entry.message ?? {}) as Message;
      // The system prompt is replayed per file, copies included: a fork's prompt state starts from its copied history.
      if (entry.type === "message" && message.role === "system") { systemPrompt.apply(message); return; }
      if (entry.type === "message" && message.role === "user") {
        const id = hashId("prompt", key);
        const earlier = spans.get(id);
        if (earlier) { span = earlier; copiedPrompts.push(id); return; }
        const raw = textOf(message.content);
        const skill = parseSkillBlock(raw);
        spans.set(id, span = { id, session, at: String(entry.timestamp ?? ""), kind: skill ? "skill" : "plain",
          text: skill ? `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}` : raw, protocol: systemPrompt.hasProtocol(),
          delegations: 0, exploratory: 0, exploratoryBeforeDelegation: 0, nudges: 0, gateReminders: 0, subagentMessages: 0 });
        seen.add(key);
        return;
      }
      if (seen.has(key)) return;
      seen.add(key);
      if (span) countInto(span, entry, message);
    });
  }
  const all = [...spans.values()];
  return {
    labels: all.map(({ id, kind, text: prompt }) => ({ id, route: "", kind, text: prompt })),
    outcomes: all.map(({ text: _text, ...outcome }) => outcome),
    badLines, orchestratorFiles, copiedPrompts,
  };
}

/** Reads one pi session file's text into prompts to label and their outcomes. */
export function promptsOfSession(text: string): SessionPrompts | undefined {
  const found = promptsOfSessions([text]);
  return found.orchestratorFiles === 0 ? undefined : found;
}

/** Adds what one entry after a prompt did to that prompt's outcome. */
function countInto(span: Span, entry: Entry, message: Message): void {
  if (entry.type === "custom_message") {
    if (typeof entry.customType === "string" && entry.customType.startsWith("subagents-")) span.subagentMessages++;
    return;
  }
  if (entry.type !== "message") return;
  if (message.role === "assistant") {
    if (span.model === undefined && typeof message.provider === "string" && typeof message.model === "string") span.model = `${message.provider}/${message.model}`;
    for (const part of Array.isArray(message.content) ? message.content : []) {
      const call = part as { type?: unknown; name?: unknown; arguments?: unknown };
      if (call?.type !== "toolCall" || typeof call.name !== "string") continue;
      const started = workersStarted(call.name, call.arguments);
      if (started > 0) { span.delegations += started; continue; }
      const kind = classifyToolCall(call.name, call.arguments);
      if (kind !== "read-only" && kind !== "unrecognised") continue;
      span.exploratory++;
      if (span.delegations === 0) span.exploratoryBeforeDelegation++;
    }
  } else if (message.role === "toolResult") {
    const result = textOf(message.content);
    if (NUDGE.test(result)) span.nudges++;
    if (GATE_REMINDER.test(result)) span.gateReminders++;
  }
}

/** Workers a call starts: each item of a `subagents` call, one per pi-subagents `subagent` call, none for any other tool. */
function workersStarted(name: string, args: unknown): number {
  if (name === "subagent") return 1;
  if (name !== "subagents") return 0;
  const items = (args as { items?: unknown } | undefined)?.items;
  return Array.isArray(items) && items.length > 0 ? items.length : 1;
}

/** The baseline ADR 0005 and ADR 0013 cite: Claude Code on advice alone, 75 labelled prompts from real sessions (23 September 2026). */
export const BASELINE = { delegated: 6, needed: 29, exploredWithoutDelegating: 15, labellerAgreement: 88 } as const;

/** The smallest number of plain delegate prompts the decision is made on: the baseline's own. */
export const MIN_NEEDED = BASELINE.needed;

/** p below this, one-sided, counts as a rate above the baseline. */
export const ALPHA = 0.05;

/** What the measurement says about ADR 0013. */
export type Decision = "improved" | "near-baseline" | "insufficient";

/** log(n!) */
function logFactorial(n: number): number {
  let sum = 0;
  for (let i = 2; i <= n; i++) sum += Math.log(i);
  return sum;
}
function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** One-sided Fisher exact p that `delegated` of `needed` is a higher rate than `baseDelegated` of `baseNeeded`. */
export function fisherGreater(delegated: number, needed: number, baseDelegated: number, baseNeeded: number): number {
  const total = needed + baseNeeded;
  const successes = delegated + baseDelegated;
  let p = 0;
  for (let k = delegated; k <= Math.min(successes, needed); k++) {
    p += Math.exp(logChoose(successes, k) + logChoose(total - successes, needed - k) - logChoose(total, needed));
  }
  return Math.min(1, p);
}

const percent = (part: number, whole: number) => (whole === 0 ? "n/a" : `${Math.round((100 * part) / whole)}%`);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The owner's summary over labelled prompts and their outcomes: counts and hashed ids only, and the decision on ADR 0013. */
export function summarize(labels: readonly LabelRow[], outcomes: readonly PromptOutcome[], secondLabels?: readonly LabelRow[]):
  { readonly lines: readonly string[]; readonly decision: Decision } {
  const unlabelled = labels.filter((label) => label.route === "");
  if (unlabelled.length > 0) throw new Error(`${plural(unlabelled.length, "prompt")} ${unlabelled.length === 1 ? "is" : "are"} not labelled yet (route is empty)`);
  const bad = labels.find((label) => !["delegate", "self", "skip"].includes(label.route));
  if (bad) throw new Error(`unknown route ${JSON.stringify(bad.route)} on ${bad.id}: use delegate, self or skip`);
  const routes = new Map(labels.map((label) => [label.id, label.route as Route]));
  const unmatched = outcomes.filter((outcome) => !routes.has(outcome.id));
  if (unmatched.length > 0) throw new Error(`no label for ${plural(unmatched.length, "outcome")}, such as ${unmatched[0]?.id}`);

  const rows = outcomes.map((outcome) => ({ ...outcome, route: routes.get(outcome.id)! }));
  const kept = rows.filter((row) => row.route !== "skip");
  const needed = kept.filter((row) => row.route === "delegate");
  const plain = needed.filter((row) => row.kind === "plain");
  const skill = needed.filter((row) => row.kind === "skill");
  const quick = kept.filter((row) => row.route === "self");
  const delegated = (list: readonly { delegations: number }[]) => list.filter((row) => row.delegations > 0).length;
  const days = kept.map((row) => row.at.slice(0, 10)).filter((day) => day.length > 0).sort();
  const models = new Map<string, number>();
  for (const row of kept) models.set(row.model ?? "(none)", (models.get(row.model ?? "(none)") ?? 0) + 1);
  const sum = (list: readonly PromptOutcome[], key: "nudges" | "gateReminders" | "subagentMessages") => list.reduce((total, row) => total + row[key], 0);
  const withSome = (key: "nudges" | "gateReminders") => kept.filter((row) => row[key] > 0).length;
  const missed = plain.filter((row) => row.delegations === 0);

  const lines = [
    "Delegation rate, ADR 0013 remeasurement (bean pi-orchestrator-53x3)",
    `sample: ${kept.length} labelled prompts in ${plural(new Set(kept.map((row) => row.session)).size, "session")} (${rows.length - kept.length} skipped), ${days[0] ?? "?"} to ${days.at(-1) ?? "?"}`,
    `models: ${[...models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([model, count]) => `${model} ${count}`).join(", ") || "(none)"}`,
    `protocol recorded before the prompt: ${kept.filter((row) => row.protocol).length} of ${kept.length}`,
    `headline (plain prompts, as the baseline): delegated ${delegated(plain)} of ${plain.length} needed (${percent(delegated(plain), plain.length)}); ` +
      `baseline ${BASELINE.delegated} of ${BASELINE.needed} (${percent(BASELINE.delegated, BASELINE.needed)})`,
  ];
  const p = fisherGreater(delegated(plain), plain.length, BASELINE.delegated, BASELINE.needed);
  if (plain.length > 0) lines.push(`one-sided Fisher exact test against the baseline: p = ${p < 0.001 ? p.toExponential(1) : p.toFixed(3)}`);
  lines.push(
    `skill prompts: delegated ${delegated(skill)} of ${skill.length} needed`,
    `all prompts: delegated ${delegated(needed)} of ${needed.length} needed`,
    `quick prompts delegated anyway: ${delegated(quick)} of ${quick.length}`,
    `needed prompts with more than 2 exploratory calls before a worker (or none): ${plain.filter((row) => row.exploratoryBeforeDelegation > 2).length} of ${plain.length}; ` +
      `baseline ${BASELINE.exploredWithoutDelegating} of ${BASELINE.needed}`,
    `exploration nudges seen: ${sum(kept, "nudges")} in ${plural(withSome("nudges"), "prompt")}; gate reminders seen: ${sum(kept, "gateReminders")} in ${plural(withSome("gateReminders"), "prompt")}`,
    `subagents messages (completion notices, reports, gate notices; notices, not wake-ups): ${sum(kept, "subagentMessages")}`,
    `not delegated although needed (plain): ${plural(missed.length, "prompt")}`,
  );
  if (missed.length > 0) lines.push(`  ids: ${missed.map((row) => row.id).join(", ")}`);
  if (secondLabels) {
    const second = new Map(secondLabels.map((label) => [label.id, label.route]));
    const both = labels.filter((label) => second.has(label.id) && second.get(label.id) !== "");
    const agreed = both.filter((label) => second.get(label.id) === label.route).length;
    lines.push(`second labeller agreement: ${agreed} of ${both.length} (${percent(agreed, both.length)}); baseline labellers ${BASELINE.labellerAgreement}%`);
  }
  const decision: Decision = plain.length < MIN_NEEDED ? "insufficient" : p < ALPHA ? "improved" : "near-baseline";
  lines.push(decision === "insufficient"
    ? `DECISION: INSUFFICIENT SAMPLE. ${plain.length} plain prompts labelled delegate, at least ${MIN_NEEDED} needed: keep sampling.`
    : decision === "improved"
      ? `DECISION: IMPROVED. ADR 0013 stands: the rate is above the baseline at p < ${ALPHA}.`
      : `DECISION: NEAR BASELINE. Revisit ADR 0013 with this evidence: the rate is not statistically shown above the baseline at p < ${ALPHA}.`);
  return { lines, decision };
}

/** Where the sample starts by default: the commit that put the protocol on every run (318435c), the last of tickets 01 to 03. */
export const DEFAULT_SINCE = "2026-09-29T00:08:31+02:00";

/** This repository's root: labels hold prompt text and must never land in it. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

export interface ExtractOptions {
  /** pi's session folder: one folder per project, each with the main sessions' .jsonl files. */
  readonly sessionsDir: string;
  readonly outDir: string;
  /** Prompts before this are left out. */
  readonly since?: Date;
  /** Prompts at or after this are left out. */
  readonly until?: Date;
  readonly repoRoot?: string;
  /** Labels from an earlier extract: a prompt keeps its route by id, so a wider window is not labelled twice. */
  readonly labelsFrom?: readonly LabelRow[];
}

/** Writes labels.jsonl (sorted by id, so not in time order) and outcomes.jsonl into `outDir`. Only the
 *  top level of each project folder is read: workers' sessions live in its subagents/ folder. All files are
 *  read together, so a forked session's copies of its parent's prompts count once. */
export function runExtract(options: ExtractOptions): {
  readonly sessions: number; readonly orchestratorSessions: number; readonly prompts: number; readonly unlabelled: number; readonly badLines: number;
  /** Copies of the window's prompts in forked sessions, left out. */
  readonly copiedPrompts: number;
} {
  const outDir = resolve(options.outDir);
  const inRepo = relative(resolve(options.repoRoot ?? REPO_ROOT), outDir);
  if (!inRepo.startsWith("..") && !isAbsolute(inRepo)) throw new Error(`${outDir} is inside the repository: labels hold prompt text, write them elsewhere`);
  if (existsSync(join(outDir, "labels.jsonl"))) throw new Error(`${outDir} already holds labels.jsonl: pick a new folder, so labels are never overwritten`);
  const earlier = new Map((options.labelsFrom ?? []).filter((label) => label.route !== "").map((label) => [label.id, label.route]));
  const inWindow = (at: string) => {
    const time = Date.parse(at);
    return !Number.isNaN(time) && (!options.since || time >= options.since.getTime()) && (!options.until || time < options.until.getTime());
  };
  const texts: string[] = [];
  for (const project of readdirSync(options.sessionsDir, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    for (const file of readdirSync(join(options.sessionsDir, project.name), { withFileTypes: true })) {
      if (file.isFile() && file.name.endsWith(".jsonl")) texts.push(readFileSync(join(options.sessionsDir, project.name, file.name), "utf8"));
    }
  }
  const found = promptsOfSessions(texts);
  const kept = new Set(found.outcomes.filter((outcome) => inWindow(outcome.at)).map((outcome) => outcome.id));
  const labels = found.labels.filter((label) => kept.has(label.id)).map((label) => ({ ...label, route: earlier.get(label.id) ?? label.route }));
  const outcomes = found.outcomes.filter((outcome) => kept.has(outcome.id));
  mkdirSync(outDir, { recursive: true });
  const jsonl = (rows: readonly unknown[]) => rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  writeFileSync(join(outDir, "labels.jsonl"), jsonl([...labels].sort((a, b) => a.id.localeCompare(b.id))), { mode: 0o600 });
  writeFileSync(join(outDir, "outcomes.jsonl"), jsonl([...outcomes].sort((a, b) => a.at.localeCompare(b.at))), { mode: 0o600 });
  return { sessions: texts.length, orchestratorSessions: new Set(outcomes.map((outcome) => outcome.session)).size, prompts: outcomes.length,
    unlabelled: labels.filter((label) => label.route === "").length, badLines: found.badLines, copiedPrompts: found.copiedPrompts.filter((id) => kept.has(id)).length };
}

/** The rows of a JSONL file. */
export function readRows<T>(file: string): T[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as T);
}

const USAGE = `usage:
  node src/live-check/delegation-rate.ts extract [--since ISO] [--until ISO] [--sessions DIR] [--out DIR] [--labels-from FILE]
  node src/live-check/delegation-rate.ts summarize DIR [--second-labels FILE]
`;

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg.startsWith("--")) {
      const value = rest[i + 1];
      if (value === undefined) { process.stderr.write(`${arg} needs a value\n${USAGE}`); return 2; }
      flags.set(arg, value);
      i++;
    } else positional.push(arg);
  }
  const date = (flag: string, fallback?: string): Date | undefined => {
    const value = flags.get(flag) ?? fallback;
    if (value === undefined) return undefined;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error(`${flag} ${value} is not a date`);
    return parsed;
  };
  const home = (path: string) => (path === "~" || path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);
  try {
    if (command === "extract") {
      const state = process.env.PI_ORCHESTRATOR_STATE_DIR ?? join(personalAgentDir(), "pi-orchestrator");
      const outDir = resolve(home(flags.get("--out") ?? join(state, "live-check", `delegation-rate-${new Date().toISOString().replace(/[:.]/g, "-")}`)));
      const since = date("--since", DEFAULT_SINCE);
      const until = date("--until");
      const labelsFrom = flags.get("--labels-from");
      const result = runExtract({ sessionsDir: resolve(home(flags.get("--sessions") ?? join(personalAgentDir(), "sessions"))), outDir, since, until,
        ...(labelsFrom === undefined ? {} : { labelsFrom: readRows<LabelRow>(resolve(home(labelsFrom))) }) });
      process.stdout.write([
        `read ${result.sessions} session files; ${result.orchestratorSessions} orchestrator sessions with prompts since ${since?.toISOString()}${until ? ` before ${until.toISOString()}` : ""}`,
        `${result.prompts} prompts, ${result.unlabelled} still to label${result.copiedPrompts > 0 ? `; ${result.copiedPrompts} copies in forked sessions left out` : ""}` +
          `${result.badLines > 0 ? ` (${result.badLines} unreadable lines skipped)` : ""}`,
        `labels:   ${join(outDir, "labels.jsonl")}  (prompt text: private, never commit it)`,
        `outcomes: ${join(outDir, "outcomes.jsonl")}  (counts only: do not open it before labelling)`,
      ].join("\n") + "\n");
      return 0;
    }
    const [folder] = positional;
    if (command === "summarize" && folder !== undefined && positional.length === 1) {
      const dir = resolve(home(folder));
      const second = flags.get("--second-labels");
      const { lines } = summarize(readRows<LabelRow>(join(dir, "labels.jsonl")), readRows<PromptOutcome>(join(dir, "outcomes.jsonl")),
        second === undefined ? undefined : readRows<LabelRow>(resolve(home(second))));
      process.stdout.write(`${lines.join("\n")}\n`);
      return 0;
    }
  } catch (error) {
    process.stderr.write(`delegation-rate: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  process.stderr.write(USAGE);
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) process.exit(main(process.argv.slice(2)));
