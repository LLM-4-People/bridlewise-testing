// @vitest-environment node
/**
 * A SETTINGS FILE THAT GOES BAD WHILE THE SERVER RUNS IS A STATE, NOT A CRASH.
 *
 * ── The defect (reproduced, wf1a-design H-1) ──
 * Since a corrupt config became a refusal (`config_unreadable`) instead of a
 * silent `{}`, a background callback that read the settings THREW. Two paths
 * in the folder watch, driven here:
 *   - the watch listener read its debounce inside the event: the throw became
 *     the watcher's `error` event and the watch was STOPPED for good — the
 *     project was never re-indexed again after a half-saved settings file;
 *   - its debounce timer kicked a rebuild whose worker door read the pool
 *     size synchronously: the throw escaped the timer, and the server's
 *     `uncaughtException` handler exits the process. A user hand-editing
 *     `bridlewise.config.json` took the server down at the next file event.
 *
 * ── The rule ──
 * Background work resolves its settings when it is ARMED, never inside its
 * event, timer or watch callback, and a promise-returning door never throws
 * synchronously. The refusal is published as a state
 * (`refreshSettingsSnapshot`/`getSettingsStoreState`, the `settings.storeState`
 * signal) and logged once through the always-on console sink; the last good
 * snapshot stays in force (tests/unit/config-refusal-server.test.ts drives the
 * real server with an open SSE stream).
 *
 * The driver runs in a CHILD process carrying the server's own fatal
 * handler (`uncaughtException` → exit 1), so "the server survives" is
 * measured, not inferred.
 */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { PRODUCT_NAME } from "../../engine/src/kernel/product-identity.ts";

const REPO = join(import.meta.dirname, "..", "..");

const DRIVER = [
  'import { writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "const { OUT, PROJECT, CONFIG, REPO } = process.env;",
  // The server's fatal handler, verbatim in effect: an uncaught exception exits.
  "process.on('uncaughtException', (e) => { writeFileSync(OUT, JSON.stringify({ crashed: String(e.code ?? e.message) })); process.exit(1); });",
  "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
  "const bridge = await import(join(REPO, 'server/intelligence/intelligence-bridge.ts'));",
  "const metrics = await import(join(REPO, 'server/observability/metrics-bridge.ts'));",
  "const config = await import(join(REPO, 'server/kernel/harness-config.ts'));",
  "const registry = await import(join(REPO, 'server/observability/component-registry.ts'));",
  "const watching = () => registry.componentSnapshot().filter((c) => c.kind === 'folder-watch' && c.label === PROJECT).length;",
  "bridge.beginIndexingIfConfigured(PROJECT);",
  "for (let i = 0; i < 600 && watching() === 0; i += 1) await sleep(50);",
  "const armed = watching();",
  "metrics.startResourceSampler();",
  "await sleep(600);",
  // The settings file goes bad (a half-saved write), THEN the project changes.
  "writeFileSync(CONFIG, '{\"half\": ');",
  "writeFileSync(join(PROJECT, 'src', 'b.ts'), 'export const b = 2;\\n');",
  "await sleep(1500);",
  "metrics.sampleResourceOnce();",
  // What the next request's start does: re-resolve the snapshot.
  "const state = config.refreshSettingsSnapshot();",
  "metrics.stopResourceSampler();",
  "writeFileSync(OUT, JSON.stringify({ survived: true, armed, stillWatching: watching(), state: state.state, reason: state.reason ?? '' }));",
  "process.exit(0);",
].join("\n");

describe("a settings file that goes bad at runtime", () => {
  test("the folder watch, its rebuild timer and the resource sampler survive it; the refusal is a state, logged once", () => {
    const root = createTempDir("ch-config-background-");
    const project = join(root, "project");
    mkdirSync(join(project, "src"), { recursive: true });
    writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
    const configPath = join(root, "bridlewise.config.json");
    expect(atomicWriteFile(configPath, `${JSON.stringify({
      codeIntelligence: { indexWatchDebounceMs: 50 },
      performance: { resourceSampler: { enabled: true, intervalMs: 50 } },
    })}\n`, { createMode: 0o600 }).success).toBe(true);
    const driver = join(root, "driver.mjs");
    writeFileSync(driver, DRIVER);
    const out = join(root, "out.json");
    const run = spawnSync(process.execPath, [driver], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: { ...process.env, OUT: out, PROJECT: project, CONFIG: configPath, REPO, HARNESS_CONFIG_PATH: configPath },
    });
    const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
    expect(report, run.stderr.slice(-2000)).toMatchObject({ survived: true, armed: 1, state: "unreadable" });
    expect(report["stillWatching"], "the watch outlives a refused settings file (it used to be stopped for good)").toBe(1);
    expect(String(report["reason"])).toContain("config_json_invalid");
    expect(run.status).toBe(0);
    // Logged through the always-on console sink, ONCE for the transition.
    const refusals = run.stderr.split("\n").filter((line) => line.includes("config_unreadable: the settings file"));
    expect(refusals, refusals.join("\n")).toHaveLength(1);
  });

  test("booting against an unreadable settings file is ONE typed refusal line and EX_CONFIG, not a stack", () => {
    const root = createTempDir("ch-config-boot-");
    const configPath = join(root, "bridlewise.config.json");
    expect(atomicWriteFile(configPath, "{ \"half\": ", { createMode: 0o600 }).success).toBe(true);
    const boot = spawnSync(process.execPath, [join(REPO, "server", "index.ts")], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: {
        ...process.env, HARNESS_CONFIG_PATH: configPath, HARNESS_WEB_PORT: "0",
        HARNESS_WEB_DB_PATH: join(root, "web.db"), HARNESS_WEB_TIMELINE_DB_PATH: join(root, "timeline.db"),
      },
    });
    expect(boot.status, boot.stderr).toBe(78);
    expect(boot.stderr).toMatch(/refusing to start: config_unreadable/u);
    expect(boot.stderr, "no stack trace").not.toMatch(/\n\s+at /u);
  });

  test("booting under a temp root INSIDE the safety floor is ONE typed refusal line and EX_CONFIG (TMPDIR-KEEPOUT-001)", () => {
    // wf-1b3a-correctness M2 (V8): the server's refusal had no driven test.
    const root = createTempDir("ch-config-boot-tmp-");
    const home = join(root, "home");
    const keptOut = join(home, ".local", "state", `${PRODUCT_NAME}-tmp`, "run");
    mkdirSync(keptOut, { recursive: true, mode: 0o700 });
    const boot = spawnSync(process.execPath, [join(REPO, "server", "index.ts")], {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: {
        ...process.env, HOME: home, TMPDIR: keptOut, HARNESS_WEB_PORT: "0",
        HARNESS_WEB_DB_PATH: join(root, "web.db"), HARNESS_WEB_TIMELINE_DB_PATH: join(root, "timeline.db"),
      },
    });
    expect(boot.status, boot.stderr).toBe(78);
    expect(boot.stderr).toMatch(/refusing to start: temporary_root_kept_out/u);
    expect(boot.stderr, "no stack trace").not.toMatch(/\n\s+at /u);
  });
});
