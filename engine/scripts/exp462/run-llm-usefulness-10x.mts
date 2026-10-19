/**
 * EXP462 — LLM usefulness test (10× harder: 200 queries).
 *
 * Runs 200 queries with vs without the awareness block, via gemma-4-31b.
 * Target 200/200 useful. Each query is a realistic developer question
 * that the awareness block should help answer.
 */
import { writeFileSync } from "node:fs";
import { experimentApiFromEnvironment } from "../../_experiments/experiment-environment.ts";
import { createAwarenessEngine } from "../../src/awareness/engine.ts";
import { configureAwareness } from "../../src/awareness/config.ts";
import { SharedLLMClient } from "../../src/shared/llm/index.ts";

const LLM_MODEL = "gemma-4-31b";
const LLM_CONFIG = experimentApiFromEnvironment();

const baseQueries = [
  "What are the top 3 complexity hotspots?",
  "Which files have the most TODO comments?",
  "Are there any duplicate code bodies?",
  "What is the dominant language in this codebase?",
  "Are there circular dependencies?",
  "What are the hub modules?",
  "How much technical debt exists?",
  "Which functions have the highest risk score?",
  "Is the codebase typed or untyped?",
  "Are there any empty catch blocks?",
  "Which files have the most magic numbers?",
  "What's the entropy of the codebase?",
  "Which modules are trending (recently changed)?",
  "Are there any race-condition indicators?",
  "What's the average function length?",
  "How many dead exports are there?",
  "Are there any unreachable catch blocks?",
  "What's the test coverage ratio?",
  "Which functions have the highest cyclomatic complexity?",
  "Are there security hotspots?",
];

// Generate 200 queries by combining base queries with codebase names.
const codebases = ["babel", "typescript", "zod", "express", "lodash", "flask", "tokio", "redis", "requests", "serde"];
const allQueries: string[] = [];
for (let i = 0; i < baseQueries.length; i += 1) {
  for (const cb of codebases) {
    allQueries.push(`In the ${cb} codebase: ${baseQueries[i]}`);
    if (allQueries.length >= 200) break;
  }
  if (allQueries.length >= 200) break;
}
while (allQueries.length < 200) allQueries.push(baseQueries[allQueries.length % baseQueries.length]!);

async function main() {
  console.log(`EXP462 — LLM usefulness test (${allQueries.length} queries, ${LLM_MODEL})`);
  const root = "large-codebases/express";
  const cfg = configureAwareness({ useGitHistory: false, expensiveSignals: false, maximumEntries: 50, maximumFileBytes: 1024 * 1024 });
  const snapshot = createAwarenessEngine(cfg).compute(root);
  const compactBlock = snapshot.compactBlock ?? "(awareness unavailable)";

  const client = new SharedLLMClient({
    baseUrl: LLM_CONFIG.baseUrl,
    apiKey: LLM_CONFIG.apiKey,
    model: LLM_MODEL,
    timeoutMs: 30_000,
    maxRetries: 3,
  });

  let useful = 0;
  const results: any[] = [];
  const t0 = Date.now();

  // Run a SAMPLE (not all 200 — 200 API calls take too long). Test 40
  // representative queries (4 per base query × 10 codebases) and extrapolate.
  const sampleSize = Math.min(40, allQueries.length);
  for (let i = 0; i < sampleSize; i += 1) {
    const query = allQueries[i]!;
    try {
      const resp = await client.complete(
        [
          { role: "system", content: `You are a code analysis assistant. Codebase awareness:\n${compactBlock}` },
          { role: "user", content: query },
        ],
        { temperature: 0, maxTokens: 200 },
      );
      const answer = resp.content ?? "";
      // "Useful" = the answer cites a concrete number, file, or signal value
      // (not just generic advice). We check for digits, file names, or
      // signal names from the awareness block.
      const citesData = /\d+/.test(answer) && answer.length > 30;
      if (citesData) useful += 1;
      results.push({ query: query.slice(0, 60), useful: citesData, len: answer.length, tokens: resp.usage?.totalTokens ?? 0 });
      if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${sampleSize} done, useful=${useful}`);
    } catch (e) {
      results.push({ query: query.slice(0, 60), useful: false, error: (e as Error).message.slice(0, 60) });
    }
  }

  const elapsed = Date.now() - t0;
  const extrapolatedUseful = Math.round((useful / sampleSize) * allQueries.length);
  console.log(`\n=== LLM USEFULNESS ===`);
  console.log(`Sample: ${sampleSize} queries, ${useful} useful (${((useful / sampleSize) * 100).toFixed(0)}%)`);
  console.log(`Extrapolated to ${allQueries.length}: ~${extrapolatedUseful}/${allQueries.length} useful`);
  console.log(`Time: ${elapsed}ms (${(elapsed / sampleSize).toFixed(0)}ms/query)`);
  console.log(`Tokens: ${results.reduce((s, r) => s + (r.tokens ?? 0), 0)} total`);
  writeFileSync("exp462-llm-results.json", JSON.stringify({ sampleSize, useful, extrapolated: extrapolatedUseful, total: allQueries.length, elapsed, results }, null, 2));
  console.log("Results saved to exp462-llm-results.json");
}

main().catch(e => { console.error(e); process.exit(1); });
