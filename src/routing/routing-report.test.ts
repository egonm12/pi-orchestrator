import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  fixtureClassification,
  fixtureRefusal,
  fixtureRoute,
  fixtureTierMap,
  HAIKU,
  OPUS,
  SONNET,
} from "../fixtures/routing-decision.ts";
import type { RiskTier } from "./classifier.ts";
import { appendRoutingRecord, buildExplicitModelRecord, NODE_RECORD_FOLDER_READER, writeDecisionRecord, type DecisionRecordInput, type RecordFolderReader } from "./decision-record.ts";
import { buildRoutingReport, renderRoutingReport } from "./routing-report.ts";
import { attachVerdict } from "./verdicts.ts";

// Ticket 25, story 33. Seam: the report CLI's stdout, over a temp folder of
// known records written by the real writer and verdict attach.

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const CLI = join(HERE, "routing-report.ts");

interface Known {
  readonly home: string;
  readonly records: string;
  cleanup(): void;
}

/**
 * The known folder, over two days:
 *
 *   id   day  mode    classified  route                      hand-picked  verdict
 *   d1   1    live    standard    standard sonnet:medium     -            accept
 *   d2   1    shadow  standard    standard sonnet:medium     sonnet       request_changes
 *   d3   1    shadow  standard    standard sonnet:medium     opus         (none)
 *   d4   2    shadow  standard    elevated opus:high         opus         missing
 *   d5   2    live    mechanical  mechanical haiku:low       -            accept, then request_changes
 *   d6   2    shadow  elevated    refused                    opus         (none)
 *   o1, o2    orphaned verdicts; o1 twice
 *
 * The second tier map holds only a Codex rung in standard, so d4 escalates.
 */
async function knownFolder(): Promise<Known> {
  // Canonical once: on macOS the default TMPDIR is under /var, a symlink to
  // /private/var, and Node's permission model checks a path as given. The CLI
  // argument, the expected output and the --allow-fs-read list must therefore
  // share this one spelling.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-routing-report-")));
  const records = join(home, "routing");
  const ledger = join(home, "refresh-state.json");
  const day1 = new Date("2026-09-25T09:00:00.000Z");
  const day2 = new Date("2026-09-26T09:00:00.000Z");
  const later = (day: Date) => new Date(day.getTime() + 60 * 60 * 1000);
  const tierMap = fixtureTierMap();
  const onlyCodexStandard = fixtureTierMap({
    orchestrator: {
      routing: {
        enabled: true,
        tiers: {
          mechanical: [`${HAIKU}:low`],
          standard: ["openai-codex/gpt-6-luna:medium"],
          elevated: [`${OPUS}:high`],
          critical: [`${OPUS}:xhigh`],
        },
      },
    },
  });
  const decide = async (
    attemptId: string,
    at: Date,
    tier: RiskTier,
    extra: Partial<DecisionRecordInput> & { mode?: "live" | "shadow"; handPickedModel?: string },
  ) => {
    writeDecisionRecord(records, {
      attemptId,
      at,
      mode: "live",
      taskText: `task ${attemptId}`,
      agentRole: "worker",
      classification: await fixtureClassification(`task ${attemptId}`, tier),
      tierMap,
      route: fixtureRoute(tier, tierMap),
      ...extra,
    } as DecisionRecordInput);
  };
  await decide("d1", day1, "standard", {});
  await decide("d2", day1, "standard", { mode: "shadow", handPickedModel: SONNET });
  await decide("d3", day1, "standard", { mode: "shadow", handPickedModel: OPUS });
  await decide("d4", day2, "standard", { mode: "shadow", handPickedModel: OPUS, tierMap: onlyCodexStandard, route: fixtureRoute("standard", onlyCodexStandard) });
  await decide("d5", day2, "mechanical", {});
  await decide("d6", day2, "elevated", { mode: "shadow", handPickedModel: OPUS, route: fixtureRefusal("elevated", tierMap) });
  const attach = (attemptId: string, verdict: "accept" | "request_changes" | "missing", at: Date) =>
    attachVerdict({ recordDir: records, attemptId, verdict, at, refreshStatePath: ledger });
  attach("d1", "accept", later(day1));
  attach("d2", "request_changes", later(day1));
  attach("d4", "missing", later(day2));
  attach("d5", "accept", later(day2));
  attach("d5", "request_changes", later(later(day2)));
  attach("o1", "accept", later(day1));
  attach("o1", "accept", later(day2));
  attach("o2", "request_changes", later(day2));
  return { home, records, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Hand-computed from the table above. A second verdict for one attempt id
 *  replaces the first, as in the ledger (d5 counts as request_changes). */
function expectedReport(folder: string): string {
  return [
    `routing report for ${folder}`,
    "tier mechanical, rung anthropic/claude-haiku-4-5:low: decisions 1, accept 0, request_changes 1, missing 0, shadow agreement n/a (no shadow decisions)",
    "tier standard, rung anthropic/claude-sonnet-5:medium: decisions 3, accept 1, request_changes 1, missing 0, shadow agreement 1 of 2 (50%)",
    "tier elevated, rung anthropic/claude-opus-5:high: decisions 1, accept 0, request_changes 0, missing 1, shadow agreement 1 of 1 (100%)",
    "tier elevated, refused: decisions 1, accept 0, request_changes 0, missing 0, shadow agreement 0 of 1 (0%)",
    "all: decisions 6, accept 1, request_changes 2, missing 1, shadow agreement 2 of 4 (50%)",
    "orphaned verdicts: 2",
    "",
  ].join("\n");
}

test("the report on a folder of known records prints decisions, verdicts by kind, orphans and shadow agreement per tier and rung", async () => {
  const known = await knownFolder();
  try {
    const run = spawnSync(process.execPath, [CLI, known.records], { encoding: "utf8", cwd: REPO, timeout: 30_000 });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.equal(run.stdout, expectedReport(known.records));
    // The same through the functions, so the npm script and the module agree.
    assert.equal(renderRoutingReport(known.records, buildRoutingReport(known.records)), expectedReport(known.records));
  } finally {
    known.cleanup();
  }
});

test("an explicit-model record (ticket 27) is neither a decision row nor an orphaned verdict", async () => {
  const known = await knownFolder();
  try {
    appendRoutingRecord(known.records, buildExplicitModelRecord({
      attemptId: "e1", at: new Date("2026-09-26T10:00:00.000Z"), mode: "live", slot: "model",
      model: "anthropic/claude-opus-5-5:high", taskText: "Review the change", agentRole: "reviewer",
    }));
    assert.equal(renderRoutingReport(known.records, buildRoutingReport(known.records)), expectedReport(known.records));
  } finally {
    known.cleanup();
  }
});

test("the report reads only files inside the record folder", async () => {
  const known = await knownFolder();
  try {
    const read: string[] = [];
    const recording: RecordFolderReader = {
      readdir: (dir) => {
        read.push(dir);
        return NODE_RECORD_FOLDER_READER.readdir(dir);
      },
      readFile: (path) => {
        read.push(path);
        return NODE_RECORD_FOLDER_READER.readFile(path);
      },
    };
    assert.equal(renderRoutingReport(known.records, buildRoutingReport(known.records, recording)), expectedReport(known.records));
    assert.deepEqual(read, [known.records, join(known.records, "2026-09-25.jsonl"), join(known.records, "2026-09-26.jsonl")]);

    // The CLI under Node's permission model: file reads are allowed only for
    // the record folder and the report's own module source, with HOME and the
    // agent dir pointed at an empty folder. A read anywhere else (settings,
    // the ledger beside the folder, the real agent dir) would fail the run.
    const emptyHome = join(known.home, "empty-home");
    mkdirSync(emptyHome);
    const allowed = [
      known.records,
      join(realpathSync(REPO), "package.json"),
      ...["routing-report.ts", "decision-record.ts", "classifier.ts", "skip-reasons.ts"].map((file) => join(realpathSync(HERE), file)),
    ];
    const run = spawnSync(
      process.execPath,
      ["--permission", ...allowed.map((path) => `--allow-fs-read=${path}`), CLI, known.records],
      {
        encoding: "utf8",
        cwd: REPO,
        timeout: 30_000,
        env: { PATH: process.env.PATH, HOME: emptyHome, PI_CODING_AGENT_DIR: join(emptyHome, ".pi", "agent") },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, expectedReport(known.records));

    // And the permission model does bite: a folder outside the allowed paths
    // is refused rather than read.
    const outside = join(known.home, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "2026-09-25.jsonl"), readFileSync(join(known.records, "2026-09-25.jsonl")));
    const refused = spawnSync(
      process.execPath,
      ["--permission", ...allowed.map((path) => `--allow-fs-read=${path}`), CLI, outside],
      { encoding: "utf8", cwd: REPO, timeout: 30_000, env: { PATH: process.env.PATH, HOME: emptyHome } },
    );
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /ERR_ACCESS_DENIED|permission/i);
  } finally {
    known.cleanup();
  }
});

test("the report CLI refuses a missing folder argument and an invalid record, naming the field", async () => {
  const known = await knownFolder();
  try {
    const none = spawnSync(process.execPath, [CLI], { encoding: "utf8", cwd: REPO, timeout: 30_000 });
    assert.equal(none.status, 2);
    assert.match(none.stderr, /usage: .*routing-report\.ts <folder>/);

    const file = join(known.records, "2026-09-25.jsonl");
    const [first, ...rest] = readFileSync(file, "utf8").split("\n");
    const broken = JSON.parse(first!) as Record<string, unknown>;
    delete broken.agentRole;
    writeFileSync(file, [JSON.stringify(broken), ...rest].join("\n"));
    const invalid = spawnSync(process.execPath, [CLI, known.records], { encoding: "utf8", cwd: REPO, timeout: 30_000 });
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /2026-09-25\.jsonl:1: field 'agentRole' is missing/);
  } finally {
    known.cleanup();
  }
});
