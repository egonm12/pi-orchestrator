import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Test-only replacement for the harness's guard installer (guard/activate.ts).
// It writes the same entry file that installer wrote into a throwaway agent
// directory's `extensions/`, so pi loads the guard from this checkout. It
// never touches the real agent directory. The live tests load the router
// extension as part of the installed package instead.

const here = dirname(fileURLToPath(import.meta.url));

export const GUARD_ENTRY_NAME = "pi-harness-personal-guard.ts";
export const GUARD_SOURCE = realpathSync(join(here, "..", "guard", "extension.ts"));

function entryContent(name: "guard", source: string, debugEnv: string): string {
  return (
    `// Test entry for the ${name} extension.\n` +
    `export default async function (pi) {\n` +
    `  try { const { default: ${name} } = await import(${JSON.stringify(source)}); await ${name}(pi); }\n` +
    `  catch (error) { process.stderr.write(\`pi-orchestrator ${name} disabled: \${String(error).split(/\\r?\\n/, 1)[0]}\\n\`);\n` +
    `    if (process.env.${debugEnv} === "1") process.stderr.write(\`\${error instanceof Error ? error.stack : String(error)}\\n\`); }\n` +
    `}\n`
  );
}

export const guardEntryPath = (agentDir: string): string => join(agentDir, "extensions", GUARD_ENTRY_NAME);
export const guardEntryContent = (): string => entryContent("guard", GUARD_SOURCE, "PI_ORCHESTRATOR_GUARD_DEBUG");

function install(entry: string, content: string): string {
  if (existsSync(entry)) throw new Error(`Refusing to replace the existing entry ${entry}`);
  writeFileSync(entry, content, { flag: "wx" });
  return entry;
}

export const installGuardEntry = (agentDir: string): string => install(guardEntryPath(agentDir), guardEntryContent());
