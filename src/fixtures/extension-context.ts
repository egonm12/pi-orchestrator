import type { SessionModelRegistry } from "../routing/model-stream.ts";

// Test support: the part of pi's ExtensionContext the router and guard read.
// Tests build these by hand and pass them to handlers captured from a fake
// ExtensionAPI; pi's real context has many more fields.
export interface TestContext {
  hasUI: boolean;
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  modelRegistry?: SessionModelRegistry;
  sessionManager?: { getSessionId(): string };
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  abort?(): void;
}
