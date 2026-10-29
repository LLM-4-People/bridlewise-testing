import { execFileSync } from "node:child_process";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";
import { dispositionRecordsDigest, readDispositionManifest } from "../../engine/src/workflow/disposition-records.ts";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import {
  firstHeading,
  parseDossier,
  parseFrontMatter,
  readJson,
  readText,
  relativePosix,
  repoInfo,
  sha256File,
  walkFiles,
} from "./files.mjs";
import { REPOSITORY, repositoryFileUrl } from "./repository.mjs";

export const ATLAS_SCHEMA = "bridlewise-floor-atlas/v1";

const BLOB = repositoryFileUrl("");
// Engine inventory and disposition paths are relative to engine/; every other
// path here is repository-relative.

function engineCategory(path) {
  if (path.startsWith("test/prevention/")) return "prevention";
  if (path.startsWith("live/")) return "live";
  return "engine-domain";
}

function webCategory(path) {
  if (path.startsWith("tests/unit/")) return "web-unit";
  if (path.startsWith("tests/prevention/")) return "prevention";
  if (path.startsWith("tests/cockpit/")) return "cockpit";
  if (path.startsWith("tests/performance/")) return "performance";
  if (path.startsWith("tests/public/")) return "public";
  if (path.endsWith(".spec.ts")) return "e2e";
  return "web-unit";
}

function isTestFile(file) {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".spec.ts") ||
    file.endsWith(".test.mjs")
  );
}

/** The test-surface dispositions, from their one reader (one record per decided source, each judged by its owner). */
function readDispositions(root) {
  const engineRoot = join(root, "engine");
  return { entries: readDispositionManifest(engineRoot).entries, hash: dispositionRecordsDigest(engineRoot) };
}

/**
 * The engine's test inventory, from its one owner. It is a cache of the tree,
 * not committed (#221), so the atlas asks the generator for the tree's own
 * (`engine/scripts/test-inventory.ts --print`, about 2.5 s, nothing written):
 * the counts are the tree's, never a stale cache's.
 */
export function readInventory(root) {
  const file = join(root, "engine/traceability/s1-test-inventory.json");
  const data = JSON.parse(execFileSync(process.execPath, [join(root, "engine/scripts/test-inventory.ts"), "--print"], {
    cwd: join(root, "engine"), encoding: "utf8", maxBuffer: ROOT_POLICY.verification.testDiscovery.maximumInventoryBytes, stdio: ["ignore", "pipe", "inherit"],
  }));
  if (!Array.isArray(data.tests) || !Array.isArray(data.scope?.canonicalNodeSourceIds)) {
    throw new Error("s1-test-inventory.json has an unexpected schema");
  }
  return { file, data };
}

function readDecision(root, file) {
  const text = readText(file);
  const { data, body } = parseFrontMatter(text);
  if (!data.id) return null;
  const path = relativePosix(root, file);
  return {
    id: data.id,
    title: firstHeading(body, data.id),
    path,
    group: data.group ?? null,
    status: data.status ?? null,
    implementation: data.implementation ?? null,
    route: data.route ?? null,
    url: BLOB + path,
  };
}

function readGuard(root, file) {
  const path = relativePosix(root, file);
  const text = readText(file);
  const dossier = parseDossier(text);
  return {
    name: firstHeading(text, basename(file)),
    path,
    surface: path.startsWith("engine/") ? "engine" : "web",
    failureClass: dossier.subject,
    owns: dossier.owns,
    plant: dossier.plant,
    drivenBehavior: dossier.driven,
    livenessCheck: dossier.liveness,
    complete: dossier.complete,
    url: BLOB + path,
  };
}

function readRequirements(root) {
  const file = join(root, "engine/traceability/requirements.json");
  const data = readJson(file);
  const requirements = Array.isArray(data.requirements) ? data.requirements : [];
  const statuses = {};
  for (const requirement of requirements) {
    const status = requirement.status ?? "unknown";
    statuses[status] = (statuses[status] ?? 0) + 1;
  }
  return {
    file,
    requirements,
    counts: {
      requirements: requirements.length,
      derivedControls: Array.isArray(data.derivedControls) ? data.derivedControls.length : 0,
      globalAcceptanceGates: Array.isArray(data.globalAcceptanceGates)
        ? data.globalAcceptanceGates.length
        : 0,
      userStatements: Array.isArray(data.userStatements) ? data.userStatements.length : 0,
      openDecisions: Array.isArray(data.openDecisions) ? data.openDecisions.length : 0,
    },
    statuses,
    openDecisions: Array.isArray(data.openDecisions)
      ? data.openDecisions.map((decision) => ({
          id: decision.id ?? null,
          status: decision.status ?? null,
          boundRequirements: Array.isArray(decision.boundRequirements)
            ? decision.boundRequirements
            : [],
          statement: decision.statement ?? null,
        }))
      : [],
  };
}

function readBench(root) {
  const file = join(root, "bench/run.ts");
  if (!existsSync(file)) return { file: null, suites: [] };
  const text = readText(file);
  const block = /const SUITES = \[([\s\S]*?)\]\s*as const;/.exec(text);
  if (!block) return { file: "bench/run.ts", suites: [] };
  const suites = [...block[1].matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
  return { file: "bench/run.ts", suites };
}

function readFlakes(root) {
  const directory = join(root, "engine/traceability/flake-reproductions");
  if (!existsSync(directory)) return { count: 0, recent: [] };
  const files = walkFiles(directory, (file) => file.endsWith(".json"));
  const records = [];
  for (const file of files) {
    try {
      const data = readJson(file);
      records.push({
        identity: data.identity ?? relativePosix(root, file),
        suite: data.suite ?? null,
        recordedAt: data.recordedAt ?? null,
        causeCount: Array.isArray(data.causes) ? data.causes.length : 0,
        fixed: Boolean(data.fix),
      });
    } catch {
      records.push({
        identity: relativePosix(root, file),
        suite: null,
        recordedAt: null,
        causeCount: 0,
        fixed: false,
      });
    }
  }
  records.sort((left, right) =>
    String(right.recordedAt ?? "").localeCompare(String(left.recordedAt ?? "")),
  );
  return { count: records.length, recent: records.slice(0, 12) };
}

export function buildAtlas({ root, now = new Date() }) {
  if (!root) throw new Error("root is required");

  const inventory = readInventory(root);
  const dispositions = readDispositions(root);
  const requirements = readRequirements(root);
  const bench = readBench(root);
  const flakes = readFlakes(root);

  const dispositionByPath = new Map(
    dispositions.entries.map((entry) => [String(entry.path), entry]),
  );
  const testsBySource = new Map();
  for (const test of inventory.data.tests) {
    const source = String(test.sourceId);
    const current = testsBySource.get(source);
    if (current) current.count += 1;
    else testsBySource.set(source, { count: 1, sourceHash: test.sourceHash ?? null });
  }

  const tests = [];
  const knownSources = new Set();
  for (const source of inventory.data.scope.canonicalNodeSourceIds) {
    const path = String(source);
    knownSources.add(path);
    const disposition = dispositionByPath.get(path);
    const aggregate = testsBySource.get(path);
    tests.push({
      kind: "test",
      path,
      category: engineCategory(path),
      disposition: disposition?.disposition ?? "unknown",
      blocksFullRepositoryClaim: disposition?.blocksFullRepositoryClaim ?? true,
      testCount: aggregate?.count ?? 0,
      countKnown: aggregate !== undefined,
      sourceHash: aggregate?.sourceHash ?? disposition?.sourceHash ?? null,
      url: repositoryFileUrl(`engine/${path}`),
    });
  }

  for (const [path, disposition] of dispositionByPath) {
    if (knownSources.has(path)) continue;
    tests.push({
      kind: "test",
      path,
      category: engineCategory(path),
      disposition: disposition.disposition ?? "unknown",
      blocksFullRepositoryClaim: disposition.blocksFullRepositoryClaim ?? true,
      testCount: testsBySource.get(path)?.count ?? null,
      countKnown: testsBySource.has(path),
      sourceHash: testsBySource.get(path)?.sourceHash ?? null,
      url: repositoryFileUrl(`engine/${path}`),
    });
  }

  const rootTestFiles = walkFiles(
    join(root, "tests"),
    (file) => isTestFile(file) && !file.includes(`${join("tests", "helpers")}`),
  );
  for (const file of rootTestFiles) {
    const path = relativePosix(root, file);
    tests.push({
      kind: "test",
      path,
      category: webCategory(path),
      disposition: "not-inventoried",
      blocksFullRepositoryClaim: false,
      testCount: null,
      countKnown: false,
      sourceHash: null,
      url: BLOB + path,
    });
  }
  tests.sort((left, right) => left.path.localeCompare(right.path));

  const guardFiles = [
    ...walkFiles(join(root, "tests/prevention"), (file) => file.endsWith(".test.ts")),
    ...walkFiles(join(root, "engine/test/prevention"), (file) => file.endsWith(".test.ts")),
  ];
  const guards = guardFiles.map((file) => readGuard(root, file));
  guards.sort((left, right) => left.path.localeCompare(right.path));

  const decisions = walkFiles(
    join(root, "docs/decisions"),
    (file) => file.endsWith(".md") && basename(file) !== "README.md",
  )
    .map((file) => readDecision(root, file))
    .filter(Boolean);
  decisions.sort((left, right) => left.id.localeCompare(right.id));

  const counts = {
    testSources: tests.length,
    testNames: inventory.data.tests.length,
    engineSources: inventory.data.scope.canonicalNodeSourceIds.length,
    dispositions: dispositions.entries.length,
    rootTestFiles: rootTestFiles.length,
    guards: guards.length,
    webGuards: guards.filter((guard) => guard.surface === "web").length,
    engineGuards: guards.filter((guard) => guard.surface === "engine").length,
    decisions: decisions.length,
    requirements: requirements.counts.requirements,
    derivedControls: requirements.counts.derivedControls,
    globalAcceptanceGates: requirements.counts.globalAcceptanceGates,
    userStatements: requirements.counts.userStatements,
    openDecisions: requirements.counts.openDecisions,
    flakes: flakes.count,
    benchSuites: bench.suites.length,
    unclassified: tests.filter((test) => test.disposition === "unknown").length,
  };

  return {
    schemaVersion: ATLAS_SCHEMA,
    generatedAt: now.toISOString(),
    source: {
      repository: REPOSITORY,
      commit: repoInfo(root).commit,
      inventoryHash: inventory.data.inventoryHash ?? null,
      inventorySchema: inventory.data.schemaVersion ?? null,
      dispositionHash: dispositions.hash,
      requirementsHash: sha256File(requirements.file),
    },
    counts,
    tests,
    guards,
    decisions,
    requirements: {
      counts: requirements.counts,
      statuses: requirements.statuses,
      openDecisions: requirements.openDecisions,
    },
    flakes: {
      count: flakes.count,
      recent: flakes.recent,
    },
    bench: {
      source: bench.file,
      suites: bench.suites,
    },
    notes: [
      "A row records an inventory entry or guard. It does not record a passing run.",
      "Engine test names are counted from the inventory. Web test files are listed but their individual test names are not inventoried here.",
      "Dispositions come from the tracked disposition manifest. A missing disposition is unknown and blocks a full claim.",
    ],
  };
}
