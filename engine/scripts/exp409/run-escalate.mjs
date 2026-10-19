/**
 * EXP409 10×-harder escalation launcher — runs the optimal combination at
 * 5000 turns (10× the 200-turn broad-sweep base) in the background.
 *
 * Binding directive: "Each time we get 100%, automatically make it 10x harder."
 *
 * Usage:
 *   node scripts/exp409/run-escalate.mjs <label> <threshold> <step> <trimStrategy> <retrievalStrategy> [turns]
 *
 * Writes:
 *   - results/<label>-ESCALATE.json (final compact result)
 *   - exp392-<label>-ESCALATE-partial.json (partial every 100 turns, written by worker)
 *   - exp392-<label>-ESCALATE.log (per-turn log)
 *
 * Designed to be launched detached (setsid/nohup) so it survives the parent
 * agent session ending. The next agent can harvest the partial/final JSON.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKER = resolve(REPO_ROOT, "scripts", "exp409", "worker.mjs");

const label = process.argv[2] ?? "C-ESCALATE";
const threshold = process.argv[3] ?? "0.5";
const step = process.argv[4] ?? "0.5";
const trimStrategy = process.argv[5] ?? "largest";
const retrievalStrategy = process.argv[6] ?? "tfidf";
const turns = process.argv[7] ?? "5000";

console.log(`EXP409 escalation — label=${label} thr=${threshold} step=${step} trim=${trimStrategy} retr=${retrievalStrategy} turns=${turns}`);
console.log(`  worker: ${WORKER}`);
console.log(`  repo:   ${REPO_ROOT}`);

const env = {
  ...process.env,
  EXP409_LABEL: label,
  EXP409_THRESHOLD: String(threshold),
  EXP409_STEP: String(step),
  EXP409_TRIM_STRATEGY: trimStrategy,
  EXP409_RETRIEVAL_STRATEGY: retrievalStrategy,
  EXP409_TURNS: String(turns),
  EXP409_PROBES_PER_CP: "10",
  // 5000 turns × ~3s/turn + retry slack = ~5h budget. Generous so it doesn't timeout.
  EXP409_WORKER_TIMEOUT_MS: String(6 * 60 * 60 * 1000),
};

const child = spawn("node", ["--experimental-strip-types", WORKER], {
  env,
  stdio: "inherit",
  detached: true,
});
// Detach so the escalation survives the parent agent session ending.
child.unref();
console.log(`  pid: ${child.pid} (detached, unref'd)`);
child.on("error", (e) => { console.error("ESCALATE ERROR:", e); process.exit(1); });
child.on("close", (code) => { console.log(`ESCALATE DONE code=${code}`); process.exit(code ?? 0); });
