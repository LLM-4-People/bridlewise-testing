/**
 * The forge section the forge tests use (a test fixture, not a test file):
 * one complete, valid `forge` section, independent of the repository's own
 * configuration, so a rename there never moves a test's expectations.
 */
import { FORGE_CONFIG_SCHEMA, type ForgeSettings } from "../../src/workflow/forge/forge-config.ts";

export const SETTINGS: ForgeSettings = FORGE_CONFIG_SCHEMA.parse({
  organization: "LLM-4-People",
  apiUrl: "https://api.github.com",
  webUrl: "https://github.com",
  userAgent: "bridlewise-forge-test",
  request: { timeoutMs: 10_000, maxResponseBytes: 1_048_576, cleanupTimeoutMs: 1_000, etagCacheEntries: 64, maxPages: 10 },
  tokenRenewBeforeMs: 300_000,
  repositories: [
    { name: "bridlewise-testing", kind: "trunk", visibility: "public" },
    { name: ".github", kind: "meta", visibility: "public" },
    { name: "bridlewise-evidence", kind: "evidence", visibility: "public" },
    { name: "bridlewise-coordination", kind: "notes", visibility: "private" },
    { name: "bridlewise-archive", kind: "archive", visibility: "private" },
    { name: "forge-proving-ground", kind: "none", visibility: "public", provingGround: true },
  ],
  maintainerCli: { stallMs: 120_000, cpuLimitMs: 30_000, killGraceMs: 500 },
  appsPage: { port: 47811, legacyApps: [{ slug: "claude", repositories: ["bridlewise-testing"] }] },
});
