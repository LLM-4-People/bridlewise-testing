/**
 * The forge section the forge tests use (a test fixture, not a test file):
 * one complete, valid `forge` section, independent of the repository's own
 * configuration, so a rename there never moves a test's expectations.
 */
import { join } from "node:path";

import { readLabels } from "../../src/workflow/community/labels.ts";
import { readIntake, readRoles } from "../../src/workflow/community/sources.ts";
import { trackedTop } from "../../src/workflow/evidence-store.ts";
import { FORGE_CONFIG_SCHEMA, trunkRepository, type ForgeSettings } from "../../src/workflow/forge/forge-config.ts";
import type { ForgeFileSources } from "../../src/workflow/forge/generated-files.ts";

export const SETTINGS: ForgeSettings = FORGE_CONFIG_SCHEMA.parse({
  organization: "LLM-4-People",
  apiUrl: "https://api.github.com",
  webUrl: "https://github.com",
  pagesDomain: "github.io",
  uploadsUrl: "https://uploads.github.com",
  assetOrigins: ["https://release-assets.githubusercontent.com"],
  userAgent: "bridlewise-forge-test",
  request: { timeoutMs: 10_000, maxResponseBytes: 1_048_576, cleanupTimeoutMs: 1_000, etagCacheEntries: 64, maxPages: 10, assets: { maxBytes: 1_048_576, progressWindowMs: 30_000, minBytesPerWindow: 1_024, answerSilenceMs: 600_000 } },
  tokenRenewBeforeMs: 300_000,
  repositories: [
    { name: "bridlewise-testing", kind: "trunk", visibility: "public" },
    { name: ".github", kind: "meta", visibility: "public" },
    { name: "bridlewise-evidence", kind: "evidence", visibility: "public" },
    { name: "bridlewise-coordination", kind: "notes", visibility: "private" },
    { name: "bridlewise-archive", kind: "archive", visibility: "private" },
    { name: "bridlewise", kind: "archive", visibility: "public", product: true, preview: true },
    { name: "forge-proving-ground", kind: "none", visibility: "public", provingGround: true },
  ],
  maintainerCli: { stallMs: 120_000, cpuLimitMs: 30_000, killGraceMs: 500 },
  appsPage: { port: 47811, legacyApps: [{ slug: "claude", repositories: ["bridlewise-testing"] }] },
  stage: "p0",
  plan: { name: "team", secretProtection: false },
  maintainer: "amberflag48",
  teamMembers: {},
  p0RequiredChecks: [{ context: "Typecheck, public tests, build", integrationId: 15368 }, { context: "Secret and privacy scan", integrationId: 15368 }],
  mergeQueue: { maxEntriesToBuild: 1, minEntriesToMerge: 1, maxEntriesToMerge: 4, minEntriesToMergeWaitMinutes: 0, checkResponseTimeoutMinutes: 60 },
  areas: [
    { id: "engine", description: "The engine", color: "1d76db", paths: ["/engine/"] },
    { id: "docs", description: "Documentation", color: "0075ca", paths: ["/docs/"] },
  ],
  autolinks: [{ keyPrefix: "UR-", urlTemplate: "https://example.github.io/decisions/UR-<num>", isAlphanumeric: true }],
  dependabot: {
    schedule: { interval: "weekly", day: "monday", time: "06:00", timezone: "Etc/UTC" },
    openPullRequestsLimit: 5, cooldownDays: 3, majorCooldownDays: 7,
    packages: [{ ecosystem: "npm", directory: "/", group: "web" }, { ecosystem: "npm", directory: "/engine", group: "engine" }, { ecosystem: "github-actions", directory: "/", group: "actions" }],
    frozenPrefixes: ["engine/verification/benchmarks/"],
  },
  project: { title: "Bridlewise", statusOptions: ["Intake", "Ready", "In progress", "In review", "Done"] },
  contentPolicy: { maxFileMegabytes: 10, forbiddenExtensions: [".pem", ".key", ".env"], forbiddenPaths: ["**/secrets/**", "**/tokens/**"] },
  retired: [{ kind: "ruleset", repository: "bridlewise-testing", name: "protect-release-tags" }],
});

/** The trunk's name in {@link SETTINGS}: a test names the fixture's trunk only through it. */
export const TRUNK = trunkRepository(SETTINGS).name;

/** The repository's own community sources (the one table of categories, types and teams). */
const TOP = trackedTop(join(import.meta.dirname, "..", ".."));

const WORKFLOW_ACTIONS = ["actions/checkout@0123456789abcdef0123456789abcdef01234567", "github/codeql-action/init@0123456789abcdef0123456789abcdef01234567", "ossf/scorecard-action@0123456789abcdef0123456789abcdef01234567", "./.github/actions/local"];

/** The sources of the generated files, for {@link SETTINGS}. */
export const SOURCES: ForgeFileSources = Object.freeze({
  settings: SETTINGS,
  intake: readIntake(TOP),
  roles: readRoles(TOP),
  labels: readLabels(TOP),
  workflowActions: WORKFLOW_ACTIONS,
  facts: Object.freeze({ workflowActions: WORKFLOW_ACTIONS, lockfileDirectories: Object.freeze({ npm: ["/", "/engine"], cargo: [] }), hasWorkflows: true }),
});
