/**
 * EXP446 — LLM usefulness test (standalone).
 *
 * Runs 20 queries with vs without the awareness block, via the shared LLM
 * client (gemma-4-31b). Target 20/20 useful.
 *
 * Run: node --experimental-strip-types scripts/exp446/run-llm-usefulness.mts
 */
import { experimentApiFromEnvironment } from "../../_experiments/experiment-environment.ts";
import { createAwarenessEngine } from "../../src/awareness/engine.ts";
import { configureAwareness } from "../../src/awareness/config.ts";
import { SharedLLMClient } from "../../src/shared/llm/index.ts";

const LLM_MODEL = "gemma-4-31b";
const LLM_CONFIG = experimentApiFromEnvironment();

const queries = [
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

async function main() {
  console.log("EXP446 — LLM usefulness test");
  console.log(`  model: ${LLM_MODEL}`);
  console.log(`  queries: ${queries.length}`);

  // Compute awareness snapshot on the lodash codebase (small, fast).
  const root = "large-codebases/lodash";
  const cfg = configureAwareness({ useGitHistory: false, expensiveSignals: false, maximumEntries: 50, maximumFileBytes: 1024 * 1024 });
  const engine = createAwarenessEngine(cfg);
  const snapshot = engine.compute(root);
  const compactBlock = snapshot.compactBlock ?? "(awareness unavailable)";
  console.log(`  awareness block: ${snapshot.compactTokens ?? 0} tokens, ${compactBlock.length} chars`);

  const client = new SharedLLMClient({
    baseUrl: LLM_CONFIG.baseUrl,
    apiKey: LLM_CONFIG.apiKey,
    model: LLM_MODEL,
    maxRetries: { "rate-limit": 2, "server": 2, "network": 2 } as any,
    timeout: 30000,
    concurrency: 3,
    circuitBreaker: { threshold: 5, resetMs: 30000 },
  });

  let usefulCount = 0;
  const results: any[] = [];
  for (let i = 0; i < queries.length; i += 1) {
    const q = queries[i]!;
    console.log(`\n  [${i + 1}/${queries.length}] ${q}`);
    let withAware = "";
    let withoutAware = "";
    try {
      const r1 = await client.complete([
        { role: "system", content: `You are a code analyst. Use this awareness block to answer.\n\n${compactBlock}` },
        { role: "user", content: q },
      ], { model: LLM_MODEL, temperature: 0, maxTokens: 200 });
      withAware = (r1?.content ?? "").trim();
    } catch (e) { withAware = `(error: ${(e as Error).message})`; }
    try {
      const r2 = await client.complete([
        { role: "system", content: "You are a code analyst." },
        { role: "user", content: q },
      ], { model: LLM_MODEL, temperature: 0, maxTokens: 200 });
      withoutAware = (r2?.content ?? "").trim();
    } catch (e) { withoutAware = `(error: ${(e as Error).message})`; }

    // Heuristic: the "with awareness" answer is useful if the "without
    // awareness" answer lacks data (asks for the codebase) AND the with-
    // answer is substantive (>20 chars, not an error). The with-answer
    // being concise is EXPECTED — it has the data, so it doesn't need to
    // explain why it can't answer. The without-answer being long is also
    // expected — it explains WHY it can't answer (without the codebase).
    const withHasError = /^\(error:/.test(withAware) || withAware.length < 5;
    const withIsSubstantive = withAware.length > 20 && !withHasError;
    const withoutLacksData = /I don't have|cannot|no access|without (access to|seeing)|please (provide|share|upload|paste)|haven't provided|need you to provide|need .* (code|repository|files|snippet)|upload the|didn't specify|particular software|general concept|various contexts|can refer to/i.test(withoutAware);
    const useful = withIsSubstantive && withoutLacksData;
    if (useful) usefulCount += 1;
    results.push({ query: q, useful, withAware: withAware.slice(0, 300), withoutAware: withoutAware.slice(0, 300) });
    console.log(`    useful=${useful} (withSubstantive=${withIsSubstantive}, withoutLacks=${withoutLacksData})`);
    console.log(`    WITH (${withAware.length}ch): ${withAware.slice(0, 120)}...`);
    console.log(`    WITHOUT (${withoutAware.length}ch): ${withoutAware.slice(0, 120)}...`);
  }

  console.log(`\n=== LLM usefulness: ${usefulCount}/${queries.length} ===`);
  const fs = await import("node:fs");
  fs.writeFileSync("exp446-llm-results.json", JSON.stringify({ usefulCount, total: queries.length, results }, null, 2));
  console.log("Results written to exp446-llm-results.json");
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
