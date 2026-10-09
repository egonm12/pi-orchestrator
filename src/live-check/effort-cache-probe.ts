import { appendFileSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mergePayload, rawUsageOf } from "../models/effort-cache-probe.ts";

// Live check for bean pi-orchestrator-zv3l: a pi extension that replaces the
// payload of one provider request with a scripted probe step. It is loaded with
// `pi -e src/live-check/effort-cache-probe.ts` by the runner
// (run-effort-cache-probe.ts), which points PI_EFFORT_CACHE_PROBE_STEP at the
// step's JSON file. Without that variable it changes nothing.
//
// pi still does everything else: credentials and refresh, the OAuth shaping of
// the Anthropic subscription route, the transport and the usage it reports.
// Only the messages, the effort fields, the tools and the betas are replaced,
// through mergePayload, so pi's own stream and store flags survive.
//
// With PI_EFFORT_CACHE_PROBE_RAW set to a file, every usage object the provider
// streams (Anthropic's message_start and message_delta, OpenAI's
// response.completed) is appended to it as a line with the step id. Only counts
// are written, never prompts or replies. The raw counts show whether a provider
// reported a cache that pi's usage mapping then dropped.

export const PROBE_STEP_ENV = "PI_EFFORT_CACHE_PROBE_STEP";
export const PROBE_RAW_ENV = "PI_EFFORT_CACHE_PROBE_RAW";

export default function effortCacheProbe(pi: ExtensionAPI): void {
  let step = "";
  pi.on("before_provider_request", (event) => {
    const file = process.env[PROBE_STEP_ENV];
    if (!file) return undefined;
    const scripted = JSON.parse(readFileSync(file, "utf8")) as { id?: string; overrides?: Record<string, unknown> };
    step = scripted.id ?? "";
    return mergePayload(event.payload as Record<string, unknown>, scripted.overrides ?? {});
  });
  pi.on("provider_stream_event", (event) => {
    const file = process.env[PROBE_RAW_ENV];
    if (!file) return undefined;
    const usage = rawUsageOf(event.data);
    if (usage) appendFileSync(file, `${JSON.stringify({ step, event: (event.data as { type?: unknown }).type, usage })}\n`);
    return undefined;
  });
}
