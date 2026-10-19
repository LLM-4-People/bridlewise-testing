/**
 * EXP409 sweep orchestrator — context-trim percentage + step sweep.
 *
 * Defines a representative 24-combination fractional-factorial subset of the
 * 6 thresholds × 4 steps × 4 trim strategies × 4 retrieval strategies = 384
 * matrix, launches the workers in parallel (4 at a time, the LLM API's safe
 * concurrency), collects the per-combination result JSONs, ranks them, and
 * writes the consolidated `EXP409-results.json` + `EXPERIMENT.md`.
 *
 * Design: one-factor-at-a-time (OFAT) from a baseline + cross-combinations to
 * capture interactions. Baseline = (threshold 0.80, step 0.10,
 * trim least-relevant, retrieval hybrid-boost) — closest to EXP392's default.
 *
 * Binding directives:
 *   - "Test different context trim percentage and steps" — the sweep.
 *   - "Each time we get 100%, automatically make it 10x harder" — the
 *     orchestrator re-runs the optimal combination at 10× the turns if it
 *     achieves 100% recall at the base turn count (EXP409_ESCALATE=1).
 *   - "Everything dynamically computed" — all sweep params from config.
 *   - "Do not forget previous experiences findings" — EXP351 (trim),
 *     EXP378 (unified), EXP392 (infinite context).
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULTS_DIR = resolve(REPO_ROOT, "results");
const WORKER = resolve(REPO_ROOT, "scripts", "exp409", "worker.mjs");
mkdirSync(RESULTS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 24 combinations — fractional factorial (OFAT + cross).
// ---------------------------------------------------------------------------
const BASELINE = { trimThreshold: 0.80, trimStep: 0.10, trimStrategy: "least-relevant", retrievalStrategy: "hybrid-boost" };

const COMBINATIONS = [
  // --- Threshold sweep (step=0.10, trim=least-relevant, retrieval=hybrid-boost) ---
  { label: "C01", ...BASELINE, trimThreshold: 0.50 },
  { label: "C02", ...BASELINE, trimThreshold: 0.60 },
  { label: "C03", ...BASELINE, trimThreshold: 0.70 },
  { label: "C04", ...BASELINE, trimThreshold: 0.80 }, // baseline
  { label: "C05", ...BASELINE, trimThreshold: 0.90 },
  { label: "C06", ...BASELINE, trimThreshold: 0.95 },
  // --- Step sweep (threshold=0.80, trim=least-relevant, retrieval=hybrid-boost) ---
  { label: "C07", ...BASELINE, trimStep: 0.20 },
  { label: "C08", ...BASELINE, trimStep: 0.30 },
  { label: "C09", ...BASELINE, trimStep: 0.50 },
  // --- Trim strategy sweep (threshold=0.80, step=0.10, retrieval=hybrid-boost) ---
  { label: "C10", ...BASELINE, trimStrategy: "oldest" },
  { label: "C11", ...BASELINE, trimStrategy: "largest" },
  { label: "C12", ...BASELINE, trimStrategy: "random" },
  // --- Retrieval strategy sweep (threshold=0.80, step=0.10, trim=least-relevant) ---
  { label: "C13", ...BASELINE, retrievalStrategy: "tfidf" },
  { label: "C14", ...BASELINE, retrievalStrategy: "ebbinghaus" },
  { label: "C15", ...BASELINE, retrievalStrategy: "hybrid" },
  // --- Cross-combinations (interactions) ---
  { label: "C16", trimThreshold: 0.50, trimStep: 0.50, trimStrategy: "largest",    retrievalStrategy: "tfidf" },      // extreme low + big step + largest + tfidf
  { label: "C17", trimThreshold: 0.95, trimStep: 0.10, trimStrategy: "oldest",     retrievalStrategy: "ebbinghaus" }, // extreme high + small step + oldest + ebbinghaus
  { label: "C18", trimThreshold: 0.90, trimStep: 0.30, trimStrategy: "largest",     retrievalStrategy: "hybrid" },    // high + medium step + largest + hybrid
  { label: "C19", trimThreshold: 0.70, trimStep: 0.20, trimStrategy: "least-relevant", retrievalStrategy: "tfidf" }, // low-mid + small + least-relevant + tfidf
  { label: "C20", trimThreshold: 0.80, trimStep: 0.50, trimStrategy: "random",      retrievalStrategy: "ebbinghaus" }, // default + big step + random + ebbinghaus
  { label: "C21", trimThreshold: 0.60, trimStep: 0.20, trimStrategy: "oldest",      retrievalStrategy: "hybrid" },    // low + small + oldest + hybrid
  { label: "C22", trimThreshold: 0.95, trimStep: 0.50, trimStrategy: "least-relevant", retrievalStrategy: "hybrid-boost" }, // stress: very late + big trim
  { label: "C23", trimThreshold: 0.50, trimStep: 0.10, trimStrategy: "oldest",     retrievalStrategy: "ebbinghaus" }, // very early + small + oldest + ebbinghaus
  { label: "C24", trimThreshold: 0.70, trimStep: 0.30, trimStrategy: "random",     retrievalStrategy: "tfidf" },      // mid-low + medium + random + tfidf
];

// ---------------------------------------------------------------------------
// Worker launch.
// ---------------------------------------------------------------------------
const TURNS = Number(process.env.EXP409_TURNS ?? 500);
const PROBES_PER_CP = Number(process.env.EXP409_PROBES_PER_CP ?? 10);
const CONCURRENCY = Number(process.env.EXP409_CONCURRENCY ?? 4);
const ESCALATE = process.env.EXP409_ESCALATE !== "0";
const ESCALATE_TURNS = Number(process.env.EXP409_ESCALATE_TURNS ?? TURNS * 10);

function spawnWorker(combo) {
  const env = {
    ...process.env,
    EXP409_LABEL: combo.label,
    EXP409_THRESHOLD: String(combo.trimThreshold),
    EXP409_STEP: String(combo.trimStep),
    EXP409_TRIM_STRATEGY: combo.trimStrategy,
    EXP409_RETRIEVAL_STRATEGY: combo.retrievalStrategy,
    EXP409_TURNS: String(TURNS),
    EXP409_PROBES_PER_CP: String(PROBES_PER_CP),
  };
  // Per-worker wall-clock timeout (ms). 500 turns * ~2s/turn + retry slack.
  const workerTimeoutMs = Number(process.env.EXP409_WORKER_TIMEOUT_MS ?? 60 * 60 * 1000);
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn("node", ["--experimental-strip-types", WORKER], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      resolve({ combo, code: 124, stdout, stderr: stderr + `\n[TIMEOUT after ${workerTimeoutMs}ms]`, ms: Date.now() - t0 });
    }, workerTimeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ combo, code, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

async function runBatch(combos) {
  console.log(`\n=== Batch: ${combos.map((c) => c.label).join(", ")} (${TURNS}-turn each, concurrency=${CONCURRENCY}) ===`);
  const results = [];
  for (let i = 0; i < combos.length; i += CONCURRENCY) {
    const batch = combos.slice(i, i + CONCURRENCY);
    const started = Date.now();
    const settled = await Promise.allSettled(batch.map((c) => spawnWorker(c)));
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const combo = batch[j];
      if (s.status === "fulfilled") {
        const res = s.value;
        const resultPath = resolve(RESULTS_DIR, `${combo.label}.json`);
        let resultJson = null;
        try { resultJson = JSON.parse(readFileSync(resultPath, "utf8")); } catch {}
        console.log(`  ${combo.label}: code=${res.code} ms=${res.ms} recall=${resultJson?.metrics ? `${resultJson.metrics.recallCorrect}/${resultJson.metrics.recallTotal}` : "?"}`);
        results.push({ combo, code: res.code, ms: res.ms, result: resultJson, stdout: res.stdout, stderr: res.stderr });
      } else {
        console.log(`  ${combo.label}: REJECTED ${s.reason}`);
        results.push({ combo, code: -1, ms: 0, result: null, stdout: "", stderr: String(s.reason) });
      }
    }
    console.log(`  batch wall: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Rank + report.
// ---------------------------------------------------------------------------
function rank(results) {
  // Rank by: (1) overflowCount=0 required, (2) recallPct DESC, (3) totalTokens ASC,
  // (4) trims ASC, (5) retrievals ASC, (6) latencyPerTurnMs ASC.
  const valid = results.filter((r) => r.result && r.result.metrics);
  const ranked = valid.map((r) => {
    const m = r.result.metrics;
    const overflowPenalty = m.overflowCount * 1e9;
    const score = m.recallPct * 1e6 - m.totalTokens / 1e3 - m.trims - m.retrievals / 10 - m.latencyPerTurnMs / 100 - overflowPenalty;
    return { ...r, m, score };
  });
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

function fmtRow(r) {
  const m = r.m;
  const c = r.combo;
  return `  ${c.label} | thr=${c.trimThreshold} step=${c.trimStep} trim=${c.trimStrategy.padEnd(13)} retr=${c.retrievalStrategy.padEnd(12)} | recall=${m.recallCorrect}/${m.recallTotal} (${(m.recallPct * 100).toFixed(1)}%) | tok=${m.totalTokens} | trims=${m.trims} | retr=${m.retrievals} | reln=${m.relevantInjections} | lat/turn=${m.latencyPerTurnMs.toFixed(0)}ms | mem=${m.memoryStoreSize} | overflow=${m.overflowCount} | firstTrim=${m.firstTrimTurn} | maxCtx=${m.maxInContextTokens}`;
}

async function main() {
  console.log(`EXP409 context-trim sweep — ${COMBINATIONS.length} combinations, ${TURNS} turns each, concurrency=${CONCURRENCY}`);
  console.log(`  results dir: ${RESULTS_DIR}`);
  console.log(`  escalate: ${ESCALATE ? `yes (at ${ESCALATE_TURNS} turns if 100% recall)` : "no"}`);

  // Phase 1: run all 24 combinations at TURNS.
  const t0 = Date.now();
  const results = await runBatch(COMBINATIONS);
  console.log(`\nPhase 1 wall: ${((Date.now() - t0) / 1000 / 60).toFixed(1)} min`);

  const ranked = rank(results);
  console.log("\n=== RANKED (best → worst) ===");
  for (const r of ranked) console.log(fmtRow(r));

  const optimal = ranked[0];
  const worst = ranked[ranked.length - 1];
  console.log("\n=== OPTIMAL ===");
  console.log(fmtRow(optimal));
  console.log("=== WORST ===");
  console.log(fmtRow(worst));

  // Phase 2: 10× harder — re-run the optimal at ESCALATE_TURNS if it hit 100% recall.
  let escalation = null;
  if (ESCALATE && optimal && optimal.m.recallPct >= 1.0 && optimal.m.overflowCount === 0) {
    console.log(`\n=== 10× HARDER: optimal hit 100% recall — re-running at ${ESCALATE_TURNS} turns ===`);
    const escCombo = { ...optimal.combo, label: "C-ESCALATE" };
    const escResults = await runBatch([escCombo]);
    escalation = escResults[0];
    if (escalation?.result?.metrics) {
      console.log("  escalation result:");
      console.log(fmtRow({ combo: escCombo, m: escalation.result.metrics }));
    }
  } else {
    console.log(`\n=== 10× harder NOT triggered (optimal recall=${optimal?.m.recallPct ?? 0}, overflow=${optimal?.m.overflowCount ?? 0}) ===`);
  }

  // Write consolidated results.
  const summary = {
    experiment: "EXP409-context-trim-sweep",
    turns: TURNS,
    probesPerCheckpoint: PROBES_PER_CP,
    combinationsTotal: COMBINATIONS.length,
    concurrency: CONCURRENCY,
    phase1WallMs: Date.now() - t0,
    optimal: optimal ? {
      combo: optimal.combo,
      metrics: optimal.m,
      diagnostics: optimal.result.diagnostics,
      byCheckpoint: optimal.result.byCheckpoint,
    } : null,
    worst: worst ? { combo: worst.combo, metrics: worst.m } : null,
    ranked: ranked.map((r) => ({
      label: r.combo.label, combo: r.combo, metrics: r.m, score: r.score,
    })),
    escalation: escalation?.result ? {
      combo: escalation.combo, metrics: escalation.result.metrics, diagnostics: escalation.result.diagnostics,
    } : null,
  };
  writeFileSync(resolve(REPO_ROOT, "EXP409-results.json"), JSON.stringify(summary, null, 2));
  console.log(`\nWrote: ${resolve(REPO_ROOT, "EXP409-results.json")}`);
  return summary;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  main().catch((e) => { console.error("ORCH ERROR:", e); process.exit(1); });
}
