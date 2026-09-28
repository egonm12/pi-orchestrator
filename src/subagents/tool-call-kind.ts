import { basename } from "node:path";

// What a tool call is: a kind, not a yes or no, so each caller draws its own
// line. The exploration budget (ADR 0005) counts read-only and unrecognised
// calls. Telling whether a worker edited (ADR 0010, ./editing.ts) counts edit,
// any bash that is neither read-only nor build-test, and ctx_execute.
//
// A bash command is read as a list of simple commands joined by `&&`, `||`,
// `;`, `&`, newlines, pipes and command substitution. Each simple command gets
// a kind, and the strongest wins: unrecognised, then version-control, then
// read-only, then build-test. A read-only command that reads a pipe (`| tail`)
// is a filter and adds nothing. A redirect into a file, or anything the reader
// cannot follow (a command named by a variable, command substitution inside
// double quotes, an open quote), makes the command unrecognised.

/** What a bash command does. */
export type BashCommandKind =
  /** Searches, listings, reads and git's read-only subcommands. */
  | "read-only"
  /** A build, test run, type check or lint that writes no source. */
  | "build-test"
  /** A commit, push or other change to the git repository or its working tree. */
  | "version-control"
  /** Anything else, a redirect into a file included. */
  | "unrecognised";

/** What a tool call does. bash gets its command's kind; `unrecognised` is
 *  only ever a bash (or powershell) command. */
export type ToolCallKind = BashCommandKind
  /** `edit` or `write`. */
  | "edit"
  /** The subagents tools: `subagents`, `subagents_status`, `subagents_message`, `subagents_verdict`. */
  | "delegation"
  /** A tool the classification does not know, or an mcp install or sign-in. */
  | "other";

/** Tools that read, search, list or fetch, whatever their input. */
const READ_ONLY_TOOLS = new Set([
  "read", "grep", "find", "ls",
  "web_search", "fetch_content", "get_search_content", "source_check",
  "ctx_execute", "ctx_execute_file", "ctx_search", "ctx_batch_execute", "ctx_fetch_and_index",
  "mcpScript",
]);
const EDIT_TOOLS = new Set(["edit", "write"]);
const DELEGATION_TOOLS = new Set(["subagents", "subagents_status", "subagents_message", "subagents_verdict"]);
/** mcp actions that install or sign in to a server: actions, not lookups. */
const MCP_ACTIONS = new Set(["install", "auth-start", "auth-complete"]);

/** The kind of one tool call, from its tool name and input. */
export function classifyToolCall(toolName: string, input: unknown): ToolCallKind {
  const fields = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
  if (toolName === "bash") return typeof fields.command === "string" ? classifyBashCommand(fields.command) : "unrecognised";
  if (toolName === "powershell") return "unrecognised";
  if (EDIT_TOOLS.has(toolName)) return "edit";
  if (DELEGATION_TOOLS.has(toolName)) return "delegation";
  if (toolName === "mcp") return typeof fields.action === "string" && MCP_ACTIONS.has(fields.action) ? "other" : "read-only";
  if (READ_ONLY_TOOLS.has(toolName)) return "read-only";
  return "other";
}

/** A simple command as the reader split it off. */
interface SimpleCommand {
  readonly words: readonly string[];
  /** Its input is the previous command's output (`|` or `|&`). */
  readonly piped: boolean;
  /** It redirects output into a file other than /dev/null. */
  readonly writesFile: boolean;
}

/** Output targets a redirect may name without writing a file. */
const HARMLESS_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/** The simple commands in `command`, or `undefined` when the reader cannot follow it. */
function simpleCommands(command: string): SimpleCommand[] | undefined {
  const commands: SimpleCommand[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let piped = false;
  let writesFile = false;
  // What the next word is: an argument, a redirect's target, or a heredoc's delimiter.
  let next: "word" | "output" | "input" | "heredoc" = "word";
  const heredocs: string[] = [];

  const endWord = () => {
    if (!inWord) return;
    if (next === "output") { if (!HARMLESS_TARGETS.has(word)) writesFile = true; }
    else if (next === "heredoc") heredocs.push(word);
    else if (next === "word") words.push(word);
    next = "word";
    word = "";
    inWord = false;
  };
  const endCommand = (pipeNext: boolean) => {
    endWord();
    if (words.length > 0 || writesFile) commands.push({ words, piped, writesFile });
    words = [];
    writesFile = false;
    piped = pipeNext;
  };

  let i = 0;
  while (i < command.length) {
    const char = command[i]!;
    const ahead = command[i + 1];
    if (char === "\\") {
      if (ahead === "\n") { i += 2; continue; }
      if (ahead === undefined) return undefined;
      word += ahead; inWord = true; i += 2; continue;
    }
    if (char === "'") {
      const close = command.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += command.slice(i + 1, close); inWord = true; i = close + 1; continue;
    }
    if (char === "\"") {
      let j = i + 1;
      let text = "";
      for (; j < command.length && command[j] !== "\""; j++) {
        const inner = command[j]!;
        if (inner === "\\" && j + 1 < command.length) { text += command[j + 1]; j++; continue; }
        // Command substitution inside double quotes runs a command this reader cannot split off.
        if (inner === "`" || (inner === "$" && command[j + 1] === "(")) return undefined;
        text += inner;
      }
      if (j >= command.length) return undefined;
      word += text; inWord = true; i = j + 1; continue;
    }
    if (char === "#" && !inWord) {
      const end = command.indexOf("\n", i);
      i = end < 0 ? command.length : end;
      continue;
    }
    if (char === "\n") {
      endCommand(false);
      i++;
      // A heredoc's body follows the line that opened it, up to its delimiter.
      for (const delimiter of heredocs.splice(0)) {
        while (i < command.length) {
          const end = command.indexOf("\n", i);
          const line = command.slice(i, end < 0 ? command.length : end);
          i = end < 0 ? command.length : end + 1;
          if (line.trim() === delimiter) break;
        }
      }
      continue;
    }
    if (char === " " || char === "\t") { endWord(); i++; continue; }
    if (char === "|") {
      if (ahead === "|") { endCommand(false); i += 2; continue; }
      endCommand(true);
      i += ahead === "&" ? 2 : 1;
      continue;
    }
    if (char === "&") {
      if (ahead === ">") {
        endWord(); next = "output"; i += command[i + 2] === ">" ? 3 : 2; continue;
      }
      endCommand(false);
      i += ahead === "&" ? 2 : 1;
      continue;
    }
    if (char === ";" || char === "(" || char === ")" || char === "`") { endCommand(false); i++; continue; }
    if (char === "$" && ahead === "(") { endCommand(false); i += 2; continue; }
    if (char === ">") {
      // A file descriptor right before it (`2>`) is part of the redirect, not a word.
      if (inWord && /^\d+$/.test(word)) { word = ""; inWord = false; } else endWord();
      i += ahead === ">" || ahead === "|" ? 2 : 1;
      // `>&2` duplicates a descriptor; nothing is written.
      if (command[i] === "&") {
        i++;
        while (i < command.length && /[\d-]/.test(command[i]!)) i++;
        continue;
      }
      next = "output";
      continue;
    }
    if (char === "<") {
      if (inWord && /^\d+$/.test(word)) { word = ""; inWord = false; } else endWord();
      if (ahead === "<" && command[i + 2] === "<") { next = "input"; i += 3; continue; }
      if (ahead === "<") { next = "heredoc"; i += command[i + 2] === "-" ? 3 : 2; continue; }
      if (ahead === "&") { i += 2; while (i < command.length && /[\d-]/.test(command[i]!)) i++; continue; }
      next = "input";
      i++;
      continue;
    }
    word += char;
    inWord = true;
    i++;
  }
  if (next !== "word" && !inWord) return undefined;
  endCommand(false);
  return commands;
}

/** A simple command's kind; `undefined` for one that does nothing on its own, such as `cd` or `echo`. */
type CommandKind = BashCommandKind | undefined;

/** Commands that only move around or print, and words that close shell syntax. */
const NEUTRAL = new Set(["cd", "pushd", "popd", "echo", "printf", "true", "false", ":", "set", "export", "unset", "sleep", "wait", "exit",
  "for", "fi", "done", "}"]);
/** Words that open shell syntax or time a command: the command follows them. */
const PREFIXES = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "time", "command", "nohup"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The words from the command's name on: without leading assignments, syntax words and wrappers such as `env`. */
function commandWords(words: readonly string[]): readonly string[] {
  let rest = words;
  for (;;) {
    const [first, ...others] = rest;
    if (first === undefined) return rest;
    if (ASSIGNMENT.test(first) || PREFIXES.has(first)) { rest = others; continue; }
    if (first === "env" && others.length > 0) { rest = afterOptions(others); continue; }
    if (first === "timeout") { rest = afterOptions(others, ["-s", "--signal", "-k", "--kill-after"]).slice(1); continue; }
    return rest;
  }
}

/** `args` from the first word that is not an option; `withValue` names options whose value follows them. */
function afterOptions(args: readonly string[], withValue: readonly string[] = []): readonly string[] {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) index += withValue.includes(args[index]!) ? 2 : 1;
  return args.slice(index);
}

/** Whether one of `args` is one of `options`: exactly, a long one with `=value`, or a short one with its value attached (`-i.bak`). */
function hasOption(args: readonly string[], options: readonly string[]): boolean {
  return args.some((arg) => options.some((option) => arg === option ||
    (option.startsWith("--") ? arg.startsWith(`${option}=`) : option.length === 2 && !arg.startsWith("--") && arg.startsWith(option))));
}

/** The positional arguments: every word that is not an option. */
function positional(args: readonly string[]): readonly string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}

/** Options and script names that make a checker rewrite files: `--fix`, `--write`, `format`, `lint:fix`. */
const WRITES_FILES = /fix|format|write/i;
function optionWritesFiles(args: readonly string[]): boolean {
  return args.some((arg) => arg.startsWith("-") && WRITES_FILES.test(arg));
}

/** Read-only commands, with the options that would make them write. */
const READ_ONLY_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  rg: [], grep: [], egrep: [], fgrep: [], ag: [], ack: [], ls: [], tree: [], cat: [], bat: [], head: [], tail: [], less: [], more: [],
  wc: [], file: [], stat: [], du: [], df: [], pwd: [], which: [], whereis: [], type: [], cut: [], tr: [], nl: [], column: [],
  jq: [], diff: [], cmp: [], comm: [], basename: [], dirname: [], realpath: [], readlink: [], date: [], printenv: [], env: [],
  uname: [], whoami: [], id: [], hostname: [], xxd: [], hexdump: [], od: [], strings: [], md5: [], md5sum: [], shasum: [],
  sha1sum: [], sha256sum: [], test: [], "[": [], ps: [], uniq: [], tokei: [], cloc: [],
  sort: ["-o", "--output"],
  awk: ["-i", "--include"], gawk: ["-i", "--include"],
  fd: ["-x", "-X", "--exec", "--exec-batch"],
};

/** Build and test tools that build, test or check as they are. */
const BUILD_TEST_COMMANDS = new Set(["tsc", "vitest", "jest", "mocha", "ava", "pytest", "py.test", "tox", "nox", "mypy", "pyright",
  "eslint", "shellcheck", "make", "gmake", "ninja", "rspec"]);
/** Build and test tools, and the subcommands that build, test or check. */
const BUILD_TEST_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  cargo: ["build", "test", "check", "clippy", "bench", "doc"],
  go: ["build", "test", "vet"],
  dotnet: ["build", "test"],
  swift: ["build", "test"],
  deno: ["test", "check", "lint"],
  gradle: ["build", "test", "check", "assemble"], gradlew: ["build", "test", "check", "assemble"],
  mvn: ["test", "verify", "compile", "package"], mvnw: ["test", "verify", "compile", "package"],
  playwright: ["test"], cypress: ["run"], xcodebuild: ["build", "test"], rake: ["test", "spec"],
  ruff: ["check"], biome: ["check", "lint", "ci"],
};

/** A simple command's kind. */
function commandKind(words: readonly string[]): CommandKind {
  const [first, ...args] = commandWords(words);
  if (first === undefined) return undefined;
  // A command named by a variable could be anything.
  if (first.includes("$")) return "unrecognised";
  if (NEUTRAL.has(first)) return undefined;
  const name = basename(first);
  if (name === "git") return gitKind(args);
  if (name === "find") return findKind(args);
  if (name === "xargs") return commandKind(afterOptions(args, ["-I", "-J", "-L", "-n", "-P", "-s", "-d", "-E", "-a"]));
  if (name === "sed") return args.some((arg) => /^-[^-]*i/.test(arg) || arg.startsWith("--in-place")) ? "unrecognised" : "read-only";
  if (name === "tee") return positional(args).every((arg) => HARMLESS_TARGETS.has(arg)) ? "read-only" : "unrecognised";
  const writeOptions = READ_ONLY_COMMANDS[name];
  if (writeOptions !== undefined) return hasOption(args, writeOptions) ? "unrecognised" : "read-only";
  if (name === "npx" || name === "bunx") return commandKind(afterOptions(args)) ?? "unrecognised";
  if (name === "npm" || name === "pnpm" || name === "yarn" || name === "bun") return packageManagerKind(name, args);
  if (name === "bundle" || name === "uv" || name === "poetry") {
    return args[0] === "exec" || args[0] === "run" ? commandKind(args.slice(1)) ?? "unrecognised" : "unrecognised";
  }
  if (optionWritesFiles(args)) return "unrecognised";
  if (name === "node") return hasOption(args.slice(0, args.length - afterOptions(args).length), ["--test", "--check"]) ? "build-test" : "unrecognised";
  if (name === "python" || name === "python3") {
    return args[0] === "-m" && ["pytest", "unittest", "mypy", "compileall"].includes(args[1] ?? "") ? "build-test" : "unrecognised";
  }
  if (name === "make" || name === "gmake") return positional(args).some((target) => WRITES_FILES.test(target)) ? "unrecognised" : "build-test";
  if (BUILD_TEST_COMMANDS.has(name)) return "build-test";
  if (name === "cmake") return args.includes("--build") ? "build-test" : "unrecognised";
  if (name === "prettier") return hasOption(args, ["--check", "-c"]) ? "build-test" : "unrecognised";
  const subcommands = BUILD_TEST_SUBCOMMANDS[name];
  return subcommands !== undefined && subcommands.includes(positional(args)[0] ?? "") ? "build-test" : "unrecognised";
}

/** Script names a package manager runs as a build or test: `test`, `build`, `typecheck`, `lint:types` and similar. */
const BUILD_TEST_SCRIPT = /^(test|tests|build|typecheck|type-check|types|tsc|lint|check|compile|verify)([:-][\w:.-]*)?$/i;

/** npm, pnpm, yarn and bun: a test run, or a script that builds or tests. */
function packageManagerKind(name: string, args: readonly string[]): BashCommandKind {
  if (optionWritesFiles(args)) return "unrecognised";
  const [subcommand, ...rest] = positional(args);
  if (subcommand === "test" || subcommand === "t") return "build-test";
  if (subcommand === "exec" || subcommand === "dlx" || subcommand === "x") return commandKind(rest) ?? "unrecognised";
  // pnpm, yarn and bun run a script named directly; npm needs `run`.
  const script = subcommand === "run" || subcommand === "run-script" ? rest[0] : name === "npm" ? undefined : subcommand;
  return script !== undefined && BUILD_TEST_SCRIPT.test(script) && !WRITES_FILES.test(script) ? "build-test" : "unrecognised";
}

/** The kind of a git command, after git's own options. */
function gitKind(args: readonly string[]): BashCommandKind {
  const [subcommand = "", ...options] = afterOptions(args, ["-C", "-c"]);
  // branch and tag list without a name, or with a listing option; with a name, or a changing option, they change the repository.
  const listsOnly = (listing: readonly string[], changing: readonly string[]): BashCommandKind =>
    !hasOption(options, changing) && (positional(options).length === 0 || hasOption(options, listing)) ? "read-only" : "version-control";
  switch (subcommand) {
    case "log": case "show": case "diff": case "status": case "blame": case "annotate": case "grep": case "ls-files": case "ls-tree":
    case "ls-remote": case "rev-parse": case "rev-list": case "describe": case "shortlog": case "cat-file": case "show-ref":
    case "show-branch": case "whatchanged": case "merge-base": case "name-rev": case "for-each-ref": case "count-objects":
    case "check-ignore": case "check-attr": case "var": case "help": case "version":
      return "read-only";
    case "reflog":
      return options[0] === "expire" || options[0] === "delete" ? "version-control" : "read-only";
    case "branch":
      return listsOnly(["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
        ["-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy", "-u", "--set-upstream-to", "--unset-upstream",
          "-f", "--force", "--edit-description"]);
    case "tag":
      return listsOnly(["-l", "--list", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged"],
        ["-d", "--delete", "-a", "--annotate", "-s", "--sign", "-m", "--message", "-f", "--force", "-F", "--file"]);
    case "remote":
      return options.every((option) => option === "-v" || option === "--verbose") || options[0] === "show" || options[0] === "get-url"
        ? "read-only" : "version-control";
    case "stash":
      return options[0] === "list" || options[0] === "show" ? "read-only" : "version-control";
    case "worktree":
      return options[0] === "list" ? "read-only" : "version-control";
    case "config":
      return hasOption(options, ["--get", "--get-all", "--get-regexp", "-l", "--list"]) ? "read-only" : "unrecognised";
    case "add": case "commit": case "push": case "pull": case "fetch": case "merge": case "rebase": case "cherry-pick": case "revert":
    case "reset": case "restore": case "checkout": case "switch": case "am": case "apply": case "rm": case "mv": case "clean":
    case "init": case "clone":
      return "version-control";
    default:
      return "unrecognised";
  }
}

/** find is read-only unless it deletes, writes a file, or runs a command that is not read-only. */
function findKind(args: readonly string[]): BashCommandKind {
  if (hasOption(args, ["-delete", "-fprint", "-fprint0", "-fprintf", "-fls"])) return "unrecognised";
  for (let index = 0; index < args.length; index++) {
    if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[index]!)) continue;
    const end = args.findIndex((arg, at) => at > index && (arg === ";" || arg === "+"));
    if (commandKind(args.slice(index + 1, end < 0 ? args.length : end)) !== "read-only") return "unrecognised";
    if (end < 0) break;
    index = end;
  }
  return "read-only";
}

/** Which kind wins when a command holds several: the one that does the most, for the budget and the edit check alike. */
const STRENGTH: readonly BashCommandKind[] = ["build-test", "read-only", "version-control", "unrecognised"];

/** The kind of a whole bash command. */
export function classifyBashCommand(command: string): BashCommandKind {
  const commands = simpleCommands(command);
  if (commands === undefined || commands.length === 0) return "unrecognised";
  let strongest = -1;
  for (const simple of commands) {
    const kind = simple.writesFile ? "unrecognised" : commandKind(simple.words);
    if (kind === undefined) continue;
    // A read-only filter after a pipe adds nothing to the command before it.
    if (simple.piped && kind === "read-only") continue;
    strongest = Math.max(strongest, STRENGTH.indexOf(kind));
  }
  // Only commands like `cd` and `echo`: nothing that changes anything.
  return STRENGTH[strongest] ?? "read-only";
}
