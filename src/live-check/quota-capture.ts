import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type {
  AfterProviderResponseEvent,
  BeforeProviderRequestEvent,
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { personalAgentDir } from "../policy/ban-lists.ts";

// Live check for ticket pi-orchestrator-ugoi: a pi extension that records what
// the providers send back, so header reading (ticket 13) is built on real data.
// Load it with `pi -e src/live-check/quota-capture.ts`; see quota-capture.md.
// It is not part of the package's extensions and never changes a request.
//
// Every provider request, response and result becomes one JSONL record:
// - `request` from `before_provider_request`: the session model and the
//   payload's model, never the payload itself.
// - `response` from `after_provider_response`: the HTTP status and every
//   response header, attributed to the request in flight in the same session.
// - `result` from each assistant `message_end`: the stop reason, the error text
//   of a failed request and how many response events that request got.

export const CAPTURE_VERSION = 1;
export const REDACTED = "[redacted]";

// Header names whose values are credentials or cookies. Quota headers such as
// `anthropic-ratelimit-tokens-remaining` must survive, so `tokens` alone is
// not a match.
const SECRET_HEADER = /(^|-)(cookie|set-cookie|authorization|api-key|secret|password|access-token|refresh-token|id-token|session-token|auth-token)($|-)/i;
const SECRET_TEXT: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];

/** Token-like substrings (bearer tokens, `sk-` keys, JWTs) replaced. */
export function scrubText(text: string): string {
  return SECRET_TEXT.reduce((current, pattern) => current.replace(pattern, REDACTED), text);
}

/** Every header kept by name; credential and cookie values redacted. */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of Object.keys(headers).sort()) {
    const value = headers[name] ?? "";
    result[name] = SECRET_HEADER.test(name) ? REDACTED : scrubText(value);
  }
  return result;
}

const DEFAULT_FILE_KEY = Symbol.for("pi-orchestrator.quota-capture.default-file");

/** The capture file: `PI_QUOTA_CAPTURE_FILE`, or one file per pi process in
 *  the state folder's `live-check/`. */
export function captureFile(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
  const configured = env.PI_QUOTA_CAPTURE_FILE;
  if (configured) return resolve(configured === "~" || configured.startsWith("~/") ? `${homedir()}${configured.slice(1)}` : configured);
  // pi loads each extension with a fresh module copy, so a reload or an
  // in-process worker would otherwise pick a second file.
  const shared = globalThis as unknown as Record<symbol, string | undefined>;
  const existing = shared[DEFAULT_FILE_KEY];
  if (existing) return existing;
  const state = env.PI_ORCHESTRATOR_STATE_DIR ?? join(personalAgentDir(env), "pi-orchestrator");
  const file = resolve(state, "live-check", `quota-capture-${now.toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`);
  shared[DEFAULT_FILE_KEY] = file;
  return file;
}

/** The case label on every record: `PI_QUOTA_CAPTURE_CASE`, or the file's name. */
export function captureCase(file: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_QUOTA_CAPTURE_CASE || basename(file, extname(file));
}

function transportSetting(path: string): string | null {
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as { transport?: unknown };
    return typeof settings.transport === "string" ? settings.transport : null;
  } catch { return null; }
}

interface InFlight {
  readonly seq: number;
  readonly provider: string | null;
  readonly model: string | null;
  readonly payloadModel: string | null;
  responses: number;
}

interface SessionRequests { nextSeq: number; open: InFlight[] }

function sessionId(ctx: ExtensionContext): string {
  try { return ctx.sessionManager.getSessionId(); } catch { return "unknown"; }
}

function sessionModel(ctx: ExtensionContext): { provider: string | null; model: string | null; oauth: boolean | null } {
  const model = ctx.model;
  if (!model) return { provider: null, model: null, oauth: null };
  let oauth: boolean | null = null;
  try { oauth = ctx.modelRegistry.isUsingOAuth(model); } catch { oauth = null; }
  return { provider: model.provider, model: model.id, oauth };
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function diagnostics(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  // A stack says nothing about the provider; strings are scrubbed like error text.
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === "stack" ? undefined : typeof item === "string" ? scrubText(item) : item)) as unknown[];
}

export interface QuotaCaptureOptions {
  readonly file: string;
  readonly caseLabel: string;
  readonly now?: () => Date;
  readonly agentDir?: string;
}

/** Registers the capture handlers on `pi`, writing to `options.file`. */
export function installQuotaCapture(pi: ExtensionAPI, options: QuotaCaptureOptions): void {
  const now = options.now ?? (() => new Date());
  const sessions = new Map<string, SessionRequests>();
  let writeFailed = false;
  let announced = false;

  const write = (record: Record<string, unknown>): void => {
    try {
      mkdirSync(dirname(options.file), { recursive: true });
      appendFileSync(options.file, `${JSON.stringify({ v: CAPTURE_VERSION, kind: record.kind, at: now().toISOString(), case: options.caseLabel, ...record })}\n`);
    } catch (error) {
      if (writeFailed) return;
      writeFailed = true;
      process.stderr.write(`quota capture: cannot write ${options.file}: ${String(error).split(/\r?\n/, 1)[0]}\n`);
    }
  };
  const requestsOf = (id: string): SessionRequests => {
    let requests = sessions.get(id);
    if (!requests) { requests = { nextSeq: 1, open: [] }; sessions.set(id, requests); }
    return requests;
  };
  // A handler failure must never break the session being measured.
  const guarded = <E>(handler: (event: E, ctx: ExtensionContext) => void) => (event: E, ctx: ExtensionContext): undefined => {
    try { handler(event, ctx); } catch (error) {
      process.stderr.write(`quota capture: ${String(error).split(/\r?\n/, 1)[0]}\n`);
    }
    return undefined;
  };

  pi.on("session_start", guarded<SessionStartEvent>((event, ctx) => {
    const agentDir = options.agentDir ?? personalAgentDir();
    write({ kind: "session", sessionId: sessionId(ctx), reason: event.reason, ...sessionModel(ctx), pid: process.pid,
      personalTransport: transportSetting(join(agentDir, "settings.json")),
      projectTransport: transportSetting(join(ctx.cwd, ".pi", "settings.json")) });
    if (announced) return;
    announced = true;
    const notice = `quota capture: writing to ${options.file}`;
    if (ctx.hasUI) ctx.ui.notify(notice, "info");
    else process.stderr.write(`${notice}\n`);
  }));

  pi.on("before_provider_request", guarded<BeforeProviderRequestEvent>((event, ctx) => {
    const id = sessionId(ctx);
    const requests = requestsOf(id);
    const { provider, model, oauth } = sessionModel(ctx);
    const payload = event.payload as { model?: unknown } | null | undefined;
    const request: InFlight = { seq: requests.nextSeq++, provider, model,
      payloadModel: payload && typeof payload === "object" ? text(payload.model) : null, responses: 0 };
    requests.open.push(request);
    write({ kind: "request", sessionId: id, seq: request.seq, provider, model, oauth, payloadModel: request.payloadModel,
      openRequests: requests.open.length });
  }));

  pi.on("after_provider_response", guarded<AfterProviderResponseEvent>((event, ctx) => {
    const id = sessionId(ctx);
    const requests = requestsOf(id);
    const request = requests.open.at(-1);
    const current = sessionModel(ctx);
    if (request) request.responses += 1;
    write({ kind: "response", sessionId: id, seq: request?.seq ?? null, attempt: request?.responses ?? null,
      provider: request?.provider ?? current.provider, model: request?.model ?? current.model,
      payloadModel: request?.payloadModel ?? null, openRequests: requests.open.length,
      status: event.status, headers: redactHeaders(event.headers ?? {}) });
  }));

  pi.on("message_end", guarded<MessageEndEvent>((event, ctx) => {
    const message = event.message as unknown as Record<string, unknown>;
    if (message.role !== "assistant") return;
    const id = sessionId(ctx);
    const requests = requestsOf(id);
    const request = requests.open.pop();
    const current = sessionModel(ctx);
    const errorMessage = text(message.errorMessage);
    const found = diagnostics(message.diagnostics);
    write({ kind: "result", sessionId: id, seq: request?.seq ?? null,
      provider: request?.provider ?? current.provider, model: request?.model ?? current.model,
      payloadModel: request?.payloadModel ?? null,
      messageProvider: text(message.provider), messageModel: text(message.model), responseModel: text(message.responseModel),
      stopReason: text(message.stopReason), responses: request?.responses ?? null,
      ...(errorMessage === null ? {} : { errorMessage: scrubText(errorMessage) }),
      ...(found === undefined ? {} : { diagnostics: found }) });
  }));
}

/** pi entry point for `pi -e src/live-check/quota-capture.ts`. */
export default function quotaCapture(pi: ExtensionAPI): void {
  const file = captureFile();
  installQuotaCapture(pi, { file, caseLabel: captureCase(file) });
}
