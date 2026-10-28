/**
 * BENCH ORCHESTRATOR — run every suite and emit one comparable report.
 *
 * This harness exists to be re-run, not to be run once. The whole point of
 * committing it is that "is this faster now?" becomes a command rather than
 * an argument. Three rules it enforces so the numbers stay comparable:
 *
 *   1. Machine conditions are captured before and after EVERY suite and
 *      stamped into its report. A number without its conditions is not
 *      evidence, and a slow number on a saturated box is not a defect.
 *   2. Fixtures are seeded and cached, so two runs measure the code rather
 *      than the data. Regenerate with `--rebuild-fixtures`.
 *   3. Reports are keyed by `suite/name[scale]`. Renaming a case breaks the
 *      diff, so names are part of the contract.
 *
 * Usage
 *   node --experimental-strip-types bench/run.ts                  # profile "real"
 *   node --experimental-strip-types bench/run.ts --profile heavy  # 347k messages
 *   node --experimental-strip-types bench/run.ts --only db,ledger
 *   node --experimental-strip-types bench/run.ts --rebuild-fixtures
 *   node --experimental-strip-types bench/run.ts --baseline bench/baseline.json
 *
 * Scale profiles (bench/fixtures/scale.ts):
 *   tiny   the control — roughly what the existing test suite uses
 *   real   one active user a few months in (~17k messages, ~95MB)
 *   heavy  one power user after a year (~347k messages, ~2GB), including
 *          one 20,000-message conversation as the scroll worst case
 *   fleet  50 users — the stated concurrency target
 *
 * Suites
 *   db          server/db/client.ts at scale: history reads, the OFFSET
 *               paging shape, the decrypt tax, statement compilation
 *   writepath   what one message write actually costs, decomposed, plus an
 *               fsync reality check on BOTH filesystems (measuring in
 *               os.tmpdir() is a trap — it is usually tmpfs, where fsync is
 *               free and every durability comparison is meaningless)
 *   ledger      the recording tax: recordEffect end to end, chain hashing
 *               in isolation, synchronous=FULL/NORMAL/OFF, append cost vs
 *               ledger size, and the SWEEP's read
 *   concurrency the shape question — does work overlap or serialize? Carries
 *               its own control so a "serialized" verdict cannot be a broken
 *               measurement
 *   redaction   the egress tax: what the per-response PII walk costs against
 *               the JSON.stringify it precedes, per token, and whether it is
 *               paid twice
 *   payload     wire weight of each response at scale, and what the browser
 *               downloads (needs `npm run build` for the bundle half)
 *
 * NOT covered here, deliberately: browser-side rendering and interaction
 * latency, which already have a harness — `tests/performance/profile.spec.ts`
 * driving `tests/performance/lib/perf-harness.ts` via
 * `playwright.perf.config.ts`. This orchestrator does not duplicate it.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { snapshotMachine, machineLine } from "./lib/machine.ts";
import { loadReport, diffReports, BENCH_OUT_DIR } from "./lib/report.ts";
import { SCALE_PROFILES, buildFixture } from "./fixtures/scale.ts";
import { ms } from "./lib/stats.ts";
import { DB_DIFF_ROWS_SHOWN } from "./bench-config.ts";

/** Suites in run order. Cheap and diagnostic first, so a broken run fails fast. */
const SUITES = [
  { name: "writepath", script: "bench/writepath.bench.ts", usesProfile: true },
  { name: "db", script: "bench/db.bench.ts", usesProfile: true },
  { name: "ledger", script: "bench/ledger.bench.ts", usesProfile: false },
  { name: "concurrency", script: "bench/concurrency.bench.ts", usesProfile: true },
  { name: "redaction", script: "bench/redaction.bench.ts", usesProfile: true },
  { name: "payload", script: "bench/payload.bench.ts", usesProfile: true },
] as const;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const profile = arg("--profile") ?? "real";
  const only = arg("--only")?.split(",").map((s) => s.trim());
  const rebuild = process.argv.includes("--rebuild-fixtures");
  const baselinePath = arg("--baseline");

  if (!SCALE_PROFILES[profile]) {
    console.error(
      `unknown profile "${profile}". Available: ${Object.keys(SCALE_PROFILES)
        .map((k) => `${k} (${SCALE_PROFILES[k]!.description})`)
        .join("; ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const before = snapshotMachine();
  console.log("═".repeat(78));
  console.log(`BENCH RUN · profile "${profile}" · ${SCALE_PROFILES[profile]!.description}`);
  console.log(machineLine(before));
  if (!before.quiet) {
    console.log(
      "\n  !! The machine is NOT quiet. Every number below is an UPPER BOUND that\n" +
        "     includes contention from other processes. Do not read a slow number\n" +
        "     here as a product defect — re-run on a quiet tree to attribute it.\n",
    );
  }
  console.log("═".repeat(78));

  // Build fixtures once, up front, so the per-suite timings do not include
  // generation and so a fixture failure surfaces before any measurement.
  console.log(`\nfixtures:`);
  buildFixture(profile, { rebuild });

  const selected = SUITES.filter((s) => !only || only.includes(s.name));
  const failures: string[] = [];

  for (const suite of selected) {
    console.log(`\n${"─".repeat(78)}\n▸ ${suite.name}\n${"─".repeat(78)}`);
    const args = ["--experimental-strip-types", suite.script];
    if (suite.usesProfile) args.push(profile);
    const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: process.cwd() });
    if (r.status !== 0) {
      failures.push(suite.name);
      console.error(`  suite "${suite.name}" exited ${r.status}`);
    }
  }

  const after = snapshotMachine();
  console.log(`\n${"═".repeat(78)}`);
  console.log(`machine after: ${machineLine(after)}`);
  if (before.quiet !== after.quiet) {
    console.log(
      "  !! Machine conditions CHANGED during the run — the suites are not\n" +
        "     comparable with each other. Re-run.",
    );
  }
  if (failures.length > 0) console.log(`suites that failed: ${failures.join(", ")}`);

  // Optional regression diff against a stored baseline.
  if (baselinePath) {
    const baseline = loadReport(baselinePath);
    if (!baseline) {
      console.log(`\nbaseline ${baselinePath} not found — nothing to diff against`);
    } else {
      const current = loadReport(join(BENCH_OUT_DIR, `db-${profile}.json`));
      if (current) {
        console.log(`\nregression diff vs ${baselinePath} (worst first):`);
        for (const row of diffReports(baseline, current).slice(0, DB_DIFF_ROWS_SHOWN)) {
          const mark = row.ratio > 1.2 ? "REGRESSED" : row.ratio < 0.8 ? "improved " : "         ";
          console.log(
            `  ${mark} ${row.key}: ${ms(row.baselineP95Ms)} → ${ms(row.currentP95Ms)} (${row.ratio.toFixed(2)}×)`,
          );
        }
      }
    }
  }

  console.log(`\nreports in ${BENCH_OUT_DIR}`);
  console.log("═".repeat(78));
  // The exit code is set and the loop drains: `process.exit()` can deadlock at shutdown (Node #54918, #351).
  process.exitCode = failures.length > 0 ? 1 : 0;
}

main();
