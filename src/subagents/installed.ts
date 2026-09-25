import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

// Test support: the installed pi-subagents' source directory, found from the
// login home so a test that redirects HOME still finds it. The parity tests
// compare the reimplementations with it and skip where it is not installed
// (CI, a fresh machine).

export const PI_SUBAGENTS_VERSION = "0.71.0";

export function installedPiSubagentsSrc(): string | undefined {
  const src = join(userInfo().homedir, ".pi", "agent", "npm", "node_modules", "pi-subagents", "src");
  return existsSync(join(src, "agents", "agents.js")) ? src : undefined;
}
