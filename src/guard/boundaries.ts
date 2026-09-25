import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { isProhibitedModel } from "../policy/model-resolution.ts";
import { canonicalPath } from "../policy/canonical-path.ts";

export interface BoundaryContext {
  readonly agentDir: string;
  readonly cwd: string;
}

function caseInsensitiveVolume(path: string): boolean {
  const canonical = canonicalPath(path);
  const otherCase = canonical.replace(/[A-Za-z]/g, (c) => c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  try {
    const a = statSync(canonical), b = statSync(otherCase);
    return a.ino === b.ino && a.dev === b.dev;
  } catch { return false; }
}

/** A path write and edit may not touch: inside the agent directory, outside its
 *  sessions/ subtree. Canonicalises existing ancestors (including symlinks) first. */
export function protectedAgentPath(path: string, ctx: BoundaryContext, home = homedir()): boolean {
  const root = canonicalPath(ctx.agentDir);
  const expanded = path === "~" || path.startsWith("~/") ? `${home}${path.slice(1)}` : path;
  const target = canonicalPath(isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded));
  const fold = caseInsensitiveVolume(root) ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (fold(target) !== fold(root) && !fold(target).startsWith(`${fold(root)}${sep}`)) return false;
  // Subagent extensions keep run artifacts below sessions/ (pi-subagents:
  // subagent-artifacts/), so that subtree is writable. A sessions/ that
  // resolves outside, or back to, the agent directory opens nothing.
  const sessions = canonicalPath(join(ctx.agentDir, "sessions"));
  const sessionsInside = fold(sessions).startsWith(`${fold(root)}${sep}`);
  return !(sessionsInside && fold(target).startsWith(`${fold(sessions)}${sep}`));
}

export interface DelegationObject {
  /** `""` for the input itself, then keys joined by `.` and array items as
   *  `[i]`: `tasks[1]`, `workflow.steps[0]`. */
  readonly path: string;
  readonly object: Record<string, unknown>;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether a key names a model field: `model`, case ignored. The one rule for
 *  what counts as a model field. */
export function isModelField(key: string): boolean {
  return key.toLowerCase() === "model";
}

/** Every object that can carry a `model` field, parents before children: the
 *  input itself and, for a delegation input, every object nested in it at any
 *  depth, directly or as an array item. The guard reads `model` on each. */
export function delegationObjects(input: unknown, delegation = false): DelegationObject[] {
  const found: DelegationObject[] = [];
  const visit = (value: unknown, path: string) => {
    if (!isPlainObject(value)) return;
    found.push({ path, object: value });
    if (!delegation) return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      if (Array.isArray(child)) child.forEach((item, index) => visit(item, `${childPath}[${index}]`));
      else visit(child, childPath);
    }
  };
  visit(input, "");
  return found;
}

/** Only actual `model` fields select models. Delegation objects can nest these fields. */
export function prohibitedModelIn(input: unknown, delegation = false): string | undefined {
  for (const { object } of delegationObjects(input, delegation)) {
    for (const [key, value] of Object.entries(object)) {
      if (isModelField(key) && typeof value === "string" && isProhibitedModel(value)) return value;
    }
  }
  return undefined;
}

/** Discard heredoc bodies before looking for executable words. This is intentionally not a complete shell parser. */
function withoutHeredocs(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let delimiter: string | undefined;
  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }
    kept.push(line);
    delimiter = /<<-?\s*['"]?([\w-]+)['"]?/.exec(line)?.[1];
  }
  return kept.join("\n");
}

/** Shell command words, preserving quoted payloads as one argument. */
function commandWords(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", quote = "", started = false;
  const flush = () => { if (started) words.push(word); word = ""; started = false; };
  const end = () => { flush(); if (words.length) commands.push(words); words = []; };
  const text = withoutHeredocs(command);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\" && quote !== "'" && i + 1 < text.length) { word += text[++i]; started = true; continue; }
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
      started = true;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) { if (c === "\n") end(); else flush(); }
    else if (/[;|&()`]/.test(c)) end();
    else { word += c; started = true; }
  }
  end();
  return commands;
}

function unsafePi(words: string[], ctx: BoundaryContext, depth = 0, inheritedAgentDir?: string): boolean {
  if (depth > 3) return false;
  let index = 0, agentDir = inheritedAgentDir;
  const assignment = (word: string) => {
    if (word.startsWith("PI_CODING_AGENT_DIR=")) agentDir = word.slice("PI_CODING_AGENT_DIR=".length);
  };
  while (index < words.length) {
    const word = words[index]!;
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(word)) { assignment(word); index++; continue; }
    if (["env", "command", "exec"].includes(basename(word))) {
      index++;
      while (words[index]?.startsWith("-") && !words[index]?.startsWith("--")) index++;
      continue;
    }
    break;
  }
  const executable = basename(words[index] ?? "");
  if (["sh", "bash", "zsh"].includes(executable)) {
    const option = words.findIndex((word, i) => i > index && /^-[a-z]*c[a-z]*$/.test(word));
    return option >= 0 && !!words[option + 1] && commandWords(words[option + 1]!).some((inner) => unsafePi(inner, ctx, depth + 1, agentDir));
  }
  if (!["pi", "pi.js", "pi.mjs"].includes(executable)) return false;
  const args = words.slice(index + 1);
  if (args.some((arg) => arg === "-ne" || arg === "--no-extensions")) return true;
  if (!agentDir) return false;
  const home = homedir();
  const expanded = agentDir.replace(/^\$\{HOME\}|^\$HOME|^~(?=\/|$)/, home);
  const root = canonicalPath(ctx.agentDir);
  const candidate = canonicalPath(isAbsolute(expanded) ? expanded : resolve(ctx.cwd, expanded));
  const fold = caseInsensitiveVolume(root) ? (value: string) => value.toLowerCase() : (value: string) => value;
  return fold(candidate) !== fold(root);
}

export function launchesUnguardedPi(command: string, ctx: BoundaryContext): boolean {
  return commandWords(command).some((words) => unsafePi(words, ctx));
}

export function toolRefusal(toolName: string, input: Record<string, unknown>, ctx: BoundaryContext): string | undefined {
  // Bash command text may quote models as data. Only dedicated model fields select a model.
  const { command: _command, ...fields } = toolName === "bash" ? input : { ...input };
  const prohibited = prohibitedModelIn(fields, toolName === "subagent");
  if (prohibited) return `prohibited model: ${prohibited}`;
  if ((toolName === "write" || toolName === "edit") && typeof input.path === "string" && protectedAgentPath(input.path, ctx)) {
    return `cannot modify the agent directory ${ctx.agentDir}`;
  }
  if (toolName === "bash" && typeof input.command === "string" && launchesUnguardedPi(input.command, ctx)) {
    return "nested pi with extensions disabled or a different agent directory is refused";
  }
  return undefined;
}
