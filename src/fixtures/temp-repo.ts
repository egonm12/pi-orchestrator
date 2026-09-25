import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepo {
  dir: string;
  cleanup(): void;
}

// Isolated, disposable git repo for lifecycle tests. Every later ticket in
// pi-orchestration-harness reuses this so runs are reproducible and leave no
// state behind (temp dir only; never the project working tree).
export function createTempRepo(): TempRepo {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "pi-harness@test.local"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "pi-orchestration-harness"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# pi-orchestration-harness temp repo\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
