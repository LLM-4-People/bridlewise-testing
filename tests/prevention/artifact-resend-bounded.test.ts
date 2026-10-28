// @vitest-environment node
/**
 * A LARGE TOOL-CALL PAYLOAD IS SENT ONCE AS A REFERENCE, NOT RE-SERIALISED
 * INTO EVERY REQUEST — AND THE LEDGER STILL HOLDS EVERY BYTE.
 *
 * ── WHAT WAS MEASURED ────────────────────────────────────────────────────
 *
 * `buildTrimmedHistory` rebuilds the outbound `ChatMessage[]` from scratch on
 * every turn, re-emitting each surviving tool call's `arguments` verbatim.
 * For an ordinary tool call that is noise. For `create_artifact` the
 * arguments ARE the document. Driven over a real-sized artifact — 55 KB, the
 * size recorded from twelve artifacts taken end-to-end through a real model —
 * that is ~14,000 tokens re-sent PER TURN, ~140,000 across ten turns, and at
 * the 512 KB ceiling the product allows, ~131,000 tokens per turn for one
 * artifact before the conversation has said anything.
 *
 * The second-order harm is worse than the first. The trim evicts by TOTAL
 * tokens and has no notion of "no single element may dominate", so one
 * enormous immutable blob does not merely cost — it evicts the conversation
 * to make room for itself, every turn. A user experiences that as the model
 * forgetting everything immediately after making something, which reads as a
 * model defect and is a context-assembly defect.
 *
 * ── THE THREE THINGS THIS FILE REFUSES TO LET REGRESS ────────────────────
 *
 * 1. THE COST. The outbound history must not carry the document's weight.
 * 2. THE LEDGER (binding). A summary changes what is SENT, never what was
 *    RECORDED. The context manager's turns must still hold the arguments
 *    byte-identically. This is asserted by comparing bytes, not by trusting
 *    a comment.
 * 3. THE WAY BACK. An abridgement whose original cannot be recovered is a
 *    deletion that reports success, and one that does not SAY it is an
 *    abridgement is worse: the model is handed something that begins exactly
 *    like the document and simply stops, and revises the fragment. So the
 *    reference must state that it is abridged AND name the call that returns
 *    the rest, and that call must actually work.
 *
 * ── POPULATION ───────────────────────────────────────────────────────────
 *
 * Every message in the `ChatMessage[]` returned by `buildTrimmedHistory` for
 * a conversation containing at least one `create_artifact` tool call, counted
 * at runtime. The artifact-bearing message count is asserted >= 1 before any
 * cost is believed: a fixture whose artifact turn was trimmed away contains
 * no artifact message, and this file would otherwise pass while measuring
 * nothing.
 */
import { describe, expect, test } from "vitest";

import {
  RETRIEVE_TOOL_NAME,
  buildTrimmedHistory,
  createRunContextManager,
  estimateHistoryTokens,
  retrievalIsAvailable,
} from "../../server/context/context-bridge.ts";
import { executeToolCall } from "../../server/tools/tool-executor.ts";
import { getToolManifest } from "../../server/tools/tools-bridge.ts";
import { estimateTokens } from "../../engine/src/memory/unified/tokenizer.ts";
import {
  DEFAULT_TOOL_RESULT_CONFIG,
  abridgedReference,
  createToolResultStore,
  minimumLruCapacityForContext,
  retrievalRouteFor,
} from "../../engine/src/memory/unified/unified-tool-result-store.ts";
import { resolveUnifiedConfig } from "../../engine/src/memory/unified/unified-config.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
/**
 * A real-sized artifact built from VARIED markup. A repeated character would
 * flatter every length-based measure in sight, and both the tokenizer and the
 * store are length-sensitive.
 */
function artifactBody(targetBytes: number): string {
  const words = "board tetromino rotate clear line score level gravity tick render canvas context fill stroke rect grid row column collide spawn queue hold ghost drop soft hard lock delay input key handler state reducer draw loop frame request animation".split(" ");
  let i = 0;
  const next = (): string => words[(i = (i + 7) % words.length)] ?? "x";
  const parts: string[] = ["<!doctype html>\n<html>\n<head>\n<style>\n"];
  let len = parts[0]!.length;
  while (len < targetBytes * 0.35) {
    const s = `.${next()}-${next()} { color: #${((i * 9973) % 0xffffff).toString(16).padStart(6, "0")}; padding: ${i % 17}px; }\n`;
    parts.push(s); len += s.length;
  }
  const mid = "</style>\n</head>\n<body>\n<canvas id=\"g\"></canvas>\n<script>\n";
  parts.push(mid); len += mid.length;
  while (len < targetBytes - 40) {
    const s = `function ${next()}${i}(${next()}, ${next()}) { return ${next()}.${next()}(${i % 31}); }\n`;
    parts.push(s); len += s.length;
  }
  parts.push("</script>\n</body>\n</html>\n");
  return parts.join("");
}

const ARTIFACT_BYTES = 55_096;
const CALL_ID = "call-artifact-1";

/**
 * The manifest a run that CAN honour the way back is sending. Passed whole
 * rather than reduced to a boolean first: the abridgement and the tool that
 * undoes it must be decided from one fact, and a boolean is a second place
 * that fact can be got wrong.
 */
const SENDING_RETRIEVAL = [{ name: RETRIEVE_TOOL_NAME }] as never;

/** The arguments string a real `create_artifact` call carries. */
function artifactArguments(): string {
  return JSON.stringify({ type: "game", title: "Tetris", content: artifactBody(ARTIFACT_BYTES) });
}

/**
 * A conversation that made an artifact, built through the PRODUCTION
 * factory — not a hand-assembled manager. The abridgement lives in the
 * wiring, so a fixture that wires itself would prove nothing about the
 * product.
 */
function conversationWithArtifact(args: string): ReturnType<typeof createRunContextManager> {
  const cm = createRunContextManager();
  cm.addTurn({ role: "user", content: "build me a tetris game" });
  cm.addTurn({
    role: "assistant",
    content: "",
    toolCalls: [{ id: CALL_ID, type: "function", function: { name: "create_artifact", arguments: args } }],
  });
  // The tool RESULT must exist or the assistant's tool_calls are dropped as
  // orphaned before anything below can observe them.
  cm.addTurn({ role: "tool", content: "Artifact 'Tetris' created.", toolCallId: CALL_ID });
  cm.addTurn({ role: "assistant", content: "Done — it renders below." });
  return cm;
}

/**
 * The artifact tool calls in a derived history.
 *
 * Takes the derivation's OWN return type rather than a hand-written structural
 * shape. `ChatMessage.tool_calls` is `readonly unknown[]`, so every call site
 * spelling the shape here was a type error in `tsconfig.tests.json` — nine of
 * them in this file alone — and adding a test added another. The narrowing
 * happens once, inside, where it is visible.
 */
type EmittedCall = Readonly<{ function: Readonly<{ name: string; arguments: string }> }>;

function artifactMessages(history: ReturnType<typeof buildTrimmedHistory>): readonly EmittedCall[] {
  const out: EmittedCall[] = [];
  for (const m of history) {
    for (const tc of ((m as { tool_calls?: readonly EmittedCall[] }).tool_calls ?? [])) {
      if (tc.function.name === "create_artifact") out.push(tc);
    }
  }
  return out;
}

describe("a large tool-call payload costs a reference, not a document", () => {
  test("LIVENESS: the tokenizer answers, and the fixture is really artifact-sized", () => {
    // A refusal must never be reportable as a saving.
    expect(estimateTokens("hello world"), "tokenizer liveness").toBe(3);
    const args = artifactArguments();
    expect(Buffer.byteLength(args, "utf8"), "fixture is not artifact-sized").toBeGreaterThan(50_000);
  });

  test("the artifact turn SURVIVES into the outbound history (population floor)", () => {
    const cm = conversationWithArtifact(artifactArguments());
    const history = buildTrimmedHistory(cm, SENDING_RETRIEVAL);
    // Without this floor, a trimmed-away artifact would make every cost
    // assertion below pass while measuring an empty answer.
    expect(artifactMessages(history).length, "no create_artifact call reached the outbound history").toBeGreaterThanOrEqual(1);
    expect(history.length).toBeGreaterThan(0);
  });

  test("MEASURED: the outbound history does not carry the document's weight", () => {
    const args = artifactArguments();
    const cm = conversationWithArtifact(args);
    const history = buildTrimmedHistory(cm, SENDING_RETRIEVAL);

    // BEFORE: what re-serialising the payload verbatim costs, every turn.
    const before = estimateTokens(args);
    // AFTER: what the assembled request actually costs.
    const after = estimateHistoryTokens(history);

    const saving = (before - after) / before;
    // Reported so a future reader sees the real numbers rather than a bare
    // pass/fail, and so a drift shows up as a moving number.
    expect(
      saving,
      `re-sent ${before} tokens/turn before, whole history is ${after} tokens after (${(saving * 100).toFixed(2)}% saved)`,
    ).toBeGreaterThan(0.9);
    // The whole history — summary, four turns, framing and all — must now be
    // smaller than the single payload used to be.
    expect(after).toBeLessThan(before);
  });

  test("THE LEDGER STILL HOLDS EVERY BYTE (a summary changes what is SENT, never what was RECORDED)", () => {
    const args = artifactArguments();
    const cm = conversationWithArtifact(args);
    // Derive the outbound view first — if abridging MUTATED the record, this
    // is what would have done it.
    buildTrimmedHistory(cm, SENDING_RETRIEVAL);
    buildTrimmedHistory(cm, SENDING_RETRIEVAL);

    const recorded = cm.state().turns
      .flatMap((t) => [...(t.toolCalls ?? [])])
      .find((tc) => tc.id === CALL_ID);
    expect(recorded, "the artifact tool call vanished from the ledger").toBeDefined();
    // BYTES, not a length or a prefix.
    expect(recorded!.function.arguments, "the ledger no longer holds the artifact verbatim").toBe(args);
    expect(Buffer.byteLength(recorded!.function.arguments, "utf8")).toBe(Buffer.byteLength(args, "utf8"));
  });

  test("the reference STATES that it is abridged, and names the way back", async () => {
    const args = artifactArguments();
    const cm = conversationWithArtifact(args);
    const sent = artifactMessages(buildTrimmedHistory(cm, SENDING_RETRIEVAL))[0]!.function.arguments;

    // Evidence only the new path can produce. Never ordering, never a bare
    // token count — the old path reproduces both by accident.
    expect(sent, "the abridgement does not say it is one").toContain("[abridged:");
    expect(sent, "the abridgement does not name the way back").toContain(RETRIEVE_TOOL_NAME);
    expect(sent, "the abridgement does not carry a retrievable id").toMatch(/id ["']?tr-[a-z0-9]+/);
    // THE SIZE IS COMPARED AGAINST WHAT THE WAY BACK ACTUALLY HANDS OVER.
    //
    // `/\d{4,} bytes/` passes for any four-digit number, so a notice built
    // from the wrong node — the SUMMARY's byte length instead of the full
    // text's — would announce a 55 KB document as "218 bytes" and match at
    // 55 KB only by luck of magnitude, and never at all below ~10 KB. A model
    // told the original is smaller than the fragment it can already see
    // concludes it holds the whole thing.
    //
    // It used to be compared against the STORED bytes, and that is the
    // narrower defect this now covers: the store keeps the raw text and the
    // retrieval masks credentials on its way out, so on any payload holding
    // one the notice promised a size nobody would ever receive — while also
    // promising nothing had been changed. Driving the retrieval is what makes
    // the notice answerable rather than plausible.
    const statedBytes = /returns (\d+) bytes/.exec(sent)?.[1];
    expect(statedBytes, `no byte count could be read from the notice: ${sent.slice(0, 200)}`).toBeDefined();
    const id = /id ["']?(tr-[a-z0-9]+)/.exec(sent)?.[1];
    expect(id, `no id could be read from the notice: ${sent.slice(0, 200)}`).toBeDefined();
    const delivered = await executeToolCall(RETRIEVE_TOOL_NAME, { id: id! }, {
      projectRoot: process.cwd(),
      toolResults: cm.toolResultStore!,
    });
    expect(delivered.success, `retrieval failed: ${delivered.output.slice(0, 200)}`).toBe(true);
    expect(
      Number(statedBytes),
      "the notice states a size the way back does not deliver",
    ).toBe(Buffer.byteLength(delivered.output, "utf8"));
    // …and on THIS fixture, which holds no credential, that is also the
    // document's own size — so the two readings are pinned together and a
    // notice quoting the summary instead of the document still fails.
    expect(Number(statedBytes), "the notice states a size that is not the document's").toBe(
      Buffer.byteLength(args, "utf8"),
    );
    // And it is genuinely shorter than the thing it replaced.
    expect(Buffer.byteLength(sent, "utf8")).toBeLessThan(Buffer.byteLength(args, "utf8") / 10);
  });

  /**
   * THE NOTICE IS TRUE WHEN REDACTION FIRES, TOO — the §5 half.
   *
   * Both of its sentences used to be false the moment a credential was in the
   * payload: it announced the stored size and promised nothing had been
   * changed, while the way back delivered a masked, smaller document. The
   * record is not the problem and is not "fixed" here — masking changes what
   * is SENT and never what was RECORDED — so this drives BOTH cases and
   * requires the notice to be true in each.
   */
  test("with a credential in the payload the notice states the MASKED size, and says so", async () => {
    const secret = ("sk" + "-live-4f9a2b7c8d1e0f3a5b6c7d8e9f0a1b2c");
    const withSecret = JSON.stringify({
      type: "game",
      title: "Tetris",
      content: `const API_KEY = "${secret}";\n${artifactBody(ARTIFACT_BYTES)}`,
    });
    const cm = conversationWithArtifact(withSecret);
    const sent = artifactMessages(buildTrimmedHistory(cm, SENDING_RETRIEVAL))[0]!.function.arguments;

    const id = /id ["']?(tr-[a-z0-9]+)/.exec(sent)?.[1];
    expect(id, `no id could be read from the notice: ${sent.slice(0, 200)}`).toBeDefined();
    const delivered = await executeToolCall(RETRIEVE_TOOL_NAME, { id: id! }, {
      projectRoot: process.cwd(),
      toolResults: cm.toolResultStore!,
    });
    expect(delivered.success, `retrieval failed: ${delivered.output.slice(0, 200)}`).toBe(true);

    // LIVENESS: masking really happened, or this test is the no-secret case
    // wearing a different name and proves nothing about the redacted branch.
    expect(delivered.output, "the credential survived the way back").not.toContain(secret);
    expect(
      Buffer.byteLength(delivered.output, "utf8"),
      "redaction changed nothing — this cell is not exercising the masked branch",
    ).not.toBe(Buffer.byteLength(withSecret, "utf8"));

    const statedBytes = Number(/returns (\d+) bytes/.exec(sent)?.[1]);
    expect(statedBytes, "the notice states a size the way back does not deliver").toBe(
      Buffer.byteLength(delivered.output, "utf8"),
    );
    // And it must not claim the thing that is false here.
    expect(sent, "the notice still promises an unaltered document while masking one").not.toContain(
      "Nothing in it has been changed or removed",
    );
    expect(sent, "the notice does not say what was masked").toContain("[REDACTED:");
    // The ledger is untouched — the record keeps the user's real bytes.
    const recorded = cm.state().turns.flatMap((t) => [...(t.toolCalls ?? [])]).find((tc) => tc.id === CALL_ID);
    expect(recorded!.function.arguments, "masking reached the record").toBe(withSecret);
  });

  test("THE WAY BACK WORKS: the named tool returns the full text, driven", async () => {
    const args = artifactArguments();
    const cm = conversationWithArtifact(args);
    const sent = artifactMessages(buildTrimmedHistory(cm, SENDING_RETRIEVAL))[0]!.function.arguments;

    // Read the id out of the notice the MODEL is given — not out of the
    // store. If the notice names an id the store cannot resolve, that is
    // exactly the defect this test exists to catch.
    const id = /id ["']?(tr-[a-z0-9]+)/.exec(sent)?.[1];
    expect(id, `no id could be read from the notice: ${sent.slice(0, 200)}`).toBeDefined();

    const store = cm.toolResultStore;
    expect(store, "the run has no tool-result store — the socket is unplugged again").not.toBeNull();

    const result = await executeToolCall(RETRIEVE_TOOL_NAME, { id: id! }, {
      projectRoot: process.cwd(),
      toolResults: store!,
    });
    expect(result.success, `retrieval failed: ${result.output.slice(0, 200)}`).toBe(true);
    // The recovered text must be the document, not a prefix of it.
    expect(Buffer.byteLength(result.output, "utf8")).toBe(Buffer.byteLength(args, "utf8"));
    expect(result.output).toBe(args);
  });

  test("an unknown id is a stated absence, never an empty success", async () => {
    const cm = conversationWithArtifact(artifactArguments());
    const result = await executeToolCall(RETRIEVE_TOOL_NAME, { id: "tr-does-not-exist" }, {
      projectRoot: process.cwd(),
      toolResults: cm.toolResultStore!,
    });
    expect(result.success, "a missing document was reported as a success").toBe(false);
    expect(result.output).toContain("tr-does-not-exist");
    expect(result.output.length, "an empty answer would read as an empty document").toBeGreaterThan(40);
  });

  /**
   * NO WAY BACK MEANS NO ABRIDGEMENT.
   *
   * The retrieval tool is an ordinary manifest entry, so an operator's
   * `tools.enabled` list or a per-user override can switch it off. An
   * abridgement that names a tool the model was not given is a FABRICATED
   * CAPABILITY — the model is told the document is recoverable, finds no such
   * tool, and revises the fragment it can see. That is a worse defect than
   * the cost abridging saves, so the expensive answer is the correct one
   * here, and it is the DEFAULT rather than something a caller opts into.
   */
  test("with the retrieval tool absent, the document is sent WHOLE rather than promised back", () => {
    const args = artifactArguments();
    const cm = conversationWithArtifact(args);

    // The default is deny: a caller that has not established a way back gets
    // the verbatim document, not a broken promise.
    const sentWithout = artifactMessages(buildTrimmedHistory(cm))[0]!.function.arguments;
    expect(sentWithout, "a payload was abridged with no way back").not.toContain("[abridged:");
    expect(sentWithout, "the document was not sent whole").toBe(args);

    // And the availability question is answered from the manifest itself,
    // not from a flag someone remembered to set.
    expect(retrievalIsAvailable([]), "an empty manifest must not report retrieval as available").toBe(false);
    expect(
      retrievalIsAvailable([{ name: RETRIEVE_TOOL_NAME } as never]),
      "a manifest carrying the tool must report it available",
    ).toBe(true);
    // THE POINT THE OTHER TWO CANNOT MAKE. `[] -> false` and
    // `[RETRIEVE] -> true` are both satisfied by `tools.length > 0`, so a
    // one-token edit from "does the manifest name this tool" to "does the
    // manifest have anything in it" would switch abridging on for every run
    // that sends any tool at all — the fabricated capability this gate
    // exists to prevent — with both assertions above still green. A
    // NON-EMPTY manifest that does not carry the tool is the only fixture
    // that separates the two answers.
    expect(
      retrievalIsAvailable([{ name: "read_file" }, { name: "grep" }] as never),
      "a non-empty manifest WITHOUT the retrieval tool must not report it available",
    ).toBe(false);
    // A plausible-but-wrong name is refused for the same reason: the route
    // is looked up, never taken on trust.
    expect(
      retrievalIsAvailable([{ name: "get_tool_result" }] as never),
      "a similarly-named tool must not satisfy the route",
    ).toBe(false);
  });

  /**
   * THE WAY BACK CANNOT BE A SENTENCE ANYMORE.
   *
   * The notice's route used to be a string the caller supplied, checked only
   * for non-emptiness — which accepted a zero-width space, a NUL byte, `"."`
   * and, the one that would have shipped, a fluent sentence naming a tool the
   * model does not have. The route is now a value minted only by looking the
   * name up in the manifest being sent, so none of those has a way in.
   */
  test("a route can only be minted from the manifest actually being sent", () => {
    const args = artifactArguments();
    const cm = conversationWithArtifact(args);
    // A manifest naming a DIFFERENT retrieval-shaped tool must not produce a
    // notice at all — a wrong way back is worse than paying the tokens.
    const wrongTool = artifactMessages(buildTrimmedHistory(cm, [{ name: "get_tool_result" }] as never))[0]!.function.arguments;
    expect(wrongTool, "a payload was abridged toward a tool the run is not sending").not.toContain("[abridged:");
    expect(wrongTool).toBe(args);

    // And when a route IS minted, the notice names that tool and no other.
    const right = artifactMessages(buildTrimmedHistory(cm, SENDING_RETRIEVAL))[0]!.function.arguments;
    expect(right).toContain(`call ${RETRIEVE_TOOL_NAME} with id`);
    expect(right, "the notice names a tool the manifest does not carry").not.toContain("get_tool_result");
  });

  /**
   * AN "ABRIDGEMENT" LARGER THAN THE DOCUMENT IS A COST WITH A LIE ATTACHED.
   *
   * POPULATION (§20b): every payload size from just under the store's
   * threshold to well past it, in 20-character steps — the band the store's
   * `skipIfSmallTokens` admits but the abridged form's own floor (framing +
   * an opening of up to the preview length) cannot pay for. Measured at
   * 400 characters, the old wiring sent 144 tokens where the document was
   * 104: a 38% increase, announced to the model as "only the opening is
   * shown here". The sizes are derived here rather than listed, so widening
   * the framing moves the band and this test moves with it.
   */
  test("no payload is made LARGER by abridging it, at any size", () => {
    const inflated: string[] = [];
    let abridgedSeen = 0;
    let wholeSeen = 0;
    for (let chars = 320; chars <= 1600; chars += 20) {
      const cm = createRunContextManager();
      const payload = JSON.stringify({ query: "q".repeat(chars) });
      cm.addTurn({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c-band", type: "function", function: { name: "search_code", arguments: payload } }],
      });
      cm.addTurn({ role: "tool", content: "ok", toolCallId: "c-band" });
      const sent = buildTrimmedHistory(cm, SENDING_RETRIEVAL)
        .flatMap((m) => [...((m as { tool_calls?: readonly { function: { name: string; arguments: string } }[] }).tool_calls ?? [])])[0]!
        .function.arguments;
      if (sent.startsWith("[abridged:")) abridgedSeen += 1; else wholeSeen += 1;
      if (estimateTokens(sent) > estimateTokens(payload)) {
        inflated.push(`${payload.length} chars: ${estimateTokens(payload)} -> ${estimateTokens(sent)}`);
      }
    }
    // LIVENESS on both branches: a run that abridged nothing would satisfy
    // the inflation check while measuring an inert feature, and a run that
    // abridged everything would mean the whole-payload branch is unreachable.
    expect(abridgedSeen, "nothing in the band was abridged — the check measured a feature that did not run").toBeGreaterThan(0);
    expect(wholeSeen, "everything was abridged — the smaller-of-the-two choice never chose whole").toBeGreaterThan(0);
    expect(inflated, `abridging INFLATED these payloads: ${inflated.join("; ")}`).toEqual([]);
  });

  test("the retrieval tool is REALLY in the manifest the product ships", () => {
    // The abridgement names this tool by id. If the manifest stopped
    // carrying it, every abridgement would become a fabricated capability
    // and nothing else in this file would notice.
    const names = getToolManifest().map((t) => t.name);
    expect(names, `manifest tools: ${names.join(", ")}`).toContain(RETRIEVE_TOOL_NAME);
  });

  test("a SMALL tool call is still sent whole (the store must not swallow ordinary calls)", () => {
    const small = JSON.stringify({ path: modulePathMatching("src/index.ts") });
    const cm = createRunContextManager();
    cm.addTurn({ role: "user", content: "read a file" });
    cm.addTurn({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c-small", type: "function", function: { name: "read_file", arguments: small } }],
    });
    cm.addTurn({ role: "tool", content: "ok", toolCallId: "c-small" });

    const sent = buildTrimmedHistory(cm, SENDING_RETRIEVAL)
      .flatMap((m) => [...((m as { tool_calls?: readonly { function: { name: string; arguments: string } }[] }).tool_calls ?? [])])
      .find((tc) => tc.function.name === "read_file");
    expect(sent, "the small call vanished").toBeDefined();
    expect(sent!.function.arguments, "a small payload was abridged — the threshold is doing the wrong thing").toBe(small);
    expect(sent!.function.arguments).not.toContain("[abridged:");
  });

  test("the same document across many turns costs ONE reference, not one per turn", () => {
    const args = artifactArguments();
    const cm = conversationWithArtifact(args);
    // Ten follow-up turns, the artifact surviving all of them.
    for (let i = 0; i < 10; i += 1) cm.addTurn({ role: "user", content: `follow up ${i}` });

    const history = buildTrimmedHistory(cm, SENDING_RETRIEVAL);
    const calls = artifactMessages(history);
    expect(calls.length).toBeGreaterThanOrEqual(1);

    // The id must be STABLE — re-deriving the history must not mint a new
    // entry each turn, or the id the model was given last turn names nothing
    // and the store grows without bound.
    const idOf = (h: readonly { function: { arguments: string } }[]): string | undefined =>
      /id ["']?(tr-[a-z0-9]+)/.exec(h[0]!.function.arguments)?.[1];
    const first = idOf(calls);
    const again = idOf(artifactMessages(buildTrimmedHistory(cm, SENDING_RETRIEVAL)));
    expect(again, "the reference id changed between turns — the model's id would go stale every turn").toBe(first);

    const total = estimateHistoryTokens(history);
    expect(
      total,
      `ten turns of history cost ${total} tokens; one verbatim re-send of the document alone is ${estimateTokens(args)}`,
    ).toBeLessThan(estimateTokens(args));
  });

  /**
   * THE ID SURVIVES EVICTION, AND ITS WIDTH NEVER MOVES.
   *
   * A turn's token weight is memoised when the turn is recorded, and the
   * weight of an abridged reference contains the id — twice. The id used to be
   * a counter, so an entry that aged out under LRU pressure came back under a
   * WIDER id and the memoised charge quietly stopped describing the bytes that
   * leave. That is unbounded in principle: nothing tied the two together.
   *
   * The id is now a fixed-width digest of the content, which removes the cause
   * rather than bounding it — the same bytes get the same id for the life of
   * the process, across eviction and re-minting. This drives the eviction
   * rather than reasoning about it: the store is squeezed below the number of
   * live documents so the first one is genuinely evicted, then re-offered.
   */
  test("an evicted document comes back under the SAME id, at the SAME width", () => {
    const store = createToolResultStore({ lruCapacity: 2 });
    const doc = (k: number): string => `doc-${k}-${artifactBody(2_000)}`;
    const first = store.add("create_artifact", doc(0));
    expect(first, "the fixture is below the store's threshold — nothing was stored").not.toBeNull();
    store.add("create_artifact", doc(1));
    store.add("create_artifact", doc(2));
    // LIVENESS: the squeeze really evicted it, or this test is asserting that
    // an untouched entry keeps its id, which proves nothing.
    expect(store.stats().lruEvictions, "nothing was evicted — the squeeze did not bite").toBeGreaterThan(0);
    expect(store.getFullResult(first!.id), "the entry was not evicted").toBeNull();

    const again = store.add("create_artifact", doc(0));
    expect(again!.id, "an evicted document came back under a different id — a memoised charge would now be wrong").toBe(first!.id);
    expect(again!.id.length, "the id width moved — the abridged form's weight is not stable").toBe(first!.id.length);
    expect(store.getFullResult(again!.id), "the re-minted id does not resolve").toBe(doc(0));

    // Every id this store mints is the same width, whichever document it is.
    const widths = new Set([doc(3), doc(4), doc(5)].map((d) => store.add("create_artifact", d)!.id.length));
    expect([...widths], "ids are not fixed-width").toEqual([first!.id.length]);
  });

  /**
   * THE STORE MUST HOLD EVERY ID THE CONTEXT CAN STILL BE NAMING.
   *
   * The store evicts by entry COUNT and the context evicts by token WEIGHT,
   * and nothing used to connect them. Every abridged payload still inside the
   * context is a reference the model may follow, so a capacity below the
   * number of references the token limit can hold makes ids that resolve to
   * nothing REACHABLE rather than unlikely — raising the limit alone produced
   * them in bulk. The capacity is now derived from the limit at the resolver,
   * so the pair cannot be written into disagreement.
   */
  test("the tool-result capacity is derived from the context limit it is coupled to", () => {
    const limits = [8_192, 32_768, 131_072] as const;
    let sawAnIncrease = false;
    for (const contextTokenLimit of limits) {
      const resolved = resolveUnifiedConfig({ contextTokenLimit });
      const required = minimumLruCapacityForContext(contextTokenLimit);
      expect(required, `the floor for a ${contextTokenLimit}-token context is not a positive count`).toBeGreaterThan(0);
      expect(
        resolved.toolResult.lruCapacity,
        `a ${contextTokenLimit}-token context can name ${required} abridged payloads but the store would hold only ${resolved.toolResult.lruCapacity} — the ids in the request would not all resolve`,
      ).toBeGreaterThanOrEqual(required);
      if (resolved.toolResult.lruCapacity > DEFAULT_TOOL_RESULT_CONFIG.lruCapacity) sawAnIncrease = true;
    }
    // LIVENESS: the derivation must actually move the number for at least one
    // of these limits, or "derived" is indistinguishable from "returned the
    // default", and the guard would pass with the coupling deleted.
    expect(
      sawAnIncrease,
      `the derivation never raised the capacity above the store's own default (${DEFAULT_TOOL_RESULT_CONFIG.lruCapacity}) — it is not deriving anything`,
    ).toBe(true);
    // And the floor is the real one: a reference genuinely cannot be cheaper.
    const route = retrievalRouteFor([RETRIEVE_TOOL_NAME], RETRIEVE_TOOL_NAME)!;
    const store = createToolResultStore();
    const entry = store.add("t", artifactBody(2_000))!;
    const cheapest = Math.ceil(32_768 / minimumLruCapacityForContext(32_768));
    expect(
      estimateTokens(abridgedReference(entry, route, entry.fullResult)),
      "a real abridged reference is CHEAPER than the floor the capacity was derived from — the floor is too high and the coupling under-counts",
    ).toBeGreaterThanOrEqual(cheapest);
  });
});
