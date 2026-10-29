// Real LLM long task: N sequential chat-completion calls to gemma-4-31b
// with 429 concurrent_drain handling. N=15 → ~1-3 min, exceeding the 120s
// bash timeout when there are 429 backoffs. Writes per-call progress to
// stdout + a final result file.
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { experimentApiFromEnvironment } from "../_experiments/experiment-environment.ts";
const N = parseInt(process.argv[2] || "15", 10);
const MAX_TOKENS = parseInt(process.argv[3] || "2000", 10);
const outDir = process.argv[4];
if (outDir) { mkdirSync(outDir, { recursive: true }); }
const cfg = experimentApiFromEnvironment();
const MODEL = "gemma-4-31b";
function log(s) { console.log(`[llm-long] ${s}`); if (outDir) appendFileSync(`${outDir}/log`, s + "\n"); }
async function oneCall(i, n) {
  const body = { model: MODEL, messages: [{ role: "user", content: `Write a detailed TypeScript function #${i+1} of ${n} implementing a distinct utility (string, array, math, etc). Include JSDoc. Be thorough.` }], max_tokens: MAX_TOKENS, temperature: 0 };
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify(body),
    });
    if (res.ok) { const d = await res.json(); return { ok: true, tokens: d.usage?.completion_tokens ?? 0 }; }
    const text = await res.text().catch(() => "");
    if (res.status === 429) { const wait = Math.min(30000, 2000 * (attempt + 1) + Math.random() * 1000); log(`call ${i+1}: 429 attempt ${attempt+1} backoff ${Math.round(wait)}ms`); await new Promise(r => setTimeout(r, wait)); continue; }
    return { ok: false, status: res.status, error: text.slice(0, 200) };
  }
  return { ok: false, error: "429-budget-exhausted" };
}
log(`start N=${N} model=${MODEL} max_tokens=${MAX_TOKENS}`);
const t0 = Date.now();
let totalTokens = 0;
const results = [];
for (let i = 0; i < N; i++) {
  const c0 = Date.now();
  const r = await oneCall(i, N);
  const dt = Date.now() - c0;
  if (r.ok) { totalTokens += r.tokens; log(`call ${i+1}/${N}: ok tokens=${r.tokens} dt=${dt}ms total=${totalTokens}`); }
  else { log(`call ${i+1}/${N}: FAIL ${r.error || r.status} dt=${dt}ms`); }
  results.push({ i, ...r, dt });
}
const total = Date.now() - t0;
const ok = results.filter(r => r.ok).length;
log(`DONE N=${N} ok=${ok}/${N} totalTokens=${totalTokens} dt=${Math.round(total/1000)}s`);
if (outDir) writeFileSync(`${outDir}/result`, JSON.stringify({ ok: ok === N, totalCalls: N, okCalls: ok, totalTokens, totalMs: total, results }));
process.exitCode = ok === N ? 0 : 1;
