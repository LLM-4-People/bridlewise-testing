// @vitest-environment node
/**
 * THE WEB SERVER'S METRICS COLLECTOR IS BUILT FROM THE CONFIGURED SECTION
 * (specs/cfg-final.md §17 B4).
 *
 * `server/observability/metrics-bridge.ts` built its collector from the frozen
 * `DEFAULT_PERFORMANCE_CONFIG`, while the engine CLI read the document's
 * `performance` section: an operator's sampling, cardinality or `enabled`
 * reached one collector and not the other. Both now resolve the section with
 * the engine's one `performanceConfigOf`. The collector stamps the hash of the
 * config it runs on into every snapshot, which is what is compared here.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { canonicalHash } from "../../engine/src/kernel/integrity.ts";
import { DEFAULT_PERFORMANCE_CONFIG } from "../../engine/src/performance/performance-config.ts";
import { configuredPerformance } from "../../server/kernel/harness-config.ts";
import { isolateHarnessConfig, plantSettingsDocument } from "../helpers/isolated-config.ts";

const path = isolateHarnessConfig("metrics-bridge-config-");
const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;

describe("the server metrics collector's configuration", () => {
  test("is the document's performance section, not the frozen defaults", async () => {
    const performance = { ...original.performance, sampling: { ...original.performance.sampling, maxTracesPerScope: 7 } };
    plantSettingsDocument(path, `${JSON.stringify({ ...original, performance }, null, 2)}\n`);
    const configured = configuredPerformance();
    expect(configured.sampling.maxTracesPerScope).toBe(7);
    // Imported after the plant: the collector is built lazily, once, from the section in force.
    const { getMetricsSnapshot } = await import("../../server/observability/metrics-bridge.ts");
    const snapshot = getMetricsSnapshot();
    expect(snapshot.configHash).toBe(canonicalHash(configured));
    expect(snapshot.configHash).not.toBe(canonicalHash(DEFAULT_PERFORMANCE_CONFIG));
  });
});
