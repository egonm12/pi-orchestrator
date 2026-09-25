import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Reimplementation of the agent lookup the router needs from pi-subagents
// (installed version 0.71.0): `agents/agent-scope.js`
// (`resolveExecutionAgentScope`) and the parts of `agents/agents.js`
// (`discoverAgents`, `resolveAgentName`) that decide which definition a
// `subagent` call's agent name resolves to and which `model` that definition
// carries. The router only asks whether the definition pins a model, so this
// keeps name, local name, aliases, source, `model`, `modelSource`,
// `modelProvider` and `disabled`, and drops every other field.
//
// Covered, as 0.71.0 does it:
// - Definition files: `*.md` (not `*.chain.md`) found recursively, pruning
//   `.git`, `node_modules`, `.pi`, `sync-backups`, git checkouts, nested
//   project roots and legacy `.agents/skills` paths. A file needs `name` and
//   `description` frontmatter; `package` prefixes the runtime name.
// - Sources and precedence: builtin < package < user < project.
//   User: PI_SUBAGENT_EXTRA_AGENT_DIRS, `subagents.agentScanDirs`,
//   `<agent dir>/agents`, `~/.agents`. Project: the configured project root's
//   `subagents.agentScanDirs`, `.agents` and `.pi/agents`. Packages: the
//   project root, `.pi/npm/node_modules`, the project's `packages`,
//   `<agent dir>/npm/node_modules` and the user's `packages`.
// - Settings: `agentOverrides`, `agentOverridesByProvider`, `defaultModel`,
//   `defaultProvider`, `disableBuiltins` and `agentExcludeDirs`, project over
//   user.
// Not covered: the global npm root (`npm root -g`), which 0.71.0 also scans
// for packages unless PI_OFFLINE is set. Runtime agents are not visible from
// a separate module root either.

export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "package" | "user" | "project";

export interface AgentModelSource {
  readonly type: "subagents.defaultModel";
  readonly scope: "user" | "project";
  readonly path: string;
  readonly model: string;
}

export interface AgentConfig {
  readonly name: string;
  readonly localName: string;
  readonly aliases?: readonly string[];
  readonly source: AgentSource;
  readonly model?: string;
  readonly modelSource?: AgentModelSource;
  readonly modelProvider?: string;
  readonly disabled?: boolean;
}

/** pi-subagents 0.71.0's builtin agents. None of their files sets `model`. */
export const BUILTIN_AGENTS: readonly { name: string; aliases?: readonly string[] }[] = [
  { name: "claude-code" },
  { name: "claude-code-writer" },
  { name: "codex-exec" },
  { name: "codex-exec-writer" },
  { name: "cursor-agent" },
  { name: "cursor-agent-writer" },
  { name: "delegate" },
  { name: "evidence-auditor" },
  { name: "oracle", aliases: ["advisor"] },
  { name: "researcher" },
  { name: "reviewer" },
  { name: "scout" },
  { name: "worker", aliases: ["developer", "coder", "implementer", "develop"] },
];

export function resolveExecutionAgentScope(scope: unknown): AgentScope {
  return scope === "user" || scope === "project" || scope === "both" ? scope : "both";
}

// ---------------------------------------------------------------------------
// Paths and settings
// ---------------------------------------------------------------------------

function home(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/** `PI_CODING_AGENT_DIR` with `~` expanded, else `~/.pi/agent`. */
export function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  if (configured === "~") return home();
  if (configured?.startsWith("~/") || configured?.startsWith("~\\")) return join(home(), configured.slice(2));
  if (configured) return resolve(configured);
  return join(home(), ".pi", "agent");
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

function isPathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Strict read: a malformed settings file throws, as pi-subagents does. */
function readSettings(filePath: string | null): Record<string, unknown> {
  if (!filePath || !existsSync(filePath)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse settings file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function subagentsOf(settings: Record<string, unknown>): Record<string, unknown> {
  const value = settings.subagents;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

function findProjectRootCandidates(cwd: string): string[] {
  const roots: string[] = [];
  const homes = new Set(
    [homedir(), process.env.HOME, process.env.USERPROFILE].filter((value): value is string => Boolean(value?.trim())).filter(isDirectory).map(canonical),
  );
  let current = cwd;
  while (true) {
    if (isDirectory(current) && homes.has(canonical(current))) return roots;
    if (isDirectory(join(current, ".pi")) || isDirectory(join(current, ".agents"))) roots.push(current);
    const parent = dirname(current);
    if (parent === current) return roots;
    current = parent;
  }
}

function findNearestGitRoot(cwd: string): string | null {
  let current = cwd;
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function projectRootResolution(root: string): "nearest" | "git-root" | undefined {
  const settingsPath = join(root, ".pi", "settings.json");
  if (!existsSync(settingsPath)) return undefined;
  const value = subagentsOf(readSettings(settingsPath)).projectRootResolution;
  if (value === undefined) return undefined;
  if (value === "nearest" || value === "git-root") return value;
  throw new Error(`Subagent settings in '${settingsPath}' have invalid 'projectRootResolution'; expected 'nearest' or 'git-root'.`);
}

export function findConfiguredProjectRoot(cwd: string): string | null {
  const candidates = findProjectRootCandidates(cwd);
  const nearest = candidates[0];
  if (!nearest) return null;
  for (const [index, candidate] of candidates.entries()) {
    const mode = projectRootResolution(candidate);
    if (mode === "nearest") return nearest;
    if (mode === "git-root") {
      const gitRoot = findNearestGitRoot(cwd);
      const gitProjectRoot = gitRoot ? candidates.slice(index).find((c) => resolve(c) === resolve(gitRoot)) : undefined;
      const configuredGitRoot = existsSync(join(candidate, ".git")) ? candidate : undefined;
      return gitProjectRoot ?? configuredGitRoot ?? nearest;
    }
  }
  return nearest;
}

// ---------------------------------------------------------------------------
// Settings the lookup reads
// ---------------------------------------------------------------------------

interface Override {
  model?: string | false;
  disabled?: boolean;
}

interface SubagentSettings {
  overrides: Record<string, Override>;
  providerOverrides: Record<string, Record<string, Override>>;
  defaultModel?: string;
  defaultProvider?: string;
  disableBuiltins?: boolean;
  agentScanDirs?: string[];
}

const EMPTY_SETTINGS: SubagentSettings = { overrides: {}, providerOverrides: {} };

function parseOverride(label: string, value: unknown, filePath: string): Override | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const override: Override = {};
  if ("model" in input) {
    if (typeof input.model === "string" || input.model === false) override.model = input.model;
    else throw new Error(`Builtin override '${label}' in '${filePath}' has invalid 'model'; expected a string or false.`);
  }
  if ("disabled" in input) {
    if (typeof input.disabled === "boolean") override.disabled = input.disabled;
    else throw new Error(`Builtin override '${label}' in '${filePath}' has invalid 'disabled'; expected a boolean.`);
  }
  return override;
}

function readSubagentSettings(filePath: string | null): SubagentSettings {
  if (!filePath) return EMPTY_SETTINGS;
  const subagents = subagentsOf(readSettings(filePath));
  const settings: SubagentSettings = { overrides: {}, providerOverrides: {} };
  if ("disableBuiltins" in subagents) {
    if (typeof subagents.disableBuiltins !== "boolean") throw new Error(`Subagent settings in '${filePath}' have invalid 'disableBuiltins'; expected a boolean.`);
    settings.disableBuiltins = subagents.disableBuiltins;
  }
  for (const key of ["defaultModel", "defaultProvider"] as const) {
    if (!(key in subagents)) continue;
    const value = subagents[key];
    if (typeof value !== "string" || !value.trim()) throw new Error(`Subagent settings in '${filePath}' have invalid '${key}'; expected a non-empty string.`);
    settings[key] = value.trim();
  }
  if (Array.isArray(subagents.agentScanDirs)) settings.agentScanDirs = stringList(subagents.agentScanDirs);
  const overrides = subagents.agentOverrides;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    for (const [name, value] of Object.entries(overrides)) {
      const parsed = parseOverride(name, value, filePath);
      if (parsed) settings.overrides[name] = parsed;
    }
  }
  const byProvider = subagents.agentOverridesByProvider;
  if (byProvider !== undefined) {
    if (!byProvider || typeof byProvider !== "object" || Array.isArray(byProvider)) {
      throw new Error(`Subagent settings in '${filePath}' have invalid 'agentOverridesByProvider'; expected an object keyed by provider.`);
    }
    for (const [provider, value] of Object.entries(byProvider)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Subagent settings in '${filePath}' have invalid 'agentOverridesByProvider.${provider}'; expected an object keyed by agent.`);
      }
      const entries: Record<string, Override> = {};
      for (const [name, agentValue] of Object.entries(value)) {
        const parsed = parseOverride(`agentOverridesByProvider.${provider}.${name}`, agentValue, filePath);
        if (parsed) entries[name] = parsed;
      }
      settings.providerOverrides[provider] = entries;
    }
  }
  return settings;
}

function selectProviderOverrides(settings: SubagentSettings, provider: string | undefined): SubagentSettings {
  const selected = provider ? settings.providerOverrides[provider] : undefined;
  if (!selected) return settings;
  const overrides = { ...settings.overrides };
  for (const [name, override] of Object.entries(selected)) overrides[name] = { ...overrides[name], ...override };
  return { ...settings, overrides };
}

// ---------------------------------------------------------------------------
// Definition files
// ---------------------------------------------------------------------------

/** pi-subagents' frontmatter reader, for the flat and block keys it produces. */
export function parseFrontmatter(content: string): Record<string, string> {
  const frontmatter: Record<string, string> = {};
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) return frontmatter;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return frontmatter;
  let blockKey: string | null = null;
  let blockLines: string[] = [];
  let blockIndent = 0;
  let blockScalar = false;
  const flush = () => {
    if (blockKey === null) return;
    const raw = blockLines.join("\n");
    const prefix = raw.match(/^[ \t]+(?=\S)/m)?.[0] ?? "";
    frontmatter[blockKey] = prefix ? raw.split("\n").map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line)).join("\n").replace(/^\n/, "") : raw;
    blockKey = null;
  };
  for (const line of normalized.slice(4, end).split("\n")) {
    const indent = line.search(/\S|$/);
    if (blockKey !== null && (indent > blockIndent || (blockScalar && line.trim() === ""))) {
      blockLines.push(line);
      continue;
    }
    flush();
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const rawValue = match[2]!.trim();
    const quoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"));
    const value = quoted ? rawValue.slice(1, -1) : rawValue;
    const scalar = !quoted && [">", ">-", "|", "|-"].includes(rawValue);
    if (value === "" || scalar) {
      blockKey = key;
      blockLines = [];
      blockIndent = indent;
      blockScalar = scalar;
    } else {
      frontmatter[key] = value;
    }
  }
  flush();
  return frontmatter;
}

function parseList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split("\n")
    .flatMap((line) => {
      const value = line.trim();
      return (value.match(/^-\s+(.+)$/)?.[1] ?? value).split(",");
    })
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizePackageName(value: string): string | undefined {
  const name = value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9.-]/g, "").replace(/-+/g, "-").replace(/\.+/g, ".").replace(/(?:^[-.]+|[-.]+$)/g, "");
  return name && /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/.test(name) ? name : undefined;
}

const PRUNED = new Set([".git", "node_modules", ".pi", "sync-backups"]);

function isNestedProjectRoot(dir: string): boolean {
  return isDirectory(join(dir, ".pi")) || isDirectory(join(dir, ".agents"));
}

function isLegacySkillPath(root: string, filePath: string): boolean {
  const parts = relative(root, filePath).split(sep).map((part) => part.toLowerCase());
  if (basename(root).toLowerCase() === ".agents") parts.unshift(".agents");
  return parts.some((part, index) => part === ".agents" && parts[index + 1] === "skills");
}

function definitionFiles(dir: string, isExcluded: (path: string) => boolean): string[] {
  const root = resolve(dir);
  if (isExcluded(root) || !isDirectory(root)) return [];
  const files: string[] = [];
  const visited = new Set<string>();
  const visit = (current: string) => {
    const real = canonical(current);
    if (visited.has(real)) return;
    visited.add(real);
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const entry of entries) {
      const filePath = join(current, entry.name);
      if (isExcluded(filePath)) continue;
      const dirEntry = entry.isSymbolicLink() ? isDirectory(filePath) : entry.isDirectory();
      if (dirEntry) {
        const prune = PRUNED.has(entry.name) || existsSync(join(filePath, ".git")) || (resolve(filePath) !== root && isNestedProjectRoot(filePath));
        if (!prune) visit(filePath);
        continue;
      }
      if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md") && !entry.name.endsWith(".chain.md") && !isLegacySkillPath(root, filePath)) {
        files.push(filePath);
      }
    }
  };
  visit(root);
  return files;
}

function loadAgentsFromDir(dir: string, source: AgentSource, isExcluded: (path: string) => boolean): AgentConfig[] {
  const agents: AgentConfig[] = [];
  for (const filePath of definitionFiles(dir, isExcluded)) {
    let frontmatter: Record<string, string>;
    try { frontmatter = parseFrontmatter(readFileSync(filePath, "utf8")); } catch { continue; }
    if (!frontmatter.name || !frontmatter.description) continue;
    const localName = frontmatter.name;
    const pkg = frontmatter.package && frontmatter.package !== "false" ? normalizePackageName(frontmatter.package) : undefined;
    // A malformed package is a diagnostic in pi-subagents; the definition is not usable.
    if (frontmatter.package && frontmatter.package !== "false" && pkg === undefined) continue;
    const name = pkg ? `${pkg}.${localName}` : localName;
    const aliases = [...new Set((parseList(frontmatter.aliases ?? frontmatter.alias) ?? []).map((a) => a.trim()).filter(Boolean))].filter((a) => a !== name);
    agents.push({
      name,
      localName,
      source,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(frontmatter.model !== undefined ? { model: frontmatter.model } : {}),
    });
  }
  return agents;
}

function expandScanDir(pattern: string, base: string, isExcluded: (path: string) => boolean): string[] {
  const expanded = expandHome(pattern.trim()).replace(/[\\/]+/g, sep);
  if (!expanded) return [];
  const stars = [...expanded.matchAll(/\*/g)].length;
  if (stars === 0) {
    const dir = resolve(base, expanded);
    return !isExcluded(dir) && existsSync(dir) ? [dir] : [];
  }
  const parts = expanded.split(sep);
  const index = parts.findIndex((part) => part.includes("*"));
  if (stars !== 1 || index === -1 || parts[index] !== "*") return [];
  const root = resolve(base, parts.slice(0, index).join(sep) || sep);
  if (isExcluded(root)) return [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, ...parts.slice(index + 1)))
    .filter((dir) => !isExcluded(dir) && existsSync(dir));
}

// ---------------------------------------------------------------------------
// Packages
// ---------------------------------------------------------------------------

function isSafePackagePath(value: string): boolean {
  return value.length > 0 && !isAbsolute(value) && value.split(/[\\/]/).every((part) => part.length > 0 && part !== "." && part !== "..");
}

function parseGitPackagePath(source: string): { host: string; repoPath: string } | undefined {
  const spec = source.slice(4).trim();
  if (!spec) return undefined;
  let host = "";
  let repoPath = "";
  const scp = spec.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1] ?? "";
    repoPath = scp[2] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
    try {
      const url = new URL(spec);
      host = url.hostname;
      repoPath = url.pathname.replace(/^\/+/, "");
    } catch { return undefined; }
  } else {
    const slash = spec.indexOf("/");
    if (slash < 0) return undefined;
    host = spec.slice(0, slash);
    repoPath = spec.slice(slash + 1);
  }
  const refIndex = [repoPath.indexOf("@"), repoPath.indexOf("#")].filter((i) => i >= 0).sort((a, b) => a - b)[0];
  const normalized = (refIndex === undefined ? repoPath : repoPath.slice(0, refIndex)).replace(/\.git$/, "").replace(/^\/+/, "");
  if (!host || !isSafePackagePath(host) || !isSafePackagePath(normalized) || normalized.split(/[\\/]/).length < 2) return undefined;
  return { host, repoPath: normalized };
}

/** Where a `packages` entry is installed, relative to its settings dir. */
export function resolveSettingsPackageRoot(source: string, baseDir: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("git:")) {
    const parsed = parseGitPackagePath(trimmed);
    return parsed ? join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
  }
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice(4).trim();
    if (!spec) return undefined;
    const name = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/)?.[1] ?? spec;
    return isSafePackagePath(name) ? join(baseDir, "npm", "node_modules", name) : undefined;
  }
  const normalized = trimmed.startsWith("file:") ? trimmed.slice(5) : trimmed;
  if (normalized === "~" || normalized.startsWith("~/")) return expandHome(normalized);
  if (isAbsolute(normalized)) return normalized;
  if (normalized === "." || normalized === ".." || normalized.startsWith("./") || normalized.startsWith("../")) return resolve(baseDir, normalized);
  if (/^https?:\/\//i.test(trimmed)) {
    const parsed = parseGitPackagePath(`git:${trimmed}`);
    return parsed ? join(baseDir, "git", parsed.host, parsed.repoPath) : undefined;
  }
  return undefined;
}

function nodeModulesRoots(dir: string): string[] {
  const roots: string[] = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return roots; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    if (!entry.name.startsWith("@")) { roots.push(join(dir, entry.name)); continue; }
    let scoped;
    try { scoped = readdirSync(join(dir, entry.name), { withFileTypes: true }); } catch { continue; }
    for (const inner of scoped) {
      if (!inner.name.startsWith(".") && (inner.isDirectory() || inner.isSymbolicLink())) roots.push(join(dir, entry.name, inner.name));
    }
  }
  return roots;
}

function settingsPackageRoots(settingsFile: string, baseDir: string): string[] {
  const packages = readSettings(settingsFile).packages;
  if (!Array.isArray(packages)) return [];
  return packages.flatMap((entry) => {
    const source = typeof entry === "string" ? entry : entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string" ? (entry as { source: string }).source : undefined;
    const root = source ? resolveSettingsPackageRoot(source, baseDir) : undefined;
    return root ? [root] : [];
  });
}

function packageAgentDirs(packageRoot: string): string[] {
  let pkg: unknown;
  try { pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")); } catch { return []; }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) return [];
  const record = pkg as Record<string, unknown>;
  const roots: Record<string, unknown>[] = [];
  const legacy = record["pi-subagents"];
  if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) roots.push(legacy as Record<string, unknown>);
  const pi = record.pi;
  if (pi && typeof pi === "object" && !Array.isArray(pi)) {
    const subagents = (pi as Record<string, unknown>).subagents;
    if (subagents && typeof subagents === "object" && !Array.isArray(subagents)) roots.push(subagents as Record<string, unknown>);
  }
  return roots.flatMap((root) => stringList(root.agents).map((entry) => resolve(packageRoot, entry)));
}

function packageAgentPaths(cwd: string, scope: AgentScope): string[] {
  const projectRoot = findConfiguredProjectRoot(cwd) ?? cwd;
  const roots = [projectRoot];
  const safe = (read: () => string[]) => { try { return read(); } catch { return []; } };
  if (scope !== "user") {
    const config = join(projectRoot, ".pi");
    roots.push(...nodeModulesRoots(join(config, "npm", "node_modules")));
    roots.push(...safe(() => settingsPackageRoots(join(config, "settings.json"), config)));
  }
  if (scope !== "project") {
    const dir = agentDir();
    roots.push(...nodeModulesRoots(join(dir, "npm", "node_modules")));
    roots.push(...safe(() => settingsPackageRoots(join(dir, "settings.json"), dir)));
  }
  const seenRoots = new Set<string>();
  const dirs: string[] = [];
  for (const root of roots) {
    const resolved = resolve(root);
    if (seenRoots.has(resolved)) continue;
    seenRoots.add(resolved);
    for (const dir of packageAgentDirs(resolved)) if (!dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function applyOverride(agent: AgentConfig, override: Override): AgentConfig {
  const next: { -readonly [K in keyof AgentConfig]: AgentConfig[K] } = { ...agent };
  if (override.model !== undefined) {
    if (override.model === false) delete next.model;
    else next.model = override.model;
  }
  if (override.disabled !== undefined) next.disabled = override.disabled;
  return next;
}

export interface DiscoveredAgents {
  readonly agents: AgentConfig[];
}

export function discoverAgents(cwd: string, scope: AgentScope, preferredModelProvider?: string): DiscoveredAgents {
  const effectiveCwd = resolve(cwd);
  const projectRoot = findConfiguredProjectRoot(effectiveCwd);
  const userSettingsPath = join(agentDir(), "settings.json");
  const projectSettingsPath = projectRoot ? join(projectRoot, ".pi", "settings.json") : null;
  const user = selectProviderOverrides(scope === "project" ? EMPTY_SETTINGS : readSubagentSettings(userSettingsPath), preferredModelProvider);
  const project = selectProviderOverrides(scope === "user" ? EMPTY_SETTINGS : readSubagentSettings(projectSettingsPath), preferredModelProvider);

  const defaultProvider = projectSettingsPath && project.defaultProvider !== undefined ? project.defaultProvider : user.defaultProvider;
  const defaultModel: AgentModelSource | undefined =
    projectSettingsPath && project.defaultModel !== undefined
      ? { type: "subagents.defaultModel", scope: "project", path: projectSettingsPath, model: project.defaultModel }
      : user.defaultModel !== undefined
        ? { type: "subagents.defaultModel", scope: "user", path: userSettingsPath, model: user.defaultModel }
        : undefined;
  const applyDefaults = (agents: AgentConfig[]): AgentConfig[] =>
    !defaultModel && !defaultProvider
      ? agents
      : agents.map((agent) =>
          agent.model !== undefined && (agent.modelProvider !== undefined || !defaultProvider)
            ? agent
            : {
                ...agent,
                ...(agent.model === undefined && defaultModel ? { model: defaultModel.model, modelSource: defaultModel } : {}),
                ...(defaultProvider ? { modelProvider: defaultProvider } : {}),
              },
        );

  const exclusions = [
    ...(stringList(subagentsOf(readSettings(userSettingsPath)).agentExcludeDirs).map((entry) => resolve(dirname(userSettingsPath), expandHome(entry.trim())))),
    ...(projectSettingsPath ? stringList(subagentsOf(readSettings(projectSettingsPath)).agentExcludeDirs).map((entry) => resolve(dirname(projectSettingsPath), expandHome(entry.trim()))) : []),
  ].map((root) => ({ root, real: canonical(root) }));
  const isExcluded = (path: string) =>
    exclusions.length > 0 && (exclusions.some((e) => isPathWithin(e.root, path)) || exclusions.some((e) => isPathWithin(e.real, canonical(path))));

  const builtinBase: AgentConfig[] = BUILTIN_AGENTS.map((agent) => ({ name: agent.name, localName: agent.name, source: "builtin", ...(agent.aliases ? { aliases: agent.aliases } : {}) }));
  const projectBulkDisabled = project.disableBuiltins === true && projectSettingsPath !== null;
  const userBulkDisabled = project.disableBuiltins === undefined && user.disableBuiltins === true;
  const builtin = applyDefaults(builtinBase).map((agent) => {
    const projectOverride = project.overrides[agent.name];
    if (projectOverride && projectSettingsPath) return applyOverride(agent, projectOverride);
    if (projectBulkDisabled) return applyOverride(agent, { disabled: true });
    const userOverride = user.overrides[agent.name];
    if (userOverride) return applyOverride(agent, userOverride);
    if (userBulkDisabled) return applyOverride(agent, { disabled: true });
    return agent;
  });
  const customOverrides = (agents: AgentConfig[]) =>
    agents.map((agent) => {
      const withUser = user.overrides[agent.name] ? applyOverride(agent, user.overrides[agent.name]!) : agent;
      const projectOverride = project.overrides[agent.name];
      return projectOverride && projectSettingsPath ? applyOverride(withUser, projectOverride) : withUser;
    });

  const extraDirs = (process.env.PI_SUBAGENT_EXTRA_AGENT_DIRS ?? "").split(delimiter).map((dir) => dir.trim()).filter(Boolean);
  const userDirs = scope === "project" ? [] : [
    ...extraDirs,
    ...(user.agentScanDirs ?? []).flatMap((entry) => expandScanDir(entry, process.cwd(), isExcluded)),
    join(agentDir(), "agents"),
    join(homedir(), ".agents"),
  ];
  const userAgents = customOverrides(applyDefaults(userDirs.filter((dir) => !isExcluded(dir)).flatMap((dir) => loadAgentsFromDir(dir, "user", isExcluded))));

  const projectDirs = scope === "user" || !projectRoot ? [] : [
    ...(project.agentScanDirs ?? []).flatMap((entry) => expandScanDir(entry, process.cwd(), isExcluded)),
    ...[join(projectRoot, ".agents"), join(projectRoot, ".pi", "agents")].filter(isDirectory),
  ];
  const projectAgents = customOverrides(applyDefaults(projectDirs.filter((dir) => !isExcluded(dir)).flatMap((dir) => loadAgentsFromDir(dir, "project", isExcluded))));

  const packageMap = new Map<string, AgentConfig>();
  for (const dir of packageAgentPaths(effectiveCwd, scope)) {
    if (isExcluded(dir)) continue;
    for (const agent of loadAgentsFromDir(dir, "package", isExcluded)) if (!packageMap.has(agent.name)) packageMap.set(agent.name, agent);
  }
  const packageAgents = customOverrides(applyDefaults([...packageMap.values()]));

  const merged = new Map<string, AgentConfig>();
  for (const agent of [...builtin, ...packageAgents]) merged.set(agent.name, agent);
  if (scope !== "project") for (const agent of userAgents) merged.set(agent.name, agent);
  if (scope !== "user") for (const agent of projectAgents) merged.set(agent.name, agent);
  return { agents: [...merged.values()].filter((agent) => agent.disabled !== true) };
}

const SOURCE_RANK: Record<AgentSource, number> = { builtin: 0, package: 1, user: 2, project: 3 };

function effectiveMatch(matches: AgentConfig[]): { agent?: AgentConfig } {
  if (new Set(matches.map((agent) => agent.name)).size !== 1) return {};
  const agent = [...matches].sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source])[0];
  return agent ? { agent } : {};
}

/** Name, then local name, then alias; an ambiguous match is an error. */
export function resolveAgentName(name: string, agents: readonly AgentConfig[]): { agent?: AgentConfig; error?: string } {
  const raw = name.trim();
  const lookups: [label: string, matches: AgentConfig[]][] = [
    ["agent name", agents.filter((agent) => agent.name === raw)],
    ["local agent name", agents.filter((agent) => agent.localName === raw)],
    ["agent alias", agents.filter((agent) => agent.aliases?.includes(raw))],
  ];
  for (const [label, matches] of lookups) {
    if (matches.length === 1) return { agent: matches[0]! };
    if (matches.length > 1) {
      const effective = effectiveMatch(matches);
      if (effective.agent) return effective;
      return { error: `Ambiguous ${label} '${name}': ${matches.map((agent) => agent.name).join(", ")}` };
    }
  }
  return {};
}
