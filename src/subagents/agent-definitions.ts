import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { SUBAGENTS_STATUS_TOOL } from "./status.ts";
import { SUBAGENTS_TOOL } from "./worker.ts";

// Agent definitions (ADR 0007, CONTEXT.md): owner-written markdown files with
// frontmatter (name, description, tools, model, thinking) and a body of instructions, in
// ~/.pi/agent/agents/ and the project's .pi/agents/. A project file wins by
// name. pi-orchestrator ships none.

export interface AgentDefinition {
  readonly name: string;
  readonly description: string;
  /** The `tools:` list, when the file has one. It only narrows the orchestrator's tools. */
  readonly tools?: readonly string[];
  /** The file's body. */
  readonly instructions: string;
  readonly file: string;
  readonly model?: string;
  readonly thinking?: string;
}

export interface AgentDefinitionDirs {
  /** The owner's folder: `<agent dir>/agents`. */
  readonly personal: string;
  /** The project's folder: `<cwd>/.pi/agents`. */
  readonly project: string;
}

export function agentDefinitionDirs(agentDir: string, cwd: string): AgentDefinitionDirs {
  return { personal: join(agentDir, "agents"), project: join(cwd, ".pi", "agents") };
}

/** `parseFrontmatter` runs a YAML parser, so any value can appear. */
type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
  thinking?: unknown;
};

/** `tools: read, bash` and `tools: [read, bash]` are both a list. */
function toolList(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const raw: unknown[] = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return raw.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim()).filter((tool) => tool !== "");
}

/** The `.md` files in `dir` that name and describe an agent. A missing folder
 *  has none; a file without a name or description is not a definition. */
function readAgentFolder(dir: string): AgentDefinition[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const definitions: AgentDefinition[] = [];
  for (const file of files) {
    const path = join(dir, file);
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
    const tools = toolList(frontmatter.tools);
    definitions.push({
      name: frontmatter.name.trim(), description: frontmatter.description.trim(), instructions: body.trim(), file: path,
      ...(typeof frontmatter.model === "string" && frontmatter.model.trim() !== "" ? { model: frontmatter.model.trim() } : {}),
      ...(typeof frontmatter.thinking === "string" && frontmatter.thinking.trim() !== "" ? { thinking: frontmatter.thinking.trim() } : {}),
      ...(tools === undefined ? {} : { tools }),
    });
  }
  return definitions;
}

/** The owner's and the project's definitions by name; a project file wins. Sorted by name. */
export function loadAgentDefinitions(dirs: AgentDefinitionDirs): readonly AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const definition of [...readAgentFolder(dirs.personal), ...readAgentFolder(dirs.project)]) byName.set(definition.name, definition);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The tool description's listing of the definitions. */
export function agentDefinitionListing(definitions: readonly AgentDefinition[]): string {
  if (definitions.length === 0) return "There are no agent definitions in ~/.pi/agent/agents/ or .pi/agents/.";
  return ["Agent definitions:", ...definitions.map((definition) => `- ${definition.name}: ${definition.description}`)].join("\n");
}

/** What a task item's `agent` gives its worker. */
export type AgentResolution =
  | { readonly ok: true; readonly instructions?: string; readonly tools?: readonly string[]; readonly definition?: AgentDefinition }
  | { readonly ok: false; readonly error: string };

/** Resolve a task item's `agent` against the definitions. No agent gives the
 *  worker no instructions and the default tools. A definition's `tools:` list
 *  keeps only tools in `orchestratorTools`, and the subagents tool only when
 *  `mayDelegate` (ADR 0008: the orchestrator's workers, not theirs). It never
 *  keeps `subagents_status`, which is the orchestrator's alone. */
export function resolveAgent(
  agent: string | undefined, definitions: readonly AgentDefinition[], orchestratorTools: readonly string[], mayDelegate = false,
): AgentResolution {
  if (agent === undefined) return { ok: true };
  const definition = definitions.find((candidate) => candidate.name === agent);
  if (definition === undefined) {
    const known = definitions.length === 0 ? "there are none" : `known agents: ${definitions.map((candidate) => candidate.name).join(", ")}`;
    return { ok: false, error: `unknown agent "${agent}"; ${known}` };
  }
  const tools = definition.tools?.filter((tool) => (mayDelegate || tool !== SUBAGENTS_TOOL) && tool !== SUBAGENTS_STATUS_TOOL && tool !== "subagents_message" &&
    orchestratorTools.includes(tool));
  return {
    ok: true,
    definition,
    ...(definition.instructions === "" ? {} : { instructions: definition.instructions }),
    ...(tools === undefined ? {} : { tools }),
  };
}
