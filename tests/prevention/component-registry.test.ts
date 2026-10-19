// @vitest-environment node
/**
 * Prevention test — SPO: the component registry + its registering owners.
 *
 * The harness anatomy view needs every live component of the server
 * process to be VISIBLE: the registry (server/observability/
 * component-registry.ts) is the single owner of that list, and every
 * choke point that creates a component registers ON ITS OWN create/destroy
 * path (the forgetting-is-impossible shape — no call site remembers, the
 * owner cannot forget).
 *
 * Assurance classes:
 *   A. the registry itself: register → visible with kind/label/provenance/
 *      facts; unregister → gone; unregister is idempotent (an owner's
 *      error+exit double-path cannot throw out of teardown).
 *   B. BEHAVIORAL, per choke point — the component is really there while it
 *      lives and really gone when it dies:
 *        - worker pool (runWorkerTask → worker-thread entry → gone on settle)
 *        - db threads (AsyncDbClient.open → writer+reader db-thread entries
 *          → gone on close)
 *        - run feeds (openRunFeed → run-feed entry → gone on release)
 *        - the sampler timer (startResourceSampler → sampler-timer entry →
 *          gone on stopResourceSampler)
 *   C. WIRING, for the choke points a behavioral arm cannot drive without
 *      spawning heavy children (the MCP stdio spawn, the folder watch):
 *      the registration call is pinned INSIDE the owner's create/destroy
 *      function bodies — remove one registration call and the arm fails.
 *   D. leak-free: after every case, the registry is EMPTY (a closed
 *      component leaves; an entry that outlives its component is a lie
 *      the anatomy view would repeat).
 *
 * The raw-handle side of this invariant (no fs.watch/setInterval/spawn/
 * new Worker outside the registering owners) is owned by
 * raw-handle-owner.test.ts.
 */
import { describe, test, expect, afterAll } from "vitest";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { runWorkerTask, shutdownWorkerPool } from "../../server/run/worker-pool.ts";
import { MapNotReadyError } from "../../server/kernel/errors.ts";
import { openRunFeed, endRunFeed, releaseRunFeed, releaseAllRunFeeds } from "../../server/run/run-feed.ts";
import { startResourceSampler, stopResourceSampler } from "../../server/observability/metrics-bridge.ts";
import {
  registerComponent,
  componentSnapshot,
  registeredComponentCount,
  componentCountsByKind,
  formatComponentsText,
} from "../../server/observability/component-registry.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const echoUrl = new URL("../fixtures/workers/echo-worker.ts", import.meta.url);

// ── A. the registry itself ────────────────────────────────────────────────

describe("A. the registry — register, unregister, idempotence, snapshot", () => {
  test("a registered component is visible with its full entry shape and gone after unregister", () => {
    const before = registeredComponentCount();
    const unregister = registerComponent({
      kind: "worker-thread",
      label: "arm-label",
      provenance: "the owning test",
      facts: { task: "arm-key", threadId: 7 },
    });
    expect(registeredComponentCount()).toBe(before + 1);
    const entry = componentSnapshot().find((c) => c.label === "arm-label");
    expect(entry, "the component must be in the snapshot").not.toBeUndefined();
    expect(entry!.kind).toBe("worker-thread");
    expect(entry!.provenance).toBe("the owning test");
    expect(entry!.facts).toEqual({ task: "arm-key", threadId: 7 });
    expect(entry!.createdAtIso, "the entry records when the component was created").toMatch(/^\d{4}-\d{2}-\d{2}T/);
    unregister();
    expect(registeredComponentCount()).toBe(before);
    expect(componentSnapshot().find((c) => c.label === "arm-label")).toBeUndefined();
  });

  test("unregister is idempotent — an owner's error+exit double-path cannot throw", () => {
    const unregister = registerComponent({ kind: "run-feed", label: "idempotence", provenance: "test" });
    unregister();
    expect(() => unregister()).not.toThrow();
    expect(componentSnapshot().find((c) => c.label === "idempotence")).toBeUndefined();
  });

  test("counts by kind + the text format render the live set", () => {
    const a = registerComponent({ kind: "mcp-child", label: "mcp a", provenance: "test" });
    const b = registerComponent({ kind: "mcp-child", label: "mcp b", provenance: "test" });
    const counts = componentCountsByKind();
    expect(counts["mcp-child"] ?? 0).toBeGreaterThanOrEqual(2);
    const text = formatComponentsText(componentSnapshot());
    expect(text).toContain("mcp-child");
    expect(text).toContain("mcp a");
    expect(text).toContain("mcp b");
    a();
    b();
  });
});

// ── B. behavioral — each choke point really registers and really unregisters ──

describe("B. the choke points register at their own create/destroy paths", () => {
  test("worker pool: a pooled worker is a registry component for exactly its flight", async () => {
    const before = registeredComponentCount();
    const inFlight = runWorkerTask<number>({
      workerUrl: echoUrl,
      workerData: { value: 11 },
      errorClass: MapNotReadyError,
      label: "registry-arm",
      dedupKey: `registry-arm-${Date.now()}`,
      timeoutMs: 5000,
      validateOk: (msg) => (msg as { value?: number }).value ?? 0,
    });
    const during = componentSnapshot().filter((c) => c.kind === "worker-thread" && c.label === "registry-arm");
    expect(during.length, "a live pooled worker must be a registry component").toBe(1);
    expect(during[0]!.facts.task, "the entry carries the task it is running").toContain("registry-arm-");
    expect(during[0]!.facts.threadId, "the entry carries the worker's thread id").toEqual(expect.any(Number));
    expect(during[0]!.provenance).toContain("worker-pool.ts");
    await inFlight;
    for (let i = 0; i < 50 && registeredComponentCount() > before; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(
      componentSnapshot().filter((c) => c.kind === "worker-thread" && c.label === "registry-arm"),
      "the entry left with the worker it described",
    ).toEqual([]);
    expect(registeredComponentCount(), "the pool settles back to the pre-flight count").toBe(before);
  });

  test("db threads: the writer + readers are registry components, released on close", async () => {
    const dir = createTempDir("ch-component-db-");
    try {
      const path = join(dir, "web.db");
      new DbClient({ path }).close();
      const before = registeredComponentCount();
      const adb = await AsyncDbClient.open({ path, readers: 1 });
      const dbThreads = componentSnapshot().filter((c) => c.kind === "db-thread");
      expect(dbThreads.length, "the writer and the one reader must both be registered").toBe(2);
      expect(dbThreads.every((c) => c.provenance.includes("thread-backend.ts"))).toBe(true);
      expect(dbThreads.map((c) => c.label).sort()).toEqual(["db reader", "db writer"]);
      await adb.close();
      expect(
        componentSnapshot().filter((c) => c.kind === "db-thread"),
        "close() releases every db thread entry",
      ).toEqual([]);
      expect(registeredComponentCount()).toBe(before);
    } finally {
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("run feed: an open feed is a registry component; release removes it", () => {
    const before = registeredComponentCount();
    const runId = `registry-arm-run-${Date.now()}`;
    openRunFeed(runId, { userId: "user-arm", chatId: null });
    const entry = componentSnapshot().find((c) => c.kind === "run-feed" && c.label === runId);
    expect(entry, "an open run feed must be a registry component").not.toBeUndefined();
    expect(entry!.facts.userId).toBe("user-arm");
    endRunFeed(runId, { event: "done", data: null });
    releaseRunFeed(runId);
    expect(componentSnapshot().find((c) => c.kind === "run-feed" && c.label === runId)).toBeUndefined();
    expect(registeredComponentCount()).toBe(before);
  });

  test("sampler: startResourceSampler registers the timer; stop releases it", () => {
    const before = registeredComponentCount();
    startResourceSampler();
    const entry = componentSnapshot().find((c) => c.kind === "sampler-timer");
    expect(entry, "the standing sampler timer must be a registry component while it runs").not.toBeUndefined();
    expect(entry!.facts.intervalMs, "the entry carries the interval it ticks on").toEqual(expect.any(Number));
    stopResourceSampler();
    expect(componentSnapshot().find((c) => c.kind === "sampler-timer")).toBeUndefined();
    expect(registeredComponentCount()).toBe(before);
  });
});

// ── C. wiring — the registration calls live INSIDE the owners' bodies ──────

describe("C. wiring — the create/destroy paths contain the registration calls (mutation arms)", () => {
  const SERVER_ROOT = "server";

  function bodyOf(source: string, startMarker: string, endMarker: string): string {
    const start = source.indexOf(startMarker);
    expect(start, `${startMarker} must exist`).toBeGreaterThan(-1);
    const end = source.indexOf(endMarker, start);
    return source.slice(start, end === -1 ? undefined : end);
  }

  test("mcp-runtime-bridge: mcpStdioSpawn registers the child and unregisters on exit", () => {
    const src = readFileSync(join(SERVER_ROOT, "integrations/mcp-runtime-bridge.ts"), "utf8");
    const body = bodyOf(src, "function mcpStdioSpawn(", "\n}\n");
    expect(body, "the spawn path must register the child at the owner").toContain("registerComponent({");
    expect(body, "the entry must say what started the child (the config entry)").toContain("tools.mcpServers");
    expect(body, "the entry must say how the child runs (confined or not)").toContain("confinement: plan.kind");
    // The release is an exit/error listener, so it is guarded (SCALE-CR1 C3).
    expect(body, "the release unregisters the entry").toMatch(/const release = guarded\("[a-z.-]+", \(\): void => \{\s*unregister\(\);/);
    expect(body, "the child's exit must release the entry").toMatch(/\.once\("exit", release\)/);
    expect(body, "a failed spawn must release the entry too").toMatch(/\.once\("error", release\)/);
  });

  test("intelligence-bridge: watchIndexedFolder registers the watch; stopFolderWatch releases it", () => {
    const src = readFileSync(join(SERVER_ROOT, "intelligence/intelligence-bridge.ts"), "utf8");
    const stopBody = bodyOf(src, "function stopFolderWatch(", "\n}\n");
    const watchBody = bodyOf(src, "function watchIndexedFolder(", "\nfunction onMapReady");
    expect(watchBody, "the watch-creation path must register at the owner").toContain("registerComponent({");
    expect(watchBody).toContain("unregisterComponent");
    expect(stopBody, "the stop path must release the entry (and the watch with it)").toContain("entry.unregisterComponent();");
  });
});

// ── D. leak-free — the registry is empty after every case ─────────────────

describe("D. the registry is leak-free", () => {
  test("after every case in this file the registry holds nothing that this file opened", () => {
    // The behavioral cases above each asserted their own cleanup; this arm
    // is the process-level backstop: anything still registered here was
    // leaked by a create path without a destroy path — exactly the lie the
    // anatomy view must never tell.
    const leftovers = componentSnapshot().filter((c) => c.provenance.includes("test"));
    expect(leftovers, "leaked registry entries: " + leftovers.map((c) => `${c.kind}:${c.label}`).join(", ")).toEqual([]);
  });
});

afterAll(() => {
  // Shared teardown so no pooled worker or feed outlives the file.
  shutdownWorkerPool();
  releaseAllRunFeeds();
  stopResourceSampler();
});
