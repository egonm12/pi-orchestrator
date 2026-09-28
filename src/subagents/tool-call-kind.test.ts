import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyBashCommand, classifyToolCall, gitSubcommands, type BashCommandKind } from "./tool-call-kind.ts";

// What a tool call is, for the exploration budget (ADR 0005) and for telling
// whether a worker edited (ADR 0010): a kind, never a yes or no, so each
// caller draws its own line.

function assertBash(kind: BashCommandKind, commands: readonly string[]): void {
  for (const command of commands) assert.equal(classifyBashCommand(command), kind, command);
}

test("searches, listings, reads and git's read-only subcommands are read-only", () => {
  assertBash("read-only", [
    "rg foo src",
    "grep -rn 'isOrchestratorSession' src --include=*.ts",
    "find src -name '*.test.ts'",
    "ls -la",
    "cat README.md",
    "head -40 src/subagents/extension.ts",
    "wc -l src/**/*.ts",
    "sed -n 1,80p src/init/setup.ts",
    "jq .version package.json",
    "git log --oneline -5",
    "git show HEAD --stat",
    "git diff main...HEAD -- src",
    "git status --short",
    "git blame -L 10,20 README.md",
    "git branch -a",
    "git stash list",
    "git -C ../other --no-pager log -1",
    "/usr/bin/grep foo bar.txt",
    "pwd",
  ]);
});

test("builds, tests, type checks and lints are build-test", () => {
  assertBash("build-test", [
    "npm test",
    "npm run typecheck",
    "npm run build",
    "pnpm test",
    "yarn lint",
    "bun test",
    "node --test src/subagents/tool-call-kind.test.ts",
    "npx tsc --noEmit",
    "tsc -p .",
    "vitest run",
    "pytest -x tests/",
    "python3 -m pytest",
    "cargo test --all",
    "go test ./...",
    "make",
    "CI=1 npm test",
  ]);
});

test("commits, pushes and other changes to the repository are version-control", () => {
  assertBash("version-control", [
    "git commit -m 'feat: Add the budget'",
    "git push origin main",
    "git add -A",
    "git -C repo commit --amend --no-edit",
    "git checkout -- README.md",
    "git branch feature/budget",
    "git tag v1.0.0",
    "git stash",
    "git rebase -i HEAD~3",
  ]);
});

test("anything else, and anything that writes a file, is unrecognised", () => {
  assertBash("unrecognised", [
    "rm -rf dist",
    "sed -i 's/a/b/' README.md",
    "sed -i.bak 's/a/b/' README.md",
    "rg foo > matches.txt",
    "cat src/a.ts >> src/b.ts",
    "echo hello > notes.md",
    "ls | tee listing.txt",
    "find . -name '*.tmp' -delete",
    "npm install left-pad",
    "npm run format",
    "npm run lint -- --fix",
    "python3 script.py",
    "curl -X POST https://example.com",
    "$EDITOR README.md",
    "sort -o out.txt in.txt",
    "git config user.name owner",
    "unknown-tool --flag",
    "",
  ]);
});

test("a chain is as strong as its strongest part", () => {
  assertBash("read-only", ["cd src && rg foo", "cd dir; ls -la", "echo '---' && git log -1", "rg foo 2>/dev/null"]);
  assertBash("build-test", ["cd pkg && npm test", "npm run typecheck && npm test"]);
  assertBash("version-control", [
    "git add -A && git commit -m 'x'",
    "git add -A && git status && git commit -m 'x'",
    "npm test && git commit -am 'x' && git push",
  ]);
  assertBash("unrecognised", ["rg foo; rm notes.md", "npm test && sed -i 's/a/b/' x.ts", "cd dir && ./deploy.sh"]);
  // A search next to a build still explores.
  assertBash("read-only", ["rg foo && npm test"]);
});

test("a pipeline takes its first command's kind; a filter only makes it stronger", () => {
  assertBash("build-test", ["npm test 2>&1 | tail -20", "npm test 2>&1 | grep -c fail", "cargo build |& head"]);
  assertBash("read-only", ["git log --oneline | head -5", "rg -l foo | xargs grep bar", "find src -name '*.ts' | sort | uniq"]);
  assertBash("unrecognised", ["rg -l foo | xargs rm", "cat script.sh | sh", "npm test | tee test.log"]);
});

test("quotes, redirects to /dev/null, heredocs and command substitution are read sensibly", () => {
  assertBash("read-only", [
    "rg 'a && b > c' src",
    "grep \"x | y\" file",
    "npm test >/dev/null 2>&1 && git status",
    "cat <<'EOF' | grep foo\nrm -rf /\nEOF",
    "wc -l $(git ls-files)",
    "find src -name '*.ts' -exec grep -l foo {} \\;",
  ]);
  assertBash("unrecognised", [
    "cat > src/new.ts <<'EOF'\nexport const x = 1;\nEOF",
    "echo $(rm -rf dist)",
    "rg \"$(rm -rf dist)\"",
    "rg 'unterminated",
    "find . -exec rm {} \\;",
  ]);
});

test("each tool is classified by its name, and bash by its command", () => {
  const kinds = (calls: readonly [string, unknown][]) => calls.map(([name, input]) => classifyToolCall(name, input));
  assert.deepEqual(kinds([
    ["read", { path: "README.md" }], ["grep", { pattern: "x" }], ["find", { pattern: "*.ts" }], ["ls", {}],
    ["web_search", { query: "pi" }], ["fetch_content", { url: "https://pi.dev" }], ["get_search_content", { responseId: "r" }],
    ["source_check", { claim: "c" }], ["ctx_execute", { language: "shell", code: "rm -rf x" }], ["ctx_execute_file", {}],
    ["ctx_search", {}], ["ctx_batch_execute", {}], ["ctx_fetch_and_index", {}],
    ["mcp", { tool: "linear_list_issues" }], ["mcp", { search: "issues" }], ["mcp", {}], ["mcpScript", { code: "emit(1)" }],
  ]), Array(17).fill("read-only"));
  assert.deepEqual(kinds([["edit", { path: "a" }], ["write", { path: "a" }]]), ["edit", "edit"]);
  assert.deepEqual(kinds([["subagents", { items: [] }], ["subagents_status", {}], ["subagents_message", {}], ["subagents_verdict", {}]]),
    Array(4).fill("delegation"));
  assert.deepEqual(kinds([
    ["bash", { command: "rg foo" }], ["bash", { command: "npm test" }], ["bash", { command: "git push" }], ["bash", { command: "rm x" }],
  ]), ["read-only", "build-test", "version-control", "unrecognised"]);
  // An mcp install or sign-in is an action, and a tool the classification does not know is neither.
  assert.deepEqual(kinds([
    ["mcp", { action: "install", url: "https://example.com/mcp" }], ["mcp", { action: "auth-start", server: "s" }],
    ["mcp", { action: "auth-complete", server: "s" }], ["report", { kind: "progress", text: "x" }], ["create_goal", {}],
  ]), ["other", "other", "other", "other", "other"]);
  // A bash call without a command string is not recognised.
  assert.deepEqual(kinds([["bash", {}], ["bash", undefined], ["powershell", { command: "Get-ChildItem" }]]), ["unrecognised", "unrecognised", "unrecognised"]);
});

test("beans prime, show and list are read-only; any other beans command is unrecognised", () => {
  assertBash("read-only", ["beans prime", "beans prime 2>&1 | head -60", "beans show --json pi-orchestrator-9xq7", "beans list --json --ready -t bug"]);
  assertBash("unrecognised", ["beans update x -s completed", "beans create 'Title' -t bug", "beans archive", "beans"]);
});

test("beans' global options and their values come before the subcommand that decides the kind", () => {
  assertBash("read-only", ["beans --beans-path .beans show x", "beans --config .beans.yml list --json", "beans --beans-path=.beans prime"]);
  assertBash("unrecognised", ["beans --beans-path show update x", "beans --config list update x -s completed"]);
});

test("a command rtk runs, as its hook rewrites it, has the kind of the command it runs", () => {
  // Each is what `rtk hook claude` (rtk 0.49.0) rewrote the command in the comment to.
  assertBash("read-only", [
    "rtk git -C /repo show --stat e0abfd7", // git -C /repo show --stat e0abfd7
    "cd /repo && rtk git show --stat 5d29fa3 && rtk git status --short", // cd /repo && git show ... && git status --short
    "rtk git status --short 2>&1", // git status --short 2>&1
    "rtk rg -n foo /repo", // rg -n foo /repo
    "rtk grep -rn x .", // grep -rn x .
    "rtk wc -l src/subagents/retry.ts", // wc -l src/subagents/retry.ts
    "rtk ls -la", // ls -la
    "rtk find . -name x", // find . -name x
    "rtk read x --max-lines 5", // head -5 x
    "rtk read x --tail-lines 5", // tail -n 5 x
    "rtk diff a b", // diff a b
  ]);
  assertBash("build-test", [
    "rtk tsc --noEmit", // npx tsc --noEmit
    "rtk vitest", // npx vitest run
    "rtk cargo test", // cargo test
    "rtk pytest", // pytest
    "rtk lint src", // npx eslint src
  ]);
  assertBash("version-control", ["rtk git commit -m x", "rtk git push"]);
  assertBash("unrecognised", ["rtk run 'rm -rf dist'", "rtk init", "rtk config --create", "rtk lint --fix src", "rtk find . -delete", "rtk ls > out.txt"]);
  // The commit gate reads the git subcommand through rtk too.
  assert.deepEqual(gitSubcommands("rtk git commit -m x"), ["commit"]);
  assert.deepEqual(gitSubcommands("cd /repo && rtk git add -A && rtk git push"), ["add", "push"]);
});

test("rtk err, test, summary and proxy run a command the reader cannot follow, so, like sh -c, they are unrecognised", () => {
  // err, test and summary join their arguments with spaces and run the result
  // with sh -c; proxy splits a lone argument with spaces into a command and its
  // arguments. rtk's hook never rewrites a command to one of them.
  assertBash("unrecognised", [
    "rtk err cat x ';' rm -rf src",
    "rtk summary ls '>' notes.md",
    "rtk err cat '$(rm -rf src)'",
    "rtk proxy 'rm -rf src/cat'",
    "rtk test npm test '&&' git commit -am x",
    "rtk err npm test",
    "rtk test cargo test",
    "rtk proxy git push",
  ]);
  // The commit gate sees through them no better than through sh -c.
  const throughShell: readonly [string, string][] = [
    ["rtk proxy git push", "sh -c 'git push'"],
    ["rtk test npm test '&&' git commit -am x", "sh -c 'npm test && git commit -am x'"],
    ["rtk err git commit -m x", "sh -c 'git commit -m x'"],
  ];
  for (const [command, shell] of throughShell) assert.deepEqual(gitSubcommands(command), gitSubcommands(shell), command);
});

test("gitSubcommands names the subcommand of each git command, after git's own options, in chains and pipes", () => {
  const cases: readonly [string, readonly string[] | undefined][] = [
    ["git commit -m wip", ["commit"]],
    ["git add -A && git commit -m 'fix: a && b'", ["add", "commit"]],
    ["npm test; git push origin main", ["push"]],
    ["git log -1 | cat", ["log"]],
    ["git status || git push", ["status", "push"]],
    ["git -C ../other commit -am x", ["commit"]],
    ["git -c user.name=me -c user.email=me@x.test commit -m x", ["commit"]],
    ["git --git-dir .git --work-tree . push", ["push"]],
    ["git --no-pager -C sub push --force", ["push"]],
    ["/usr/bin/git commit", ["commit"]],
    ["cd repo && GIT_EDITOR=true git commit", ["commit"]],
    ["env GIT_AUTHOR_NAME=me git commit -m x", ["commit"]],
    ["echo HEAD | xargs git push origin", ["push"]],
    ["git commit-tree HEAD^{tree}", ["commit-tree"]],
    ["echo 'git commit'", []],
    ["rg 'git push' README.md", []],
    ["npm test", []],
    ["git commit -m \"$(date)\"", undefined],
  ];
  for (const [command, subcommands] of cases) assert.deepEqual(gitSubcommands(command), subcommands, command);
});
