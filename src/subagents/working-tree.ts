import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
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

/** How many files a snapshot reads at once. */
const READ_CONCURRENCY = 16;

/** How long before a snapshot started a file must last have changed for its
 *  hash to be cached. A write in the same timestamp tick as the read could
 *  leave the stat unchanged; git's racy-timestamp rule guards the same way. */
export const RACY_MARGIN_MS = 2_000;

/** At most this many fingerprints are cached; the least recently used goes first. */
export const FINGERPRINT_CACHE_LIMIT = 50_000;

/** A file's hash with the stat it was taken under. A later snapshot reuses
 *  the hash only when the file's stat still matches in every field. */
interface CachedPrint {
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly ino: bigint;
  readonly dev: bigint;
  readonly print: string;
}

// Workers run in the orchestrator's process and each extension gets a fresh
// module copy, so the cache is kept on the process's global object.
const CACHE = Symbol.for("pi-orchestrator.subagents.fingerprint-cache");
type ProcessGlobal = typeof globalThis & { [CACHE]?: Map<string, CachedPrint> };
const cache = (): Map<string, CachedPrint> => (globalThis as ProcessGlobal)[CACHE] ??= new Map();

/** Empties the fingerprint cache; for tests. */
export function clearFingerprintCache(): void { cache().clear(); }

/** How many fingerprints were hashed and reused; for tests and timing. */
export const fingerprintStats = { hashed: 0, reused: 0 };

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
    child.stdin?.end();
  });
}

/** The fingerprint of `file`'s content: gone, a link's target, or its bytes.
 *  A regular file's hash is reused from the cache when its stat is unchanged
 *  and it last changed `RACY_MARGIN_MS` before an earlier snapshot started. */
async function fingerprint(file: string, startedMs: number): Promise<string> {
  let stats;
  try { stats = await lstat(file, { bigint: true }); } catch { return "gone"; }
  try {
    if (stats.isSymbolicLink()) return `link:${await readlink(file)}`;
    if (!stats.isFile()) return `other:${stats.mtimeNs}`;
    if (stats.size > BigInt(HASHED_BYTES)) return `large:${stats.size}:${stats.mtimeNs}`;
    const prints = cache();
    const cached = prints.get(file);
    if (cached !== undefined && cached.size === stats.size && cached.mtimeNs === stats.mtimeNs &&
      cached.ctimeNs === stats.ctimeNs && cached.ino === stats.ino && cached.dev === stats.dev) {
      prints.delete(file);
      prints.set(file, cached);
      fingerprintStats.reused++;
      return cached.print;
    }
    const print = `file:${createHash("sha1").update(await readFile(file)).digest("hex")}`;
    fingerprintStats.hashed++;
    // The stat was taken before the read: a write during the read changes it,
    // so the next snapshot misses the cache. A file changed too recently may
    // be written again within the same timestamp tick, so it is not cached.
    const changedMs = Number(stats.mtimeNs > stats.ctimeNs ? stats.mtimeNs : stats.ctimeNs) / 1e6;
    if (changedMs < startedMs - RACY_MARGIN_MS) {
      prints.delete(file);
      prints.set(file, { size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, ino: stats.ino, dev: stats.dev, print });
      while (prints.size > FINGERPRINT_CACHE_LIMIT) prints.delete(prints.keys().next().value!);
    } else prints.delete(file);
    return print;
  } catch { return "unreadable"; }
}

/** The working tree of the repository `cwd` is in, or `undefined` when `cwd`
 *  is in no git repository, git cannot be run there or git status fails.
 *  It runs git and reads files without blocking the event loop. `startedMs`,
 *  when the snapshot counts as started, is for tests of the racy margin. */
export async function snapshotWorkingTree(cwd: string, { startedMs = Date.now() }: { readonly startedMs?: number } = {}): Promise<TreeSnapshot | undefined> {
  let root: string;
  try { root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim(); } catch { return undefined; }
  if (root === "") return undefined;
  let head: string | undefined;
  try { head = (await git(root, ["rev-parse", "-q", "--verify", "HEAD"])).trim() || undefined; } catch { head = undefined; }
  // Overlapping workers can git add or commit: git status must not take index.lock to refresh the index.
  let status: string;
  // A failed status, as a lock or a corrupt index, leaves the tree unknown: the command rule decides.
  try { status = await git(root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]); } catch { return undefined; }
  // Each entry is `XY path`, NUL-terminated; without renames there is no second path.
  const listed = status.split("\0").filter((entry) => entry.length >= 4).map((entry) => entry.slice(3));
  const prints: string[] = new Array(listed.length);
  let next = 0;
  const reader = async () => {
    while (next < listed.length) {
      const index = next++;
      prints[index] = await fingerprint(join(root, listed[index]!), startedMs);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, listed.length) }, reader));
  const paths = new Map<string, string>();
  listed.forEach((path, index) => paths.set(path, prints[index]!));
  return { root, head, paths };
}

/** The paths that differ between `before` and `after`, relative to `cwd`, in
 *  path order; `moved` when HEAD moved too, which alone is a change. */
export async function workingTreeChanges(before: TreeSnapshot, after: TreeSnapshot, cwd: string): Promise<{ readonly paths: readonly string[]; readonly moved: boolean }> {
  const changed = new Set<string>();
  for (const [path, print] of after.paths) if (before.paths.get(path) !== print) changed.add(path);
  for (const path of before.paths.keys()) if (!after.paths.has(path)) changed.add(path);
  const moved = before.head !== after.head;
  if (moved && before.head !== undefined && after.head !== undefined) {
    try {
      for (const path of (await git(after.root, ["diff", "--name-only", "-z", "--no-renames", before.head, after.head])).split("\0")) if (path !== "") changed.add(path);
    } catch { /* The earlier commit is gone; the move alone is the change. */ }
  }
  // git names the top level with symlinks resolved, as /private/var for /var on macOS.
  let from = cwd;
  try { from = realpathSync(cwd); } catch { /* cwd is gone; paths stay relative to it as given */ }
  const paths = [...changed].sort().map((path) => relative(from, join(after.root, path)) || ".");
  return { paths, moved };
}
