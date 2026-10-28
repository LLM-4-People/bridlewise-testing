// EXP435 improper usage test — summary cap + trim + boundary cases.
import { ConversationSummary, extractTopic } from "../_experiments/unified/conversation-summary.ts";
import { buildUnifiedConfig } from "../_experiments/unified/config.ts";
import { MemoryStore } from "../_experiments/unified/memory-store.ts";
import { ContextManager } from "../_experiments/unified/context-manager.ts";
import { TrimManager } from "../_experiments/unified/trim-manager.ts";
import { InjectionController } from "../_experiments/unified/injection-controller.ts";
import { createAwarenessEngine } from "../_experiments/unified/awareness/engine.ts";

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; } else { failed++; console.log(`  FAIL: ${msg}`); }
}

// I1: Summary cap — 10000-turn summary fits 200 tokens.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 10000; t++) {
    s.recordTurn(t, `topic_${t}_longer_name`);
  }
  const block = s.buildBlock();
  const blockTokens = Math.ceil(block.length / 4);
  assert(blockTokens <= 210, `10000-turn summary within 200 tokens: ${blockTokens} tokens (block ${block.length} chars)`);
  assert(block.includes("CONVERSATION SUMMARY"), `block has header`);
  assert(block.includes("T10000:"), `block has the latest turn (10000)`);
}

// I2: Summary cap — 50000-turn summary fits 200 tokens.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 50000; t++) {
    s.recordTurn(t, `t_${t}`);
  }
  const block = s.buildBlock();
  const blockTokens = Math.ceil(block.length / 4);
  assert(blockTokens <= 210, `50000-turn summary within 200 tokens: ${blockTokens} tokens`);
  // At 50000 turns, level 3 (every 1000th) should have turns 1000, 2000,..., 49000.
  assert(block.includes("T49000:") || block.includes("T50000:"), `block has an ancient turn`);
}

// I3: Summary with empty conversation — no entries.
{
  const s = new ConversationSummary(200);
  const block = s.buildBlock();
  assert(block === "", `empty summary returns empty block: "${block}"`);
}

// I4: Summary with 1 turn.
{
  const s = new ConversationSummary(200);
  s.recordTurn(1, "refactor");
  const block = s.buildBlock();
  assert(block.includes("T1:refactor"), `1-turn summary has T1:refactor`);
  assert(block.includes("1 turns"), `1-turn summary header says 1 turns`);
}

// I5: Summary cap at various budgets (100, 200, 400, 800).
{
  for (const budget of [100, 200, 400, 800]) {
    const s = new ConversationSummary(budget);
    for (let t = 1; t <= 5000; t++) {
      s.recordTurn(t, `topic_${t}`);
    }
    const block = s.buildBlock();
    const blockTokens = Math.ceil(block.length / 4);
    assert(blockTokens <= budget + 10, `budget=${budget}: within ${budget}+10 tokens: ${blockTokens}`);
  }
}

// I6: Summary determinism — same entries → same block (even at 5000 turns).
{
  const s1 = new ConversationSummary(200);
  const s2 = new ConversationSummary(200);
  for (let t = 1; t <= 5000; t++) {
    const topic = `topic_${t}`;
    s1.recordTurn(t, topic);
    s2.recordTurn(t, topic);
  }
  assert(s1.buildBlock() === s2.buildBlock(), `5000-turn determinism: same entries → same block`);
}

// I7: extractTopic with edge cases.
{
  // Empty message.
  assert(extractTopic("") === "turn", `empty message → "turn"`);
  // Only stopwords.
  assert(extractTopic("the a an is are was were") === "turn", `only stopwords → "turn"`);
  // Very long message.
  const longMsg = "We need to refactor " + "x".repeat(1000);
  const topic = extractTopic(longMsg);
  assert(topic === "refactor", `long message with refactor → "refactor"`);
  // Call with stopword.
  assert(extractTopic("Call the next tool.") === "turn", `Call the next → "turn" (not "the")`);
  // IMPORTANT NOTE with no content.
  assert(extractTopic("IMPORTANT NOTE for later: Remember this.") === "turn", `IMPORTANT NOTE with no keyword → "turn"`);
}

// I8: Summary injection in ContextManager — replaced each turn.
{
  const cfg = buildUnifiedConfig({ injection: { enableSummary: true, summaryTokBudget: 200 } });
  const mem = new MemoryStore(cfg.memory);
  const ctx = new ContextManager(cfg, mem);
  const tm = new TrimManager(cfg, mem, ctx);
  ctx.setTrimManager(tm);
  ctx.addSystem("system", 0);
  ctx.addSummary("summary v1", 1);
  const tokens1 = ctx.inContextTokens();
  ctx.addSummary("summary v2 (longer than v1 to verify replacement)", 2);
  const tokens2 = ctx.inContextTokens();
  // Only ONE summary block should be in context (replaced, not accumulated).
  const summaryMessages = ctx.messages.filter((m) => m.kind === "summary");
  assert(summaryMessages.length === 1, `only 1 summary message (replaced): ${summaryMessages.length}`);
  assert(summaryMessages[0].content.includes("v2"), `summary content is v2 (latest)`);
}

// I9: Summary disabled — no summary block in context.
{
  const cfg = buildUnifiedConfig({ injection: { enableSummary: false, summaryTokBudget: 200 } });
  const mem = new MemoryStore(cfg.memory);
  const ctx = new ContextManager(cfg, mem);
  const tm = new TrimManager(cfg, mem, ctx);
  ctx.setTrimManager(tm);
  ctx.addSystem("system", 0);
  // Simulate recordSummaryTurn via the controller (which checks enableSummary).
  const engine = createAwarenessEngine(cfg.awareness);
  const controller = new InjectionController(cfg, mem, ctx, engine, "/tmp");
  controller.recordSummaryTurn(1, "refactor assertion factory", "");
  const summaryMessages = ctx.messages.filter((m) => m.kind === "summary");
  assert(summaryMessages.length === 0, `disabled summary → no summary in context: ${summaryMessages.length}`);
  // But the summary entry IS recorded (for pickContinuityProbeTurns).
  assert(controller.summary.size() === 1, `disabled summary → entry still recorded: ${controller.summary.size()}`);
}

// I10: Main topic always in summary header.
{
  const cfg = buildUnifiedConfig({ injection: { enableSummary: true, summaryTokBudget: 200 } });
  const mem = new MemoryStore(cfg.memory);
  const ctx = new ContextManager(cfg, mem);
  const engine = createAwarenessEngine(cfg.awareness);
  const controller = new InjectionController(cfg, mem, ctx, engine, "/tmp");
  controller.setMainTopic("refactor assertion factory");
  controller.recordSummaryTurn(1, "start refactor", "");
  controller.recordSummaryTurn(100, "list_files", "");
  controller.recordSummaryTurn(500, "edit", "");
  const block = controller.summary.buildBlock();
  assert(block.includes("main: refactor assertion factory"), `main topic in header: ${block.split("\n")[0]}`);
}

// I11: pickContinuityProbeTurns only picks turns in the summary block.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 100; t++) {
    s.recordTurn(t, `topic${t}`);
  }
  const turns = s.pickContinuityProbeTurns(100, 10);
  for (const t of turns) {
    assert(s.isTurnInSummary(t), `picked turn ${t} is in summary`);
  }
}

// I12: Hierarchical summary has all 4 levels at 5000 turns.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 5000; t++) {
    s.recordTurn(t, `t${t}`);
  }
  const block = s.buildBlock();
  // Level 0 (recent): T4991-T5000.
  assert(block.includes("T5000:"), `level 0 has T5000`);
  // Level 1 (medium): T4900, T4910, etc.
  assert(block.includes("T4900:") || block.includes("T4910:"), `level 1 has a medium turn`);
  // Level 2 (old): T4000, T4100, etc.
  assert(block.includes("T4000:") || block.includes("T4100:"), `level 2 has an old turn`);
  // Level 3 (ancient): T1000, T2000, etc.
  assert(block.includes("T1000:") || block.includes("T2000:"), `level 3 has an ancient turn`);
}

console.log(`\nImproper usage + boundary tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
