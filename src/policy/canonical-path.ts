import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// One spelling of "the same file" for every comparison in this harness.
//
// On macOS `/tmp`, `/var` and `/etc` are symlinks into `/private`, so the same
// directory is named `/var/folders/.../x` by `TMPDIR` and `/private/var/folders/.../x`
// by `realpathSync`. A write-path check comparing one form against the other
// silently matches nothing. Both sides therefore go through this function.
//
// Canonicalising cannot widen a match: two spellings that resolve to one path
// name one file, and a spelling that resolves elsewhere still compares
// unequal.

/**
 * Canonical form of a path whose leaf may not exist yet: realpath the nearest
 * existing ancestor, then re-append the remainder.
 *
 * A path with no resolvable ancestor falls back to `resolve`, which is
 * absolute and deterministic but not symlink-resolved. That is the safe
 * direction: an unresolvable path is compared literally, which can only ever
 * match less.
 */
export function canonicalPath(path: string): string {
  let dir = resolve(path);
  const parts: string[] = [];
  for (;;) {
    if (existsSync(dir)) {
      try {
        return join(realpathSync(dir), ...parts.reverse());
      } catch {
        return resolve(path);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(path);
    parts.push(dir.slice(parent.length + 1));
    dir = parent;
  }
}
