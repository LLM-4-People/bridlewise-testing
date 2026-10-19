// @vitest-environment node
/**
 * Prevention test: A BENCH MAY NOT WRITE INTO A CHAT A BENCH READS.
 *
 * ── The defect ──
 *
 * The scale fixtures are generated through `DbClient`, and the write benches
 * append through it too. That is deliberate and good. What was not deliberate
 * is that the chats they appended to were the chats the read benches read.
 * `concurrency.bench.ts` read `chatIds[1500]`, then wrote ~257 messages into
 * `chatIds[1500]`. `writepath.bench.ts` wrote into `chatIds[0]`, which in the
 * `heavy` profile is the 20,000-message mega chat that `db`, `payload` and
 * `redaction` all read.
 *
 * So each run made the next run's read numbers worse, cumulatively and
 * invisibly. Measured on the fixture as found: the concurrency read target
 * held 1,412 messages while its five neighbours held 46, 105, 106, 111 and
 * 167. That is a ~12.7× overgrowth in one chat, and it presented as a product
 * regression — `getChatHistory.concurrent` p50 at n=1 going 13.23ms → 23.81ms
 * across a wave that changed nothing on the read path. The whole-database
 * count moved only 2.6% in the same period, which is why nobody saw it.
 *
 * It also broke the regression guard itself: the biggest `db` read case is
 * named by its row count, so it arrived under a NEW NAME every run
 * (`[22525 messages]` → `[26455 messages]` → `[27860 messages]`), and
 * `diffReports` keys on `suite/name[scale]`. A case with no baseline twin is
 * silently skipped, so the guard reported no regression because it could not
 * find the row.
 *
 * ── The invariant ──
 *
 * Writes go to `writeSinkChatId`. Reads go to `chatIds` / `megaChatId`. The
 * sets are disjoint by construction, and the fixture owner refuses to hand out
 * a fixture whose read targets have drifted.
 *
 * Three mechanical checks, each of which fails if the discipline lapses:
 *  1. SOURCE — no bench passes a read-target expression as a write's `chat_id`.
 *  2. RUNTIME — the sink is not in the read population, and
 *     `assertReadTargetsPristine` actually throws on a drifted fixture
 *     (mutation-proved here by drifting one on purpose).
 *  3. IDENTITY — every write bench names the sink, so a new write case cannot
 *     quietly pick its own chat.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildFixture,
  assertReadTargetsPristine,
  benchReadTargets,
} from "../../bench/fixtures/scale.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * Every fixture below is built into ITS OWN directory. The tests here
 * deliberately drift a fixture to prove the guard fires, and drifting the
 * shared `bench/.fixtures` copy would commit the very defect under test — the
 * next bench run would then measure a fixture this suite poisoned.
 */
function isolatedTiny() {
  // The fixture's key home is `<dir>-keys`, beside it: both inside one swept temp folder.
  return buildFixture("tiny", { quiet: true, dir: join(createTempDir("ch-fxdrift-"), "fixture") });
}

const here = dirname(fileURLToPath(import.meta.url));
const benchDir = join(here, "..", "..", "bench");

function benchSources(): ReadonlyArray<{ name: string; text: string }> {
  return readdirSync(benchDir)
    .filter((f) => f.endsWith(".bench.ts"))
    .map((f) => ({ name: f, text: readFileSync(join(benchDir, f), "utf8") }));
}

/** Every write a bench issues must name the sink. These are the DbClient
 * methods that append rows to a chat; a new one added to this list is a new
 * way to poison a fixture. */
const WRITE_METHODS = ["createMessage", "createToolCall", "createTimelineRef", "createMetricsSnapshot"];

describe("bench fixtures: writes never land in a read target", () => {
  test("no bench passes a read-target expression as a write's chat_id", () => {
    // The read targets are chosen positionally (`chatIds[0]`,
    // `chatIds[...length / 2]`, `megaChatId`). A write whose `chat_id` is any
    // of those expressions is the exact defect.
    const readTargetExpr = /chat_id:\s*(?:\w+\.)?(?:chatIds\[|megaChatId|readChatId\b)/;
    const offenders: string[] = [];
    for (const { name, text } of benchSources()) {
      for (const line of text.split("\n")) {
        if (!readTargetExpr.test(line)) continue;
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
    expect(
      offenders,
      "a bench is writing into a chat the read benches read — use users[i].writeSinkChatId",
    ).toEqual([]);
  });

  test("every bench that writes to a chat names the write sink", () => {
    const offenders: string[] = [];
    for (const { name, text } of benchSources()) {
      const writes = WRITE_METHODS.some((m) => text.includes(`${m}(`));
      if (!writes) continue;
      if (!text.includes("writeSinkChatId")) {
        offenders.push(`${name} calls a create* method but never names writeSinkChatId`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every bench suite asserts its fixture is pristine before measuring", () => {
    // The CALL, not the identifier. A first cut of this test asked whether the
    // file contained the string `assertReadTargetsPristine` — which the import
    // line satisfies on its own, so deleting the actual call left the test
    // green. Mutation-testing it is what exposed that; the guard now ignores
    // import lines and requires an invocation.
    const offenders: string[] = [];
    for (const { name, text } of benchSources()) {
      if (!text.includes("buildFixture(")) continue;
      const calls = text
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("import"))
        .some((line) => /(?<!function\s)assertReadTargetsPristine\s*\(/.test(line));
      if (!calls) offenders.push(`${name} builds a fixture but never checks it for drift`);
    }
    expect(offenders).toEqual([]);
  });

  test("the write sink is not reachable through the read population", () => {
    const fx = isolatedTiny();
    try {
      const user = fx.users[0]!;
      expect(user.writeSinkChatId).not.toBe("");
      expect(user.chatIds).not.toContain(user.writeSinkChatId);
      expect(benchReadTargets(fx)).not.toContain(user.writeSinkChatId);
    } finally {
      fx.close();
    }
  });

  test("assertReadTargetsPristine accepts a pristine fixture", () => {
    const fx = isolatedTiny();
    try {
      expect(() => assertReadTargetsPristine(fx)).not.toThrow();
    } finally {
      fx.close();
    }
  });

  /**
   * MUTATION PROOF. The guard is only worth having if it fails when the thing
   * it guards is broken, so break it: append one message to a read target and
   * require the check to refuse the fixture. Without this, a guard that always
   * passes would look identical to a guard that works.
   */
  test("MUTATION: one message appended to a read target makes the guard refuse", () => {
    const fx = isolatedTiny();
    try {
      const user = fx.users[0]!;
      const poisoned = benchReadTargets(fx)[0]!;
      fx.db.createMessage(
        { chat_id: poisoned, role: "assistant", content: "drift" },
        user.userId,
      );
      expect(() => assertReadTargetsPristine(fx)).toThrow(/DRIFTED/);
      // And it must say WHICH target and HOW to recover — a guard that fails
      // without naming the remedy just moves the puzzle.
      expect(() => assertReadTargetsPristine(fx)).toThrow(/--rebuild/);
    } finally {
      fx.close();
    }
  });

  /** Writing to the SINK must NOT trip the guard — otherwise every write bench
   * fails on its second iteration and the guard is unusable. */
  test("MUTATION CONTROL: appending to the sink leaves the guard satisfied", () => {
    const fx = isolatedTiny();
    try {
      const user = fx.users[0]!;
      for (let i = 0; i < 25; i += 1) {
        fx.db.createMessage(
          { chat_id: user.writeSinkChatId, role: "assistant", content: "sink" },
          user.userId,
        );
      }
      expect(() => assertReadTargetsPristine(fx)).not.toThrow();
    } finally {
      fx.close();
    }
  });
});
