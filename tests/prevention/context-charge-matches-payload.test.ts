// @vitest-environment node
/**
 * THE NUMBER THE TRIM REASONS ABOUT IS THE NUMBER OF BYTES THAT LEAVE.
 *
 * ── WHAT WENT WRONG, AND WHY NOTHING CAUGHT IT ───────────────────────────
 *
 * The context manager charges each turn a token weight, sums those weights,
 * and evicts conversation when the sum crosses a threshold. Everything the
 * trim protects rests on that sum describing the request that is about to be
 * made.
 *
 * It stopped doing that. The manager charged the weight of an ABRIDGED
 * payload whenever its store accepted one — but whether the payload was
 * actually abridged was decided in a different module, from a flag the
 * manager never saw. With the retrieval tool absent from the manifest (which
 * one user's tool settings are enough to cause) the document was sent whole
 * and charged as a summary. Driven through the production factory:
 *
 *     4 x 55 KB artifacts | charged   249 | shouldTrim() FALSE | SENT  56,181
 *     8 x 55 KB artifacts | charged   493 | shouldTrim() FALSE | SENT 112,357
 *
 * A 226x under-charge, a trim that never fires, and a request at 3.43x the
 * 32,768-token limit — strictly worse than the re-send cost the abridgement
 * was introduced to fix, because the old code at least knew what it was
 * sending.
 *
 * Nothing failed. Across 447 test files, NOT ONE asserted the manager's
 * charge against what the emitter produces: every cost assertion measured the
 * wire and none measured the ledger of intent, so both directions of
 * disagreement were invisible. This file is that missing assertion.
 *
 * ── WHY BOTH DIRECTIONS ──────────────────────────────────────────────────
 *
 * UNDER-charging switches the trim off and lets the request grow until the
 * provider rejects it. OVER-charging is the same defect with the sign flipped
 * and it is not harmless: it evicts real conversation to make room for tokens
 * nobody transmits, which the user experiences as the model forgetting what
 * it just made. Only one of the two is a safety failure; both are lies about
 * the request.
 *
 * ── POPULATION (§20b) ────────────────────────────────────────────────────
 *
 * Every tool call in the `ChatMessage[]` that `buildTrimmedHistory` derives
 * from a manager built by the PRODUCTION factory, over conversations holding
 * 1, 2, 4 and 8 artifacts of 55 KB each, with the retrieval tool BOTH present
 * in and absent from the manifest being sent — 8 cells.
 *
 * THE FLOOR IS NOT "ALL n SURVIVE", AND STATING IT THAT WAY WAS ITSELF THE
 * BUG THIS FILE HAD. Deriving the history now trims, so with the retrieval
 * tool absent a conversation holding four 14,000-token documents is SUPPOSED
 * to arrive with two of them: that is the mechanism working, and a floor of
 * `n` reds on the repair. What has to be true before any number below is
 * believed is that the request being measured genuinely contains artifact-
 * sized payloads — at least one surviving `create_artifact` call, carrying
 * more than 10,000 tokens whenever the whole document is what goes out. A
 * fixture whose artifacts were all trimmed away, or whose payloads are small,
 * agrees with everything below while measuring nothing.
 *
 * The tolerance is stated against the population too: the manager charges
 * turn content and tool calls, and `estimateHistoryTokens` additionally
 * counts the per-message role framing the manager has never charged. That
 * framing is the ONLY licensed source of disagreement and it is a fraction of
 * a percent; the band below is 2%, and the defect this file exists for was
 * 22,600%.
 */
import { describe, expect, test } from "vitest";

import {
  RETRIEVE_TOOL_NAME,
  buildTrimmedHistory,
  createRunContextManager,
  estimateHistoryTokens,
  retrievalRouteFromManifest,
} from "../../server/context/context-bridge.ts";
import { estimateTokens } from "../../engine/src/memory/unified/tokenizer.ts";
import { messagesToResponseInput } from "../../engine/src/shared/llm/response-transcript.ts";

/** Varied markup — a repeated character flatters every length-based measure. */
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

test("native payload population is charged in full once despite domain mirrors and retrieval availability", () => {
  const cm = createRunContextManager(100_000);
  const output = [
    { type: "reasoning", id: "native-reasoning", summary: [], encrypted_content: "opaque-native-state" },
    { type: "function_call", call_id: "native-call", name: "create_artifact", arguments: JSON.stringify({ body: artifactBody(55_000) }), caller: { type: "direct" } },
    { type: "message", role: "assistant", phase: "commentary", content: [{ type: "refusal", refusal: "visible refusal" }], extension: { preserved: true } },
  ];
  cm.addTurn({ role: "assistant", content: "duplicated display".repeat(9000), responseItems: output,
    toolCalls: [{ id: "mirror", type: "function", function: { name: "mirror", arguments: "duplicated".repeat(9000) } }] });
  cm.addTurn({ role: "tool", content: "", toolCallId: "native-call" });
  const history = buildTrimmedHistory(cm);
  const actual = messagesToResponseInput(history);
  expect(actual).toEqual([...output, { type: "function_call_output", call_id: "native-call", output: "", caller: { type: "direct" } }]);
  expect(actual.filter(item => item.type === "function_call")).toHaveLength(1);
  expect(estimateTokens(JSON.stringify(actual))).toBeGreaterThan(10_000);
  expect(cm.tokenCount()).toBe(estimateTokens(JSON.stringify(actual)));
  expect(estimateHistoryTokens(history)).toBe(cm.tokenCount());
  cm.setRetrievalRoute(retrievalRouteFromManifest(SENDING_RETRIEVAL));
  expect(cm.tokenCount()).toBe(estimateTokens(JSON.stringify(actual)));
});

const ARTIFACT_BYTES = 55_096;
const ARTIFACT_COUNTS = [1, 2, 4, 8] as const;

/**
 * The `arguments` string for artifact `k`, built once and reused.
 *
 * Each index gets DIFFERENT bytes — the store is idempotent by content, so
 * identical payloads would collapse to one entry and the eight-artifact cells
 * would silently measure one. Reusing them across cells is free: the fixture
 * is an input, and generating 55 KB of varied markup a hundred times only
 * spends the suite's wall-clock budget.
 */
const ARTIFACT_CACHE = new Map<number, string>();
function artifactArguments(k: number): string {
  const cached = ARTIFACT_CACHE.get(k);
  if (cached !== undefined) return cached;
  const args = JSON.stringify({ type: "game", title: `Tetris ${k}`, content: artifactBody(ARTIFACT_BYTES) });
  ARTIFACT_CACHE.set(k, args);
  return args;
}

/** The manifest a run sending the retrieval tool has. */
const SENDING_RETRIEVAL = [{ name: RETRIEVE_TOOL_NAME }] as never;
/** A run whose manifest carries real tools but NOT the retrieval one — the
 *  shape a per-user tool toggle produces, and the one F1 was measured on. */
const NOT_SENDING_RETRIEVAL = [{ name: "read_file" }, { name: "grep" }] as never;

type Manifest = typeof SENDING_RETRIEVAL;

const MANIFESTS: readonly (readonly [string, Manifest])[] = [
  ["retrieval ABSENT from the manifest", NOT_SENDING_RETRIEVAL],
  ["retrieval PRESENT in the manifest", SENDING_RETRIEVAL],
];

type Emitted = readonly { function: { name: string; arguments: string } }[];

function toolCallsOf(history: readonly unknown[]): Emitted {
  const out: { function: { name: string; arguments: string } }[] = [];
  for (const m of history) {
    for (const tc of (m as { tool_calls?: Emitted }).tool_calls ?? []) out.push(tc);
  }
  return out;
}

/** A conversation of `n` artifacts, built through the PRODUCTION factory. */
function conversationWith(n: number): ReturnType<typeof createRunContextManager> {
  const cm = createRunContextManager();
  cm.addTurn({ role: "user", content: "build me a tetris game" });
  for (let k = 0; k < n; k += 1) {
    const id = `call-artifact-${k}`;
    const args = artifactArguments(k);
    cm.addTurn({
      role: "assistant",
      content: "",
      toolCalls: [{ id, type: "function", function: { name: "create_artifact", arguments: args } }],
    });
    // Without the result turn the tool_calls are dropped as orphaned and
    // every cell below would measure an empty answer.
    cm.addTurn({ role: "tool", content: `Artifact ${k} created.`, toolCallId: id });
  }
  cm.addTurn({ role: "assistant", content: "Done — they render below." });
  return cm;
}

describe("the manager charges what the emitter sends", () => {
  test("LIVENESS: the instruments answer, and the fixture is really artifact-sized", () => {
    expect(estimateTokens("hello world"), "tokenizer liveness").toBe(3);
    const cm = conversationWith(1);
    const emitted = toolCallsOf(buildTrimmedHistory(cm, NOT_SENDING_RETRIEVAL));
    expect(emitted.length, "no tool call reached the outbound history").toBe(1);
    expect(
      estimateTokens(emitted[0]!.function.arguments),
      "the fixture is not big enough for an under-charge to be visible",
    ).toBeGreaterThan(10_000);
  });

  for (const [label, manifest] of MANIFESTS) {
    for (const n of ARTIFACT_COUNTS) {
      test(`${label}: ${n} artifact(s) — the charge equals the bytes emitted`, () => {
        const cm = conversationWith(n);
        // Deriving the history is what tells the manager which request this
        // run is making; the charge is read AFTER, from the same manager.
        const history = buildTrimmedHistory(cm, manifest);
        const emitted = toolCallsOf(history);

        // POPULATION FLOOR, per cell. Nothing below is believed until the
        // artifacts are demonstrably in the request being measured. See the
        // header: the floor is "artifact-sized payloads are in this request",
        // not "none of them was trimmed" — the trim is the mechanism.
        const artifacts = emitted.filter((tc) => tc.function.name === "create_artifact");
        expect(
          artifacts.length,
          "every artifact was trimmed away — this cell measured an empty request",
        ).toBeGreaterThan(0);
        expect(artifacts.length, "more artifacts came out than went in").toBeLessThanOrEqual(n);
        if (manifest === NOT_SENDING_RETRIEVAL) {
          expect(
            Math.max(...artifacts.map((tc) => estimateTokens(tc.function.arguments))),
            "with no way back the documents must go out WHOLE — this cell is measuring references, so an under-charge would be invisible in it",
          ).toBeGreaterThan(10_000);
        } else {
          // THE OVER-EVICTION DIRECTION, and it is not a nicety.
          //
          // Abridged, eight artifacts cost about 1,200 tokens against a 32,768
          // limit — nothing here needs evicting, and evicting anyway is the
          // user-visible half of this defect: the model forgetting what it
          // just made. It is also what a trim performed at the WRONG MOMENT
          // looks like. Driven: trimming one line before the manifest is
          // established (so the eviction is priced as if every document went
          // whole) leaves 1 of 8 artifacts and 187 tokens where the correct
          // order leaves 8 and 1,217 — a mutation that every other assertion
          // in this file admits, because a savagely over-trimmed request is
          // still inside the limit and still charged exactly.
          expect(
            artifacts.length,
            `${n} artifacts were abridgeable and only ${artifacts.length} survived — conversation was evicted to make room for tokens nobody transmits`,
          ).toBe(n);
          expect(
            cm.state().trimCount,
            "the request fits with room to spare and was trimmed anyway — the eviction was priced against a request this run is not making",
          ).toBe(0);
        }

        const charge = cm.tokenCount();
        const sent = estimateHistoryTokens(history);

        // THE UNDER-CHARGE DIRECTION — the one that disables the trim.
        expect(
          sent,
          `charged ${charge} tokens for ${sent} tokens of request (${(sent / charge).toFixed(1)}x) — the trim is reasoning about a request that will not be made`,
        ).toBeLessThanOrEqual(Math.ceil(charge * 1.02));
        // THE OVER-CHARGE DIRECTION — the one that evicts conversation to
        // make room for tokens nobody transmits.
        expect(
          charge,
          `charged ${charge} tokens for ${sent} tokens of request — real turns are being evicted for bytes that are never sent`,
        ).toBeLessThanOrEqual(Math.ceil(sent * 1.02));
      });
    }
  }

  /**
   * THE PLANT, AND IT DOES NOT NAME ITSELF.
   *
   * The band above is only worth having if the answer it rejects is an answer
   * something plausibly produces. So this reconstructs the charge the broken
   * accounting computed — the abridged summary's weight, taken from the run's
   * OWN store, exactly as the removed line took it — and proves two things
   * before trusting any verdict: that it differs from the honest charge, and
   * that the band above refuses it. Without the first, "the guard is weak"
   * and "the mutation was inert" are indistinguishable.
   */
  test("PLANT: the charge the broken accounting produced is REFUSED by the band above", () => {
    const cm = conversationWith(4);
    const history = buildTrimmedHistory(cm, NOT_SENDING_RETRIEVAL);
    const emitted = toolCallsOf(history);
    expect(emitted.length, "nothing was emitted — the plant would prove nothing").toBeGreaterThan(0);

    const store = cm.toolResultStore;
    expect(store, "the run has no tool-result store — the socket is unplugged again").not.toBeNull();

    // What the removed line charged: name + summary weight, per call.
    let dishonest = 0;
    for (const tc of emitted) {
      const entry = store!.add(tc.function.name, tc.function.arguments);
      dishonest += estimateTokens(tc.function.name) + estimateTokens(entry === null ? tc.function.arguments : entry.summary);
    }

    const honest = cm.tokenCount();
    const sent = estimateHistoryTokens(history);

    // 1. The plant changes an answer.
    expect(
      dishonest,
      `the plant charged ${dishonest} where the honest charge is ${honest} — if these agreed the plant would be inert and this file could not judge the band`,
    ).toBeLessThan(honest / 10);
    // 2. The band refuses it.
    expect(
      sent > Math.ceil(dishonest * 1.02),
      `the band admits a charge of ${dishonest} for ${sent} tokens of request`,
    ).toBe(true);
  });

  /**
   * THE OUTCOME THE WHOLE MECHANISM EXISTS FOR, DRIVEN IN THE ORDER THE
   * EXECUTOR ACTUALLY USES.
   *
   * This test used to call `buildTrimmedHistory` … `cm.trim()` …
   * `buildTrimmedHistory`, which establishes the manifest and only THEN
   * trims. The executor has never done that. It re-reads the manifest at the
   * top of every turn and derives the history from it immediately, and its
   * trim sat at the END of the previous turn — priced against the previous
   * turn's manifest. So this guard was green against an ordering that does not
   * occur in production, which is worse than having no guard, and the
   * originally-filed symptom was still live one turn later.
   *
   * `deriveAsTheExecutorDoes` is therefore a single call, exactly as
   * `buildChatOpts()` makes a single call, with nothing between reading the
   * manifest and sending the request.
   */
  const deriveAsTheExecutorDoes = (
    cm: ReturnType<typeof createRunContextManager>,
    manifest: Manifest,
  ): ReturnType<typeof buildTrimmedHistory> => buildTrimmedHistory(cm, manifest);

  test("the request the executor assembles is inside the token limit, first turn", () => {
    for (const [label, manifest] of MANIFESTS) {
      for (const n of ARTIFACT_COUNTS) {
        const cm = conversationWith(n);
        const history = deriveAsTheExecutorDoes(cm, manifest);
        const sent = estimateHistoryTokens(history);
        expect(
          sent,
          `${label}, ${n} artifacts: the assembled request is ${sent} tokens against a ${cm.tokenLimit()} limit (${(sent / cm.tokenLimit()).toFixed(2)}x)`,
        ).toBeLessThanOrEqual(cm.tokenLimit());
        // And the run still has something to say — a trim that emptied the
        // history would satisfy the line above while destroying the product.
        expect(history.length, `${label}, ${n} artifacts: the trim emptied the history`).toBeGreaterThan(0);
      }
    }
  });

  /**
   * THE DEFECT ARRIVING THROUGH TIME — the turn boundary, not the config.
   *
   * A run can be sending the retrieval tool on turn one and not on turn two:
   * the per-user tool toggle does it, and so does the breaker — and the
   * breaker's version is self-feeding, because a `retrieve_tool_result` call
   * that misses is a recorded failure on `retrieve_tool_result` itself, so the
   * tool can trip its own breaker and then make every abridged payload in the
   * conversation expand at once.
   *
   * Driven before the fix, on this exact fixture: 4 artifacts repriced from
   * 629 tokens to 56,201 and went out at 1.72x the limit, 8 at 3.43x, with
   * `shouldTrim()` answering TRUE and the payload untrimmed.
   */
  test("withdrawing the retrieval tool AT A TURN BOUNDARY does not send an untrimmed request", () => {
    for (const n of ARTIFACT_COUNTS) {
      const cm = conversationWith(n);
      // TURN 1 — the run is sending the retrieval tool.
      const turnOne = deriveAsTheExecutorDoes(cm, SENDING_RETRIEVAL);
      const sentOne = estimateHistoryTokens(turnOne);
      // TURN 2 — the boundary re-read the manifest and the tool is gone.
      const turnTwo = deriveAsTheExecutorDoes(cm, NOT_SENDING_RETRIEVAL);
      const sentTwo = estimateHistoryTokens(turnTwo);

      // LIVENESS: the withdrawal has to have changed the request, or this
      // cell is measuring two identical turns and proves nothing.
      expect(
        sentTwo,
        `${n} artifacts: withdrawing the retrieval tool did not change the request (${sentOne} then ${sentTwo}) — this cell measures nothing`,
      ).toBeGreaterThan(sentOne);
      expect(
        sentTwo,
        `${n} artifacts: the turn AFTER the tool was withdrawn goes out at ${sentTwo} tokens against a ${cm.tokenLimit()} limit (${(sentTwo / cm.tokenLimit()).toFixed(2)}x)`,
      ).toBeLessThanOrEqual(cm.tokenLimit());
      expect(turnTwo.length, `${n} artifacts: the trim emptied the second turn's history`).toBeGreaterThan(0);
    }
  });

  /**
   * A MID-RUN MANIFEST CHANGE REPRICES WHAT IS ALREADY RECORDED.
   *
   * The repricing half of the same boundary. Kept separate from the test
   * above because they can fail independently: repricing without trimming is
   * exactly the state the fix found live.
   */
  test("switching the retrieval tool off mid-run reprices the turns already recorded", () => {
    const cm = conversationWith(4);
    const withRetrieval = estimateHistoryTokens(buildTrimmedHistory(cm, SENDING_RETRIEVAL));
    const chargeWith = cm.tokenCount();
    const withoutRetrieval = estimateHistoryTokens(buildTrimmedHistory(cm, NOT_SENDING_RETRIEVAL));
    const chargeWithout = cm.tokenCount();

    // The two request shapes really are different, or this proves nothing.
    expect(withoutRetrieval, "the two manifests produced the same request").toBeGreaterThan(withRetrieval * 10);
    expect(chargeWith).toBeLessThanOrEqual(Math.ceil(withRetrieval * 1.02));
    expect(
      chargeWithout,
      `after the tool was withdrawn the manager still charged ${chargeWithout} for ${withoutRetrieval} tokens of request`,
    ).toBeGreaterThanOrEqual(Math.floor(withoutRetrieval * 0.98));
  });

  /**
   * THE ORDER IS NOT SOMETHING A CALLER PERFORMS — a behavioural check, not a
   * source scan.
   *
   * Two places used to have to remember to price and then trim, and only one
   * of them did. The repair was to make deriving the history BE the pricing
   * and the trimming, so this asserts the property that repair created: a
   * manager that has been told nothing, handed straight to the derivation,
   * comes back inside the limit. If a future change moves the trim back out to
   * its callers, this fails without needing to know where they are.
   */
  test("deriving a history is what prices and trims — no caller has to sequence it", () => {
    const cm = conversationWith(8);
    // Deliberately never call `trim()` or `setRetrievalRoute` here.
    expect(
      cm.tokenCount(),
      "the fixture is already inside the limit before deriving — it cannot show a trim happening",
    ).toBeGreaterThan(cm.tokenLimit());
    const history = buildTrimmedHistory(cm, NOT_SENDING_RETRIEVAL);
    expect(cm.state().trimCount, "deriving the history did not trim").toBeGreaterThan(0);
    expect(estimateHistoryTokens(history)).toBeLessThanOrEqual(cm.tokenLimit());
  });
});
