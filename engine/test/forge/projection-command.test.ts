/** The production projection composition and read-only host, on real committed source and existing stores. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { canonicalHash } from "../../src/kernel/integrity.ts";
import { schemaId } from "../../src/kernel/product-identity.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { LABELS_PATH } from "../../src/workflow/community/labels.ts";
import { configuredForgeCliWiring, runForgeCli, type ForgeCliWiring } from "../../src/workflow/forge/cli.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { repositoryIdentity } from "../../src/workflow/forge/repository-identity.ts";
import { applyProjection, planProjection, readProjection } from "../../src/workflow/forge/projector/apply.ts";
import { previewProjection, type ProjectionPreviewOptions } from "../../src/workflow/forge/projector/command.ts";
import { configuredConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { LEDGER_MAIN_RUNS } from "../../src/workflow/forge/projector/main-runs.ts";
import { PROJECTION_CLASSES } from "../../src/workflow/forge/projector/model.ts";
import { computeProjection, projectionInput } from "../../src/workflow/forge/projector/projection.ts";
import type { Adoptions, ProjectionStore } from "../../src/workflow/forge/projector/store.ts";
import { withGitAdapter, makeGitContext, IDENTITY } from "../support/git-fixtures.ts";
import { emptyKeepOutFacts } from "../support/keep-out-facts.ts";
import { fakeGithub } from "./fake-github.ts";
import { installIssues } from "./fake-github-issues.ts";
import { SETTINGS } from "./forge-settings.ts";
import { memoryStore } from "./projection-store.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const ID = repositoryIdentity(SETTINGS);
const CONFINEMENT = configuredConfinement(ENGINE_ROOT, emptyKeepOutFacts(), 60);
const SOURCE_TEXT = "Synthetic committed reporter content";
const DIRTY_TEXT = "Synthetic working tree content";
const REPLACEMENT_TITLE = "Synthetic replacement title";
const noop = (): void => {};
const code = (wanted: string) => (error: unknown): boolean => error instanceof HarnessError && error.code === wanted;

function productionPorts() {
  const ports = configuredForgeCliWiring.projection;
  assert.ok(ports);
  return ports;
}

/** Data fixture on the shared Git adapter and its one temporary-root/identity owner. */
function sourceFixture(options: Readonly<{ empty?: boolean; replacement?: boolean; ledger?: "graft" | "missing"; adopt?: number }> = {}) {
  return withGitAdapter((git, _runtime, root) => {
    git.init({ path: root, bare: false, initialBranch: "main", identity: IDENTITY }, makeGitContext(root, "init"));
    mkdirSync(join(root, LABELS_PATH, ".."), { recursive: true });
    writeFileSync(join(root, LABELS_PATH), JSON.stringify({ schema: schemaId("community-labels", 1), labels: [{ name: "lane:floor", color: "1d76db", description: "Synthetic floor lane" }] }) + "\n");
    const itemPath = join(root, TRACKER_BOARD.items, "A-ONE.md");
    const item = (title: string): void => {
      mkdirSync(join(itemPath, ".."), { recursive: true });
      writeFileSync(itemPath, `---\nschema: bridlewise-tracker-item/v1\npublished: false\nid: A-ONE\ntype: Task\ntitle: ${title}\nstate: open\nlane: floor\nopened: 2026-11-15\n${options.adopt === undefined ? "" : `gh: issue-${String(options.adopt)}\n`}---\n\n${SOURCE_TEXT}\n`);
    };
    const commit = (message: string): string => git.commit({ path: root, message, identity: IDENTITY, allowEmpty: false, stageAll: true }, makeGitContext(root, "commit")).commitSha;
    if (!options.empty) item("Synthetic committed title");
    const source = commit("Synthetic projection source");
    let second: string | null = null;
    let ledger: string | null = null;
    if (options.replacement || options.ledger !== undefined) {
      item(REPLACEMENT_TITLE);
      second = commit("Synthetic second source");
    }
    if (options.ledger !== undefined) {
      assert.ok(second);
      const row = (sha: string, conclusion: "success" | "failure") => JSON.stringify({ schema: LEDGER_MAIN_RUNS.schema, workflow: "door", commit: sha, conclusion, runUrl: `${ID.webUrl}/actions/runs/1`, failedTests: [] });
      writeFileSync(join(root, LEDGER_MAIN_RUNS.path), `${row(options.ledger === "missing" ? "f".repeat(40) : source, "failure")}\n${row(second, "success")}\n`);
      ledger = commit("Synthetic main-run ledger");
      if (options.ledger === "graft") {
        mkdirSync(join(root, ".git", "info"), { recursive: true });
        writeFileSync(join(root, ".git", "info", "grafts"), `${second}\n`);
      }
    }
    if (options.replacement) {
      assert.ok(second);
      mkdirSync(join(root, ".git", "refs", "replace"), { recursive: true });
      writeFileSync(join(root, ".git", "refs", "replace", source), `${second}\n`);
    }
    if (!options.empty) item(DIRTY_TEXT);
    return { root, source, second, ledger };
  });
}

type SourceFixture = ReturnType<typeof sourceFixture>;
const previewOptions = (fixture: SourceFixture, overrides: Partial<ProjectionPreviewOptions> = {}): ProjectionPreviewOptions => ({
  repository: productionPorts().repository(fixture.root), source: fixture.source, ledger: fixture.ledger, identity: ID,
  confinement: () => CONFINEMENT,
  store: async () => Object.freeze({ read: memoryStore().store.read }),
  ...overrides,
});

function unused(): never { throw new Error("An unrelated or production-only port was accessed"); }
const forbiddenWiring = (): ForgeCliWiring => ({ settings: unused, endpoint: unused, keyHome: unused, maintainerCli: unused, appsPage: unused });

function fakeWiring(fixture: SourceFixture, fake: ReturnType<typeof fakeGithub>, onClient: () => void = noop): ForgeCliWiring {
  const client = githubClient(fake.endpoint(), memoryCredential("synthetic-preview", fake.userToken("synthetic-preview")));
  return {
    ...forbiddenWiring(), settings: () => SETTINGS,
    projection: {
      repository: (top) => { assert.equal(top, fixture.root); return productionPorts().repository(top); },
      confinement: () => CONFINEMENT,
      client: () => { onClient(); return client; },
    },
  };
}

test("projection grammar refuses malformed requests before any wiring or credential access", async () => {
  const cases = [
    [], ["--source"], ["--source", "HEAD"], ["--source", "HEAD", "--source", "HEAD", "--token-stdin"],
    ["--source", "HEAD", "--ledger", "HEAD", "--ledger", "HEAD", "--token-stdin"],
    ["--source", "HEAD", "--token-env", "lowercase"],
    ["--source", "HEAD", "--token-env", "TOKEN", "--unknown"],
    ["--source", "HEAD", "--token-stdin", "--token-env", "TOKEN"],
  ];
  for (const args of cases) await assert.rejects(runForgeCli(ENGINE_ROOT, ["projection", "plan", ...args], noop, forbiddenWiring()), code("forge_usage"));
  await assert.rejects(runForgeCli(ENGINE_ROOT, ["projection", "apply", "--source", "HEAD", "--token-stdin"], noop, forbiddenWiring()), code("forge_usage"));
});

test("explicit wiring without projection ports never falls back to production configuration", async () => {
  await assert.rejects(runForgeCli(ENGINE_ROOT, ["projection", "plan", "--source", "HEAD", "--token-env", "TOKEN"], noop, forbiddenWiring()), code("projection_host_unavailable"));
});

test("the actual frozen production repository port preserves native committed source under replacements", async () => {
  const fixture = sourceFixture({ replacement: true });
  assert.ok(Object.isFrozen(configuredForgeCliWiring));
  assert.ok(Object.isFrozen(productionPorts()));
  const ordinary = configuredGitRepository({}, fixture.root);
  assert.equal(projectionInput(ordinary, fixture.source, null, ID.webUrl).items[0]!.title, REPLACEMENT_TITLE, "ordinary Git really sees the hostile replacement");
  const options = previewOptions(fixture);
  const expected = computeProjection(projectionInput(options.repository, fixture.source, null, ID.webUrl), CONFINEMENT);
  assert.equal(expected.projection.objects[0]!.fields.title, "Synthetic committed title", "the actual production composition ignores replacements and dirty files");
  const planned = planProjection(expected.projection, []);
  const result = await previewProjection(options);
  assert.deepEqual(result.repository, { fullName: ID.fullName, webUrl: ID.webUrl });
  assert.equal(result.sourceCommit, fixture.source);
  assert.equal(result.desiredDigest, expected.digest);
  assert.ok(result.candidateChanges.length > 0);
  assert.deepEqual(result.candidateChanges, planned.writes.map((write) => ({ phase: write.phase, kind: write.kind, class: write.class, key: write.key, fields: Object.keys(write.fields).sort(), fieldsDigest: canonicalHash(write.fields) })));
  const serialized = JSON.stringify(result);
  for (const text of [SOURCE_TEXT, DIRTY_TEXT, REPLACEMENT_TITLE, "Synthetic committed title"]) assert.ok(!serialized.includes(text));
});

test("source and ledger ancestry use the same actual native repository despite a legacy graft", async () => {
  const fixture = sourceFixture({ ledger: "graft" });
  assert.ok(fixture.ledger);
  assert.throws(() => projectionInput(configuredGitRepository({}, fixture.root), fixture.source, fixture.ledger, ID.webUrl), code("ledger_rows_diverge"), "ordinary Git really loses the native ancestor at the graft");
  const result = await previewProjection(previewOptions(fixture));
  assert.equal(result.sourceCommit, fixture.source);
  assert.equal(result.ledgerCommit, fixture.ledger);
  assert.equal(result.coverage.committedLedger, "readAtCommit");
  assert.equal(result.coverage.liveMainHealth, "unknown");
  assert.ok(result.candidateChanges.some((write) => write.key === "MAIN-RED/door"));
});

test("missing source and ledger commits refuse before confinement or credential/store acquisition", async () => {
  const fixture = sourceFixture();
  let calls = 0;
  const options = previewOptions(fixture, { confinement: () => { calls += 1; return CONFINEMENT; }, store: async () => { calls += 1; return memoryStore().store; } });
  await assert.rejects(previewProjection({ ...options, source: "f".repeat(40) }), code("projection_source_missing"));
  await assert.rejects(previewProjection({ ...options, ledger: "f".repeat(40) }), code("projection_ledger_missing"));
  assert.equal(calls, 0);
});

test("a missing native ancestor referenced by the ledger remains a typed failure, never an empty preview", async () => {
  const fixture = sourceFixture({ ledger: "missing" });
  let calls = 0;
  await assert.rejects(previewProjection(previewOptions(fixture, { confinement: () => { calls += 1; return CONFINEMENT; }, store: async () => { calls += 1; return memoryStore().store; } })), code("tree_reader_git_failed"));
  assert.equal(calls, 0);
});

test("an empty desired projection reports no requested read without acquiring the live store", async () => {
  const fixture = sourceFixture({ empty: true });
  let stores = 0;
  const result = await previewProjection(previewOptions(fixture, { store: async () => { stores += 1; return memoryStore().store; } }));
  assert.equal(stores, 0);
  assert.equal(result.observationCompleted, true);
  assert.equal(result.complete, false);
  assert.deepEqual(result.coverage.requestedClasses, []);
  assert.deepEqual(result.coverage.observedClasses, []);
  assert.deepEqual(result.coverage.implementedClasses, PROJECTION_CLASSES);
  assert.equal(result.coverage.liveRead, "notRequested");
  assert.equal(result.coverage.committedLedger, "notProvided");
  assert.equal(result.coverage.project, "notImplemented");
  assert.equal(result.coverage.foreignEdits, "unknown");
  assert.equal(result.coverage.adoptionEstablishment, "unknown");
  assert.equal(result.coverage.previousReceipt, "notProvided");
});

test("typed confinement and live-store refusals propagate unchanged", async () => {
  const fixture = sourceFixture();
  const refused = new HarnessError("Synthetic refusal", "projection_confinement_refused");
  let stores = 0;
  await assert.rejects(previewProjection(previewOptions(fixture, { confinement: () => { throw refused; }, store: async () => { stores += 1; return memoryStore().store; } })), (error) => error === refused);
  assert.equal(stores, 0);
  const budget = new HarnessError("Synthetic upstream budget refusal", "github_content_budget_exhausted", true);
  await assert.rejects(previewProjection(previewOptions(fixture, { store: async () => { throw budget; } })), (error) => error === budget);
  await assert.rejects(previewProjection(previewOptions(fixture, { store: async () => ({ read: async () => { throw budget; } }) })), (error) => error === budget);
});

test("the shared first read preserves receipt-based adoption and apply's same-store second read", async () => {
  const fixture = sourceFixture({ adopt: 1 });
  const projection = computeProjection(projectionInput(productionPorts().repository(fixture.root), fixture.source, null, ID.webUrl), CONFINEMENT).projection;
  const memory = memoryStore();
  const issue = projection.objects.find((object) => object.class === "issue")!;
  memory.put({ class: issue.class, key: issue.key, fields: issue.fields, owned: false, above: SOURCE_TEXT });
  const previous = await applyProjection(projection, memory.store, { allowance: 100, previous: null, foreignEdit: "approval" });
  assert.ok(previous.objects["issue/A-ONE"]?.above);
  const calls: { classes: readonly string[]; adoptions: Adoptions }[] = [];
  const store: ProjectionStore = {
    read: async (classes, adoptions) => { calls.push({ classes, adoptions }); return memory.store.read(classes, adoptions); },
    write: memory.store.write,
  };
  const receipt = await applyProjection(projection, store, { allowance: 100, previous, foreignEdit: "approval" });
  assert.equal(receipt.verified, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.classes, calls[1]!.classes);
  assert.equal(calls[0]!.adoptions, calls[1]!.adoptions);
  assert.equal(calls[0]!.adoptions.get("A-ONE")?.established, true);
  const unestablished = await readProjection(projection, Object.freeze({ read: store.read }), null);
  assert.equal(unestablished.adoptions.get("A-ONE")?.established, false);
  assert.deepEqual(unestablished.classes, ["issue"]);
  assert.equal(memory.writes().length, 0);
});

test("normal CLI dispatch uses the existing fake GitHub client for reads only and omits reporter fields", async () => {
  const fake = fakeGithub();
  const issues = installIssues(fake, ID.fullName);
  const reporter = issues.open({ title: "Synthetic reporter title", body: `${SOURCE_TEXT}\n<!-- bridlewise:item=A-ONE digest=${"a".repeat(64)} -->\n` });
  const fixture = sourceFixture({ adopt: reporter.number });
  const before = reporter.body;
  let clients = 0;
  const answer = await runForgeCli(fixture.root, ["projection", "plan", "--source", fixture.source, "--token-env", "SYNTHETIC_PROJECTION_TOKEN"], noop, fakeWiring(fixture, fake, () => { clients += 1; }));
  const result = answer.result.result as unknown as Awaited<ReturnType<typeof previewProjection>>;
  assert.equal(answer.result.command, "forge projection plan");
  assert.equal(answer.result.status, "fail", "a completed observation is still an unqualified candidate preview");
  assert.equal(result.observationCompleted, true);
  assert.equal(result.complete, false);
  assert.equal(result.coverage.requestedAdoptions, 1);
  assert.equal(result.coverage.adoptionEstablishment, "unknown");
  assert.equal(result.coverage.liveRead, "completed");
  assert.equal(clients, 1);
  assert.ok(fake.requests.length > 0);
  for (const request of fake.requests) {
    assert.ok(request.method === "GET" || (request.method === "POST" && request.path === "/graphql"));
    if (request.path === "/graphql") assert.doesNotMatch(String((request.body as { query?: string }).query), /\bmutation\b/u);
  }
  assert.equal(reporter.body, before);
  for (const text of [SOURCE_TEXT, DIRTY_TEXT, "Synthetic reporter title"]) assert.ok(!JSON.stringify(answer).includes(text));
});

test("empty CLI observation acquires no client and remains explicitly incomplete", async () => {
  const fixture = sourceFixture({ empty: true });
  const fake = fakeGithub();
  let clients = 0;
  const answer = await runForgeCli(fixture.root, ["projection", "plan", "--source", fixture.source, "--token-stdin"], noop, fakeWiring(fixture, fake, () => { clients += 1; }));
  const result = answer.result.result as unknown as Awaited<ReturnType<typeof previewProjection>>;
  assert.equal(clients, 0, "an empty request never prompts or acquires credentials");
  assert.equal(fake.requests.length, 0);
  assert.equal(result.coverage.liveRead, "notRequested");
  assert.equal(result.complete, false);
  assert.equal(answer.result.status, "fail");
});
