// @vitest-environment node
/**
 * A WORKER ISOLATE READS NO SETTINGS FILE (wf1c-design M-6; WF-1b item 1's
 * leftover: the awareness, content-search and db workers reached the config
 * owner and would have read the file themselves). The main thread HANDS its
 * resolved snapshot to every Worker it creates (worker environment data), so:
 *   - a worker created after the main thread resolved a good snapshot reads
 *     THAT snapshot even when the file on disk is corrupt by then;
 *   - a worker handed nothing refuses a setting read `config_unreadable`
 *     (`worker_settings_not_handed`) instead of reading the file, and every
 *     raw read/write in a worker refuses the same way.
 */
import { afterAll, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setEnvironmentData, Worker } from "node:worker_threads";

import { isolateHarnessConfig, plantSettingsDocument } from "../helpers/isolated-config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { modulePath } from "../helpers/module-resolver.ts";

const configPath = isolateHarnessConfig("worker-settings-");
const harnessConfigUrl = pathToFileURL(join(process.cwd(), modulePath("harness-config.ts"))).href;
const { getWorkerTimeoutMs, refreshSettingsSnapshot } = await import("../../server/kernel/harness-config.ts");

type WorkerReport = Readonly<{ state: string; reason?: string; timeoutMs?: number | string; raw: string }>;

/** A real worker isolate that loads the config owner and reports what it reads. */
function inWorker(): Promise<WorkerReport> {
  const script = join(createTempDir("worker-settings-script-"), "probe.mjs");
  writeFileSync(script, `
    import { parentPort } from "node:worker_threads";
    const config = await import(${JSON.stringify(harnessConfigUrl)});
    const state = config.refreshSettingsSnapshot();
    let timeoutMs; try { timeoutMs = config.getWorkerTimeoutMs(); } catch (error) { timeoutMs = error.code; }
    let raw; try { config.readConfigRaw(); raw = "read"; } catch (error) { raw = error.code; }
    parentPort.postMessage({ state: state.state, reason: state.reason, timeoutMs, raw });
  `);
  const worker = new Worker(pathToFileURL(script), { execArgv: [...process.execArgv, "--experimental-strip-types"], env: { ...process.env, HARNESS_CONFIG_PATH: configPath } });
  return new Promise((resolve, reject) => {
    worker.once("message", (report: WorkerReport) => { void worker.terminate(); resolve(report); });
    worker.once("error", reject);
  });
}

afterAll(() => { plantSettingsDocument(configPath, "{}"); });

test("a worker reads the snapshot its spawning thread handed it — even with the file corrupt on disk by then", async () => {
  const document = { workerThreads: { timeoutMs: 43_210 } };
  plantSettingsDocument(configPath, JSON.stringify(document));
  expect(getWorkerTimeoutMs()).toBe(43_210);
  writeFileSync(configPath, "{ half-saved");
  const report = await inWorker();
  expect(report).toMatchObject({ state: "ok", timeoutMs: 43_210, raw: "config_unreadable" });
  // The main thread is still on the good snapshot (its refresh records the corrupt file, keeps the last good one).
  expect(refreshSettingsSnapshot().state).toBe("unreadable");
  expect(getWorkerTimeoutMs()).toBe(43_210);
});

test("a worker handed NOTHING refuses a setting read instead of reading the file", async () => {
  plantSettingsDocument(configPath, JSON.stringify({ workerThreads: { timeoutMs: 1_234 } }));
  // Planted: nothing handed (as if spawned before any snapshot existed).
  setEnvironmentData("bridlewise.harnessSettings", undefined);
  const report = await inWorker();
  expect(report.state).toBe("unreadable");
  expect(report.reason).toMatch(/worker_settings_not_handed/u);
  expect(report.timeoutMs).toBe("config_unreadable");
  expect(report.raw).toBe("config_unreadable");
  refreshSettingsSnapshot();
});
