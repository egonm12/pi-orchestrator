import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundCalls, type BackgroundMessageMode } from "./background.ts";

/** Messages use pi's session queue: steer runs after the current tool call,
 * followUp runs when the worker would otherwise stop. */
export function registerSubagentsMessageTool(pi: ExtensionAPI, calls: BackgroundCalls): void {
  pi.registerTool({
    name: "subagents_message",
    label: "Subagents message",
    description: "Send text to one running background worker by delegation id. steer (default) arrives after its current tool call; followUp arrives when it would stop. Use this to answer a worker's question.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The background worker's delegation id, not the call id." },
        text: { type: "string", description: "The message to the worker." },
        mode: { type: "string", enum: ["steer", "followUp"], description: "When to deliver the message; defaults to steer." },
      },
      required: ["id", "text"],
      additionalProperties: false,
    } as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
    async execute(_toolCallId, params) {
      const { id, text, mode = "steer" } = params as { id: string; text: string; mode?: BackgroundMessageMode };
      if (!id || !text || (mode !== "steer" && mode !== "followUp")) throw new Error("subagents_message requires an id, text, and mode steer or followUp");
      await calls.message(id, text, mode);
      return { content: [{ type: "text", text: `Sent ${mode} to background worker ${id}.` }], details: undefined };
    },
  });
}
