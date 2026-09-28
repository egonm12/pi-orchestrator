import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

// The working tree as editing detection compares it (pi-orchestrator-6c1p):
// a snapshot when a worker starts and one when it ends. A snapshot holds the
// repository's HEAD and every path git status names, tracked changes plus
// untracked files, with a fingerprint of its content. Ignored files are left
// out, as git leaves them out. Two snapshots differ in the paths whose
// fingerprint changed, appeared or went away, and in the paths a moved HEAD
// changed. Staging alone changes no content, so it is no difference.
//
// Each worker takes its own snapshots, so a change made while several workers
// ran shows in each of their comparisons: it counts for every one of them.

/** One moment of a repository's working tree. */
export interface TreeSnapshot {
  /** The repository's top level. */
  readonly root: string;
  /** HEAD's commit; `undefined` before the first commit. */
  readonly head: string | undefined;
  /** Each path git status names, relative to `root`, with its content's fingerprint. */
  readonly paths: ReadonlyMap<string, string>;
}

/** A file above this size is fingerprinted by its size and change time, not read. */
const HASHED_BYTES = 8 * 1024 * 1024;

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

/** The fingerprint of `file`'s content: gone, a link's target, or its bytes. */
function fingerprint(file: string): string {
  let stats;
  try { stats = lstatSync(file); } catch { return "gone"; }
  try {
    if (stats.isSymbolicLink()) return `link:${readlinkSync(file)}`;
    if (!stats.isFile()) return `other:${stats.mtimeMs}`;
    if (stats.size > HASHED_BYTES) return `large:${stats.size}:${stats.mtimeMs}`;
    return `file:${createHash("sha1").update(readFileSync(file)).digest("hex")}`;
  } catch { return "unreadable"; }
}

/** The working tree of the repository `cwd` is in, or `undefined` when `cwd`
 *  is in no git repository, git cannot be run there or git status fails. */
export function snapshotWorkingTree(cwd: string): TreeSnapshot | undefined {
  let root: string;
  try { root = git(cwd, ["rev-parse", "--show-toplevel"]).trim(); } catch { return undefined; }
  if (root === "") return undefined;
  let head: string | undefined;
  try { head = git(root, ["rev-parse", "-q", "--verify", "HEAD"]).trim() || undefined; } catch { head = undefined; }
  // Overlapping workers can git add or commit: git status must not take index.lock to refresh the index.
  let status: string;
  // A failed status, as a lock or a corrupt index, leaves the tree unknown: the command rule decides.
  try { status = git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]); } catch { return undefined; }
  const paths = new Map<string, string>();
  // Each entry is `XY path`, NUL-terminated; without renames there is no second path.
  for (const entry of status.split("\0")) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    paths.set(path, fingerprint(join(root, path)));
  }
  return { root, head, paths };
}

/** The paths that differ between `before` and `after`, relative to `cwd`, in
 *  path order; `moved` when HEAD moved too, which alone is a change. */
export function workingTreeChanges(before: TreeSnapshot, after: TreeSnapshot, cwd: string): { readonly paths: readonly string[]; readonly moved: boolean } {
  const changed = new Set<string>();
  for (const [path, print] of after.paths) if (before.paths.get(path) !== print) changed.add(path);
  for (const path of before.paths.keys()) if (!after.paths.has(path)) changed.add(path);
  const moved = before.head !== after.head;
  if (moved && before.head !== undefined && after.head !== undefined) {
    try {
      for (const path of git(after.root, ["diff", "--name-only", "-z", "--no-renames", before.head, after.head]).split("\0")) if (path !== "") changed.add(path);
    } catch { /* The earlier commit is gone; the move alone is the change. */ }
  }
  // git names the top level with symlinks resolved, as /private/var for /var on macOS.
  let from = cwd;
  try { from = realpathSync(cwd); } catch { /* cwd is gone; paths stay relative to it as given */ }
  const paths = [...changed].sort().map((path) => relative(from, join(after.root, path)) || ".");
  return { paths, moved };
}
