// EXP435 unit test — ConversationSummary (deterministic, hierarchical, capped).
import { ConversationSummary, extractTopic } from "../_experiments/unified/conversation-summary.ts";

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) { passed++; } else { failed++; console.log(`  FAIL: ${msg}`); }
}

// T1: basic record + buildBlock.
{
  const s = new ConversationSummary(200);
  s.recordTurn(1, "refactor");
  s.recordTurn(2, "makeassertnode");
  s.recordTurn(3, "list_files");
  const block = s.buildBlock();
  assert(block.includes("T1:refactor"), `T1 has refactor topic: ${block}`);
  assert(block.includes("T2:makeassertnode"), `T2 has makeassertnode: ${block}`);
  assert(block.includes("T3:list_files"), `T3 has list_files: ${block}`);
  assert(block.includes("CONVERSATION SUMMARY"), `block has header: ${block}`);
}

// T2: hierarchical levels at 100 turns.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 100; t++) {
    s.recordTurn(t, `topic${t}`);
  }
  const block = s.buildBlock();
  // Level 0 (recent): turns 91-100 should all be present.
  for (let t = 91; t <= 100; t++) {
    assert(block.includes(`T${t}:topic${t}`), `Level 0 has T${t}`);
  }
  // Level 1 (medium): every 10th turn in last 100 (10, 20,..., 90).
  for (let t = 10; t <= 90; t += 10) {
    assert(block.includes(`T${t}:topic${t}`), `Level 1 has T${t}`);
  }
}

// T3: hierarchical levels at 5000 turns — ancient level present.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 5000; t++) {
    s.recordTurn(t, `t${t}`);
  }
  const block = s.buildBlock();
  // Level 3 (ancient): every 1000th turn (1000, 2000, 3000, 4000).
  for (let t = 1000; t <= 4000; t += 1000) {
    assert(block.includes(`T${t}:t${t}`), `Level 3 (ancient) has T${t}`);
  }
  // Level 0 (recent): turns 4991-5000.
  for (let t = 4991; t <= 5000; t++) {
    assert(block.includes(`T${t}:t${t}`), `Level 0 (recent) has T${t}`);
  }
  // Check the block fits in 200 tokens (4 chars/token = 800 chars).
  assert(block.length <= 820, `block fits 200 tokens: ${block.length} chars (budget 820)`);
}

// T4: topic extraction — IMPORTANT NOTE.
{
  const topic = extractTopic("IMPORTANT NOTE for later: makeAssertNode is located in inference.ts. Remember this. Continue.");
  assert(topic === "makeassertnode", `IMPORTANT NOTE extracts makeassertnode: got "${topic}"`);
}

// T5: topic extraction — probe.
{
  const topic = extractTopic("Answer in plain text (no tool call). Question: What is the factory called? Give the name.");
  assert(topic.startsWith("probe_"), `probe extracts probe_X: got "${topic}"`);
}

// T6: topic extraction — Call tool.
{
  const topic = extractTopic("Good progress. Now call list_functions on src/path/inference.ts.");
  assert(topic === "list_functions", `Call extracts tool name: got "${topic}"`);
}

// T7: topic extraction — refactor.
{
  const topic = extractTopic("We're going to refactor babel-traverse's assertion utilities into a factory pattern.");
  assert(topic === "refactor", `refactor mention extracts refactor: got "${topic}"`);
}

// T8: topic extraction — assistant tool call JSON.
{
  const topic = extractTopic("Continue.", '{"tool":"search_code","args":{"pattern":"assert"}}');
  assert(topic === "search_code", `assistant JSON extracts tool name: got "${topic}"`);
}

// T9: isTurnInSummary.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 100; t++) {
    s.recordTurn(t, `topic${t}`);
  }
  // Turn 95 is in level 0 (last 10 turns).
  assert(s.isTurnInSummary(95) === true, "T95 in summary (level 0)");
  // Turn 50 is in level 1 (every 10th).
  assert(s.isTurnInSummary(50) === true, "T50 in summary (level 1, 50 % 10 = 0)");
  // Turn 55 is NOT in level 1 (not a 10-multiple) and NOT in level 0.
  assert(s.isTurnInSummary(55) === false, "T55 NOT in summary (level 1 needs 10-multiple, level 0 needs last 10)");
}

// T10: pickContinuityProbeTurns — picks turns that are in the summary.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 100; t++) {
    s.recordTurn(t, `topic${t}`);
  }
  const turns = s.pickContinuityProbeTurns(100, 10);
  // At maxTurn=100, only level 0 (recent 3) + level 1 (medium 3) have turns → 6.
  assert(turns.length >= 6, `picks at least 6 turns at maxTurn=100: got ${turns.length}`);
  // All picked turns should have topics AND be in the summary.
  for (const t of turns) {
    assert(s.topicForTurn(t) !== undefined, `picked turn ${t} has a topic`);
    assert(s.isTurnInSummary(t) === true, `picked turn ${t} is in summary`);
  }
}

// T10b: pickContinuityProbeTurns at 5000 turns — picks 10 from all 4 levels.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 5000; t++) {
    s.recordTurn(t, `topic${t}`);
  }
  const turns = s.pickContinuityProbeTurns(5000, 10);
  assert(turns.length === 10, `picks 10 turns at maxTurn=5000: got ${turns.length}`);
  for (const t of turns) {
    assert(s.topicForTurn(t) !== undefined, `picked turn ${t} has a topic`);
    assert(s.isTurnInSummary(t) === true, `picked turn ${t} is in summary`);
  }
}

// T11: summary cap — very long conversation still fits 200 tokens.
{
  const s = new ConversationSummary(200);
  for (let t = 1; t <= 10000; t++) {
    s.recordTurn(t, `topic_${t}_longer_name`);
  }
  const block = s.buildBlock();
  assert(block.length <= 820, `10000-turn block fits 200 tokens: ${block.length} chars`);
}

// T12: summary block is deterministic — same entries → same block.
{
  const s1 = new ConversationSummary(200);
  const s2 = new ConversationSummary(200);
  for (let t = 1; t <= 50; t++) {
    s1.recordTurn(t, `topic${t}`);
    s2.recordTurn(t, `topic${t}`);
  }
  assert(s1.buildBlock() === s2.buildBlock(), "same entries → same block (deterministic)");
}

console.log(`\nConversationSummary tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
