// @vitest-environment node
/**
 * Mechanical prevention tests for the harvested-issue fixes.
 *
 * Enforces the verification criteria mechanically (source-scan + contract):
 * auth.ts uses async `scrypt` (no `scryptSync`).
 * intelligence-bridge no longer constructs QuickViewIndex on the
 * main thread (moved to a worker); the worker file exists + rehydrates.
 * DependencyGraph no-container fallback dims are config-driven
 * (no bare 800/600 fallback — uses cfg.fallbackWidth/fallbackHeight).
 * auto-check-runner has no `spawnSync` + no `256 * 1024` /
 * `MAX_CAPTURE` literal; the capture cap is config-driven.
 * auto-check-runner uses async `spawn` (no `spawnSync`).
 * Contract: the config file declares the new sections the accessors read.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
// The SHIPPED config by its default path — deliberately NOT
// serverConfig.harnessConfigPath: with isolate:false, the models tests set
// HARNESS_CONFIG_PATH to a minimal temp fixture at module scope and that env
// leaks across files in the shared worker. These assertions are about what
// the repo ships, not the ambient env.
import { DEFAULT_HARNESS_CONFIG_PATH } from "../../server/kernel/config.ts";
import { resolve } from "node:path";
import { serverConfig } from "../../server/kernel/config.ts";
import { getAutoCheckMaxCaptureBytes, getQualityConfig } from "../../server/kernel/harness-config.ts";
import { read } from "../helpers/source-scan.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
describe("— auth.ts async scrypt (no event-loop blocking)", () => {
  const auth = read(modulePathMatching("server/auth/auth.ts"));

  test("auth.ts imports the async `scrypt` (not scryptSync)", () => {
    expect(auth).toMatch(/\bscrypt\b/);
    expect(auth).toContain('from "node:crypto"');
  });

  test("auth.ts no longer uses scryptSync", () => {
    expect(auth).not.toMatch(/scryptSync/);
  });

  test("hashPassword + verifyPassword are async (return Promises)", () => {
    expect(auth).toMatch(/export\s+async\s+function\s+hashPassword/);
    expect(auth).toMatch(/export\s+async\s+function\s+verifyPassword/);
  });
});

describe("— QuickViewIndex built off-thread (no main-thread construction)", () => {
  const bridge = read(modulePath("intelligence-bridge.ts"));

  test("intelligence-bridge no longer constructs QuickViewIndex on the main thread", () => {
    // The CPU-heavy `new QuickViewIndex(...)` was moved to the worker; the
    // bridge rehydrates via fromBuiltState. A main-thread `new QuickViewIndex`
    // would re-introduce the event-loop wedge.
    expect(bridge).not.toMatch(/new\s+QuickViewIndex\(/);
  });

  test("the bridge rehydrates the index from the worker state (fromBuiltState)", () => {
    expect(bridge).toContain("QuickViewIndex.fromBuiltState");
  });

  test("the quick-view worker file exists + builds the index off-thread", () => {
    const workerPath = resolve(process.cwd(), modulePath("quick-view-worker.ts"));
    expect(existsSync(workerPath), "server/quick-view-worker.ts must exist").toBe(true);
    const worker = read(modulePath("quick-view-worker.ts"));
    expect(worker).toContain("new QuickViewIndex");
    expect(worker).toContain("toBuiltState");
    expect(worker).toMatch(/node:worker_threads/);
  });

  test("quickView throws MapNotReadyError on a miss (never blocks) — the tool degrades", () => {
    expect(bridge).toContain("MapNotReadyError");
    expect(bridge).toContain("quick_view_not_ready");
  });
});

// (The DependencyGraph fallback-dims class died with the old tree.)

describe("7 — auto-check-runner async + config-driven capture", () => {
  const runner = read(modulePath("auto-check-runner.ts"));

  test("auto-check-runner no longer uses spawnSync (async spawn)", () => {
    expect(runner).not.toMatch(/spawnSync/);
    // THE PROPERTY MOVED, AND IT MOVED UPWARDS. The original fix was "import
    // the async `spawn` rather than the synchronous one", because a
    // synchronous spawn wedged the single-threaded HTTP server for the whole
    // typecheck. The runner now imports NEITHER: it asks the confinement owner
    // for a plan and hands it to `spawnPlanned`, which is asynchronous — so
    // the wedge is still impossible and the check is also sandboxed, which the
    // original fix did not give.
    //
    // Asserted on the async door by name rather than on the absence of
    // `spawnSync`, because an absence alone would also be satisfied by a
    // runner that had stopped spawning anything.
    expect(runner).toMatch(/\bspawnPlanned\b/);
    expect(runner).not.toMatch(/from\s+["']node:child_process["']/);
  });

  test("auto-check-runner no longer hardcodes the capture cap", () => {
    expect(runner).not.toMatch(/256\s*\*\s*1024/);
    expect(runner).not.toMatch(/\bMAX_CAPTURE\b/);
  });

  test("auto-check-runner reads the capture cap from the config owner", () => {
    expect(runner).toContain("getAutoCheckMaxCaptureBytes");
  });

  test("runTypecheck is async (returns a Promise)", () => {
    expect(runner).toMatch(/async\s+function\s+runTypecheck/);
  });

  test("spawnCapture uses StringDecoder (no UTF-8 chunk-boundary corruption)", () => {
    // A multi-byte UTF-8 char split across two `data` chunks would be
    // corrupted by per-chunk `.toString("utf8")` into replacement chars.
    // StringDecoder buffers the incomplete sequence until the next chunk.
    expect(runner).toContain("StringDecoder");
    expect(runner).toContain('from "node:string_decoder"');
    // The naive per-chunk decode is gone.
    expect(runner).not.toMatch(/d\.toString\("utf8"\)/);
  });

  test("getAutoCheckMaxCaptureBytes reads the config-declared value (contract)", () => {
    // The config file declares tools.autoCheck.maxCaptureBytes = 262144.
    expect(getAutoCheckMaxCaptureBytes()).toBe(262_144);
  });
});

describe("— quality config contract (the config file declares the weights)", () => {
  test("bridlewise.config.json declares webUi.quality with the default weights", () => {
    const raw = JSON.parse(readFileSync(DEFAULT_HARNESS_CONFIG_PATH, "utf8")) as {
      webUi?: { quality?: Record<string, unknown> };
    };
    const q = raw.webUi?.quality;
    expect(q, "webUi.quality must be declared").toBeDefined();
    // The accessor must return EXACTLY what the config declares (single
    // source of truth — no drift between the accessor and the file).
    const cfg = getQualityConfig();
    for (const [k, v] of Object.entries(q ?? {})) {
      // toEqual, not toBe: the section now carries the nested lintGate
      // object; for the scalar weights the two are equivalent.
      expect((cfg as Record<string, unknown>)[k], `quality.${k} must match config`).toEqual(v);
    }
  });
});

describe("— auto-check config contract (the config file declares the cap)", () => {
  test("bridlewise.config.json declares tools.autoCheck.maxCaptureBytes", () => {
    const raw = JSON.parse(readFileSync(DEFAULT_HARNESS_CONFIG_PATH, "utf8")) as {
      tools?: { autoCheck?: Record<string, unknown> };
    };
    expect(raw.tools?.autoCheck?.maxCaptureBytes).toBe(262_144);
  });
});

describe("— graph fallback config contract (the config file declares the dims)", () => {
  test("bridlewise.config.json declares webUi.graph.fallbackWidth/fallbackHeight", () => {
    const raw = JSON.parse(readFileSync(DEFAULT_HARNESS_CONFIG_PATH, "utf8")) as {
      webUi?: { graph?: Record<string, unknown> };
    };
    expect(raw.webUi?.graph?.fallbackWidth).toBe(800);
    expect(raw.webUi?.graph?.fallbackHeight).toBe(600);
  });
});
