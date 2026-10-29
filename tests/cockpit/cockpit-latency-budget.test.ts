// @vitest-environment node
/**
 * Latency budget (§1.5 F2) — the mechanizable slice at unit level.
 *
 * The full budget table is enforced where each bound is honestly
 * measurable:
 *   - boot <200ms warm  → HERE: the client-side orchestration overhead of
 *     the registration sequence is measured with instant transport stubs.
 *     Network time is the server's bill; everything the CLIENT adds on top
 *     must fit well inside the 200ms warm budget.
 *   - zero-late-mount reveal → tests/cockpit/cockpit-boot-owner.test.ts
 *     (jsdom) + tests/cockpit/e2e/cockpit-boot-owner.spec.ts (real browser,
 *     also asserts the <100ms static-shell first render).
 *   - keystroke→paint <16ms, event→screen <100ms, finding→seam <300ms →
 *     NOT mechanizable in this phase (no flow/computer surfaces exist yet);
 *     they land with those surfaces' own perf tests. Stating that here is
 *     the honest scope, not a waiver.
 */
import { describe, expect, test, vi } from "vitest";

import { threadCpuWorkMs } from "../../engine/src/shared/run-cpu.ts";

import { createRegistration, type ProbeLine } from "../../src/cockpit/boot/probes.ts";

const WARM_BOOT_CLIENT_OVERHEAD_MS = 100; // half the §1.5 200ms warm budget

describe("cockpit latency budget — client-side boot overhead", () => {
  test("registration orchestration completes within the warm budget over instant transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        const body = url.includes("/api/health")
          ? { status: "ok" }
          : url.includes("/api/auth/status")
            ? { setupRequired: false, authenticated: true, username: "ada", isAdmin: true }
            : url.includes("/api/schema/ui")
              ? { menus: [], panels: [], widgets: [] }
              : url.includes("/api/projects")
                ? []
                : null;
        if (body === null) throw new Error(`unstubbed: ${url}`);
        return { ok: true, status: 200, json: async () => body } as unknown as Response;
      }),
    );

    const lines: ProbeLine[] = [];
    // Judged without a wall clock (NO-LOAD-BLOCK), in two halves a busy host
    // cannot fail: the registration COMPLETES WITH NO TIMER ADVANCED (only
    // microtasks run, so no debounce, retry timer or poll sits on the warm
    // path), and its compute, this thread's CPU work, fits the budget. The
    // clock (Date) stays real: each line's `ms` is a real measurement.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate"] });
    const t0 = threadCpuWorkMs();
    let doneMs = -1;
    const reg = createRegistration({
      onLine: (l) => lines.push(l),
      onAuthGate: () => {
        throw new Error("warm signed-in boot must not gate");
      },
      onComplete: () => {
        doneMs = threadCpuWorkMs() - t0;
      },
    });
    const started = reg.start();
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    expect(doneMs, "the registration completed with no timer advanced").toBeGreaterThanOrEqual(0);
    vi.useRealTimers();
    await started;

    expect(doneMs).toBeGreaterThanOrEqual(0);
    expect(doneMs).toBeLessThan(WARM_BOOT_CLIENT_OVERHEAD_MS);
    // Warm signed-in column: session · schema · index — three lines.
    expect(lines.map((l) => l.id)).toEqual(["session", "schema", "index"]);
    // Every ms is a real measurement (≥1, integer).
    for (const l of lines) {
      expect(Number.isInteger(l.ms)).toBe(true);
      expect(l.ms).toBeGreaterThanOrEqual(1);
    }
    vi.unstubAllGlobals();
  });
});
