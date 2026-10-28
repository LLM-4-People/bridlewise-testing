/**
 * EXP435 — C16 vs C09+summary comparison.
 *
 * C16 (evict-to-0%): thr=0.50, step=0.50, largest, tfidf, NO summary.
 *   - Most token-efficient but NO conversation continuity.
 *   - At 5000 turns, context is ~1548 tokens. LLM has no idea what was discussed.
 *
 * C09+summary: thr=0.80, step=0.50, least-relevant, hybrid-boost, WITH summary.
 *   - Preserves continuity via the conversation summary.
 *   - At 5000 turns, context is ~2700 tokens. LLM knows the conversation flow.
 *
 * This script runs BOTH configs at 100 turns (for a quick comparison) and
 * compares:
 *   - Fact recall (30 probes).
 *   - Continuity (30 probes) — C16 should FAIL (no summary), C09+summary should PASS.
 *   - Flow (10 probes) — C16 should FAIL (no summary), C09+summary should PASS.
 *   - Token cost.
 *
 * The comparison shows the token cost of continuity.
 */
import { readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function runConfig(label, turns, env) {
  console.log(`\n=== Running ${label} (${turns} turns) ===`);
  const fullEnv = { ...process.env, ...env, EXP435_TURNS: String(turns), EXP435_LABEL: label };
  const proc = Bun.spawn(["node", "scripts/exp435/worker.mjs"], {
    cwd: REPO_ROOT,
    env: fullEnv,
    stdout: "pipe",
    stderr: "inherit",
  });
  // We don't have Bun, so use a different approach.
}

// Actually, let me just use the worker directly with env vars via a subprocess.
import { spawn } from "node:child_process";

function runWorker(label, turns, env) {
  return new Promise((resolve, reject) => {
    const fullEnv = { ...process.env, ...env, EXP435_TURNS: String(turns), EXP435_LABEL: label };
    const proc = spawn("node", ["scripts/exp435/worker.mjs"], {
      cwd: REPO_ROOT,
      env: fullEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => {
      if (code !== 0) {
        console.log(`${label} exited with code ${code}`);
        console.log(stderr.slice(-500));
      }
      const resultPath = join(REPO_ROOT, "results", `${label}.json`);
      try {
        const result = JSON.parse(readFileSync(resultPath, "utf8"));
        resolve(result);
      } catch (e) {
        reject(new Error(`${label} result not found: ${e.message}`));
      }
    });
  });
}

async function main() {
  const turns = Number(process.env.EXP435_CMP_TURNS ?? 100);
  console.log(`EXP435 C16 vs C09+summary comparison at ${turns} turns`);

  // C16: evict-to-0%, no summary.
  const c16 = await runWorker("C16-NOSUM", turns, {
    EXP435_THRESHOLD: "0.50",
    EXP435_STEP: "0.50",
    EXP435_TRIM_STRATEGY: "largest",
    EXP435_RETRIEVAL_STRATEGY: "tfidf",
    EXP435_ENABLE_SUMMARY: "0",
    EXP435_MIN_RECENT: "4",
  });

  // C09+summary: continuity-preserving.
  const c09sum = await runWorker("C09-SUM", turns, {
    EXP435_THRESHOLD: "0.80",
    EXP435_STEP: "0.50",
    EXP435_TRIM_STRATEGY: "least-relevant",
    EXP435_RETRIEVAL_STRATEGY: "hybrid-boost",
    EXP435_ENABLE_SUMMARY: "1",
    EXP435_MIN_RECENT: "5",
  });

  console.log("\n=== COMPARISON ===");
  console.log("Config           | C16 (evict-to-0%)          | C09+summary (continuity)");
  console.log("-----------------|---------------------------|--------------------------");
  console.log(`Fact recall      | ${c16.fact.correct}/${c16.fact.total} (${(c16.fact.pct*100).toFixed(0)}%)            | ${c09sum.fact.correct}/${c09sum.fact.total} (${(c09sum.fact.pct*100).toFixed(0)}%)`);
  console.log(`Continuity       | ${c16.continuity.correct}/${c16.continuity.total} (${(c16.continuity.pct*100).toFixed(0)}%)            | ${c09sum.continuity.correct}/${c09sum.continuity.total} (${(c09sum.continuity.pct*100).toFixed(0)}%)`);
  console.log(`Flow             | ${c16.flow.correct}/${c16.flow.total} (${(c16.flow.pct*100).toFixed(0)}%)             | ${c09sum.flow.correct}/${c09sum.flow.total} (${(c09sum.flow.pct*100).toFixed(0)}%)`);
  console.log(`Total tokens     | ${c16.metrics.totalTokens.toLocaleString()}            | ${c09sum.metrics.totalTokens.toLocaleString()}`);
  console.log(`Max in-context   | ${c16.metrics.maxInContextTokens}                  | ${c09sum.metrics.maxInContextTokens}`);
  console.log(`Trims            | ${c16.metrics.trims}                       | ${c09sum.metrics.trims}`);
  console.log(`Memory store     | ${c16.metrics.memoryStoreSize}                     | ${c09sum.metrics.memoryStoreSize}`);
  console.log(`Summary entries  | ${c16.metrics.summarySize}                        | ${c09sum.metrics.summarySize}`);

  const tokenCost = c09sum.metrics.totalTokens - c16.metrics.totalTokens;
  const tokenCostPct = (tokenCost / c16.metrics.totalTokens * 100).toFixed(0);
  console.log(`\nToken cost of continuity: +${tokenCost.toLocaleString()} tokens (+${tokenCostPct}%)`);
  console.log(`Continuity gain: C16 ${c16.continuity.pct*100}% → C09+summary ${c09sum.continuity.pct*100}%`);

  const comparison = {
    turns,
    c16: { fact: c16.fact, continuity: c16.continuity, flow: c16.flow, metrics: c16.metrics },
    c09sum: { fact: c09sum.fact, continuity: c09sum.continuity, flow: c09sum.flow, metrics: c09sum.metrics },
    tokenCost,
    tokenCostPct: Number(tokenCostPct),
  };
  writeFileSync(join(REPO_ROOT, "results", "comparison.json"), JSON.stringify(comparison, null, 2));
  console.log(`\nWritten: results/comparison.json`);
}

main().catch((e) => { console.error("ERROR:", e); process.exitCode = 1; });
