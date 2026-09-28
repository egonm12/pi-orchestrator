import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** One choice and its first request/decision append are atomic across router
 * instances and processes sharing the owner's record folder. Classification
 * happens before acquiring this short-lived lock. */
export async function withRoutingChoice<T>(recordDir: string, choose: () => Promise<T>): Promise<T> {
  const lock = `${recordDir}.choice.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  const token = `${process.pid}:${randomUUID()}`;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        // A process killed while holding the lock must not block later work.
        if (Date.now() - statSync(lock).mtimeMs > 60_000) rmSync(lock, { force: true });
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      continue;
    }
    try { writeFileSync(lock, token); }
    catch (error) { rmSync(lock, { force: true }); throw error; }
    break;
  }
  try { return await choose(); }
  finally {
    try { if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
