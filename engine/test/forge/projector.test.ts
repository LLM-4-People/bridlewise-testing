/**
 * THE PROJECTOR (src/workflow/forge/projector/, github-only §9.0): D is a pure
 * function of the source commit, computed in a sealed realm, and one apply
 * algorithm makes GitHub equal to it — writing only the difference, re-reading,
 * and verifying every git-owned field.
 *
 *   V-25 idempotent: a second run on the same (S, L) makes zero writes.
 *   V-26 pure: two processes give the same digest; a touch of the network, the
 *        clock, randomness or code-from-strings is a typed refusal.
 *   V-28 a field GitHub silently drops is `projection_unverified`, never a success.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { applyProjection, planProjection, projectionFailure } from "../../src/workflow/forge/projector/apply.ts";
import { PROJECTION_INPUT_SCHEMA, type ProjectionInput } from "../../src/workflow/forge/projector/model.ts";
import { computeProjection, projectionInput } from "../../src/workflow/forge/projector/projection.ts";
import { PROJECTION_REALM, sealedCall } from "../../src/workflow/forge/projector/realm.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";
import { memoryStore } from "./projection-store.ts";

const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

const item = (id: string, overrides: Partial<ProjectionInput["items"][number]> = {}): ProjectionInput["items"][number] => ({
  id, type: "Task", title: null, state: "open", resolution: null, lane: "floor", parent: null, blockedBy: [],
  body: `The outcome of ${id}; see [the roadmap](../../floor/roadmap.md#m1).`, path: `${TRACKER_BOARD.items}/${id}.md`, ...overrides,
});
const input = (items: ProjectionInput["items"], source = SOURCE): ProjectionInput => ({
  schema: PROJECTION_INPUT_SCHEMA, source, ledger: null, repositoryUrl: "https://github.com/owner/repo",
  items, lanes: [{ lane: "floor", color: "1d76db", description: "Tracker lane: open work" }],
});
const INPUT = input([
  item("A-PARENT", { title: "The parent", type: "Workstream" }),
  item("B-CHILD", { parent: "A-PARENT", blockedBy: ["C-DONE"] }),
  item("C-DONE", { state: "closed", resolution: "not-planned" }),
]);

test("D is the tracker's issues and labels, with permalinks at S and the projector's marker", () => {
  const { projection, digest } = computeProjection(INPUT);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(projection.objects.map((object) => `${object.class}/${object.key}`), ["label/lane:floor", "issue/A-PARENT", "issue/B-CHILD", "issue/C-DONE"]);
  const child = projection.objects.find((object) => object.key === "B-CHILD")!;
  assert.equal(child.fields.title, "B-CHILD", "an item without a title is titled by its id");
  assert.deepEqual([child.fields.parent, child.fields.blockedBy, child.fields.labels], ["A-PARENT", ["C-DONE"], ["lane:floor"]]);
  const block = String(child.fields.block);
  assert.match(block, /^<!-- bridlewise:item=B-CHILD digest=[0-9a-f]{64} -->\n/u);
  assert.match(block, new RegExp(`\\(https://github\\.com/owner/repo/blob/${SOURCE}/docs/floor/roadmap\\.md#m1\\)`, "u"), "a relative link is a permalink at S");
  assert.match(block, new RegExp(`Projected from \\[\`${TRACKER_BOARD.items}/B-CHILD\\.md\`\\]\\(https://github\\.com/owner/repo/blob/${SOURCE}/`, "u"));
  const done = projection.objects.find((object) => object.key === "C-DONE")!;
  assert.deepEqual([done.fields.state, done.fields.stateReason], ["closed", "not_planned"]);
  // An input of another schema, or one that would key two objects alike, is refused typed.
  assert.throws(() => computeProjection({ ...INPUT, schema: "other/v9" } as unknown as ProjectionInput), (error: HarnessError) => error.code === "projection_input_invalid");
  assert.throws(() => computeProjection(input([item("A-ONE"), item("A-ONE")])), (error: HarnessError) => error.code === "projection_input_invalid" && /issue\/A-ONE/u.test(error.message));
  // Another source commit is another D (the permalinks move with it).
  assert.notEqual(computeProjection(input(INPUT.items, "f".repeat(40))).digest, digest);
});

test("V-26: project() is pure — the same digest in two processes, and every impure touch is a typed refusal", () => {
  const first = computeProjection(INPUT);
  const second = computeProjection(JSON.parse(JSON.stringify(INPUT)) as ProjectionInput);
  assert.equal(first.digest, second.digest, "two sealed processes, one digest");
  const directory = createTempDir("projector-realm-");
  const planted = (name: string, source: string, imports: readonly string[] = []): { entry: string; modules: string[]; exportName: string } => {
    const entry = join(directory, `${name}.ts`);
    writeFileSync(entry, source);
    return { entry, modules: [entry, ...imports], exportName: "projectText" };
  };
  for (const [name, source, code, what] of [
    ["clock", "export function projectText(): string { return String(Date.now()); }", "projection_impure", /Date/u],
    ["intl", "export function projectText(): string { return new Intl.DateTimeFormat().format(); }", "projection_impure", /Intl/u],
    ["random", "export function projectText(): string { return String(Math.random()); }", "projection_impure", /Math\.random/u],
    ["fetch", "export function projectText(): string { void fetch('https://example.org'); return ''; }", "projection_impure", /fetch/u],
    ["process", "export function projectText(): string { return String(process.pid); }", "projection_impure", /process/u],
    ["timer", "export function projectText(): string { setTimeout(() => {}, 1); return ''; }", "projection_impure", /setTimeout/u],
    ["locale", "export function projectText(): string { return String('a'.localeCompare('b')); }", "projection_impure", /localeCompare/u],
    ["eval", "export function projectText(): string { return String((0, eval)('1')); }", "projection_impure", /code generation/u],
    ["function", "export function projectText(): string { return String(projectText.constructor('return 1')()); }", "projection_impure", /code generation/u],
    ["escape", "export function projectText(): string { return String((globalThis as any).constructor.constructor('return process')()); }", "projection_impure", /code generation/u],
    ["network", "import { request } from 'node:http';\nexport function projectText(): string { return String(request); }", "projection_import_refused", /node:http/u],
    ["outside", `import { sha256 } from '${join(REPOSITORY_ROOT, "engine/src/kernel/integrity.ts")}';\nexport function projectText(): string { return sha256('x'); }`, "projection_import_refused", /integrity\.ts/u],
    ["not-text", "export function projectText(): number { return 1; }", "projection_failed", /answered number, not text/u],
  ] as const) {
    assert.throws(() => sealedCall(planted(name, source), "{}"), (error: HarnessError) => {
      assert.equal(error.code, code, `${name}: ${error.message}`);
      assert.match(error.message, what, name);
      return true;
    }, name);
  }
  // A pure module of the declared set computes: the realm refuses touches, never pure work.
  assert.equal(sealedCall(planted("pure", "export function projectText(input: string): string { return [...input].reverse().join(''); }"), "abc"), "cba");
  assert.ok(PROJECTION_REALM.modules.every((path) => path.startsWith(join(REPOSITORY_ROOT, "engine/src/")) || path === join(REPOSITORY_ROOT, "shared/markdown.ts")), "the projection's realm loads only the source it declares");
});

test("the first run creates in phase order, verifies, and its receipt names every write", async () => {
  const { projection, digest } = computeProjection(INPUT);
  const github = memoryStore();
  const receipt = await applyProjection(projection, github.store, { allowance: 100 });
  assert.equal(projectionFailure(receipt), null);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.digest, digest);
  assert.equal(receipt.observedDigest.length, 64);
  // create (label before issues) → link (the child's parent and blocker) → state (the closed item).
  assert.deepEqual(receipt.writes.map((write) => `${write.phase}:${write.kind}:${write.class}/${write.key}`), [
    "create:create:label/lane:floor", "create:create:issue/A-PARENT", "create:create:issue/B-CHILD", "create:create:issue/C-DONE",
    "link:update:issue/B-CHILD", "state:update:issue/C-DONE",
  ]);
  assert.deepEqual(receipt.writes[4]!.fields, ["blockedBy", "parent"]);
  assert.deepEqual(github.get("issue", "C-DONE")?.fields.stateReason, "not_planned");
});

test("V-25: a second run on the same (S, L) makes zero writes, and a changed record writes only its difference", async () => {
  const { projection } = computeProjection(INPUT);
  const github = memoryStore();
  const first = await applyProjection(projection, github.store, { allowance: 100 });
  const before = github.writes().length;
  const again = await applyProjection(computeProjection(INPUT).projection, github.store, { allowance: 100 });
  assert.equal(github.writes().length, before, "no write reached the store");
  assert.deepEqual(again.writes, []);
  assert.equal(again.verified, true);
  assert.equal(again.observedDigest, first.observedDigest, "GitHub is observed exactly as the first run left it");
  // One item closes: one state write, nothing else.
  const changed = input([INPUT.items[0]!, { ...INPUT.items[1]!, state: "closed", resolution: "completed" }, INPUT.items[2]!]);
  const next = await applyProjection(computeProjection(changed).projection, github.store, { allowance: 100 });
  assert.deepEqual(next.writes.map((write) => `${write.phase}:${write.class}/${write.key}:${write.fields.join(",")}`), [
    "create:issue/B-CHILD:block", "state:issue/B-CHILD:state,stateReason",
  ], "the block's digest moves with the record; the state is set; nothing else");
  assert.equal(next.verified, true);
});

test("V-28: a field GitHub silently does not keep is projection_unverified, never a success", async () => {
  const github = memoryStore({ drops: ["issue.type"] });
  const receipt = await applyProjection(computeProjection(INPUT).projection, github.store, { allowance: 100 });
  assert.equal(receipt.verified, false);
  assert.deepEqual(receipt.unverified.map((field) => `${field.class}/${field.key}.${field.field}`), ["issue/A-PARENT.type", "issue/B-CHILD.type", "issue/C-DONE.type"]);
  assert.equal(receipt.unverified[0]!.expected, "Workstream");
  assert.equal(receipt.unverified[0]!.observed, undefined);
  const failure = projectionFailure(receipt);
  assert.equal(failure?.code, "projection_unverified");
  assert.match(failure!.message, /issue\/A-PARENT\.type, issue\/B-CHILD\.type, issue\/C-DONE\.type are not what the projection/u);
});

test("an exhausted allowance stops typed and retryable, and the next run resumes the diff to a verified state", async () => {
  const { projection } = computeProjection(INPUT);
  const github = memoryStore();
  const first = await applyProjection(projection, github.store, { allowance: 2 });
  assert.equal(first.writes.length, 2);
  assert.deepEqual(first.refusals.map((refusal) => [refusal.code, refusal.retryable]), [["github_content_budget_exhausted", true]]);
  assert.deepEqual(first.pending, ["issue/B-CHILD", "issue/C-DONE"]);
  assert.deepEqual(first.unverified, [], "the objects the run wrote are verified; the pending ones are only pending");
  assert.equal(projectionFailure(first)?.retryable, true);
  const second = await applyProjection(projection, github.store, { allowance: 100 });
  assert.equal(second.verified, true);
  assert.equal(second.writes.length, 4, "it resumes with exactly the writes left");
});

test("a refused write stops the run with the object it was writing; the rest stays as it was", async () => {
  const github = memoryStore({ refuseAt: { write: 1, error: new HarnessError("forbidden", "github_forbidden") } });
  const receipt = await applyProjection(computeProjection(INPUT).projection, github.store, { allowance: 100 });
  assert.deepEqual(receipt.refusals.map((refusal) => [refusal.code, refusal.class, refusal.key, refusal.retryable]), [["github_forbidden", "issue", "A-PARENT", false]]);
  assert.equal(receipt.writes.length, 1);
  assert.equal(receipt.verified, false);
  assert.equal(projectionFailure(receipt)?.code, "github_forbidden");
  assert.equal(github.get("issue", "B-CHILD"), undefined, "nothing after the refusal was written");
});

test("a live object D does not hold is an orphan: reported, never written", async () => {
  const github = memoryStore();
  github.put({ class: "issue", key: "GONE", fields: { title: "GONE" } });
  github.put({ class: "label", key: "lane:retired", fields: { color: "000000", description: "x" } });
  const { projection } = computeProjection(INPUT);
  assert.deepEqual(planProjection(projection, [{ class: "issue", key: "GONE", fields: {} }]).orphans, ["issue/GONE"]);
  const receipt = await applyProjection(projection, github.store, { allowance: 100 });
  assert.deepEqual(receipt.orphans, ["issue/GONE", "label/lane:retired"]);
  assert.ok(receipt.writes.every((write) => write.key !== "GONE" && write.key !== "lane:retired"));
});

test("the input is read from the source COMMIT, never the working tree", () => {
  const root = createTempDir("projector-input-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  const write = (id: string, title: string): void => writeFileSync(join(root, TRACKER_BOARD.items, `${id}.md`), `---\nschema: bridlewise-tracker-item/v1\nid: ${id}\ntype: Task\ntitle: ${title}\nstate: open\nlane: floor\nopened: 2026-10-21\n---\n\nThe outcome.\n`);
  write("A-ONE", "As committed");
  git("add", "."); git("commit", "-q", "-m", "one");
  const commit = git("rev-parse", "HEAD");
  write("A-ONE", "Edited after the commit");
  write("B-TWO", "Never committed");
  const read = projectionInput(configuredGitRepository({}, root), "HEAD", null, "https://github.com/owner/repo");
  assert.equal(read.source, commit, "the source is the full commit id");
  assert.deepEqual(read.items.map((entry) => [entry.id, entry.title, entry.path]), [["A-ONE", "As committed", `${TRACKER_BOARD.items}/A-ONE.md`]]);
  assert.throws(() => projectionInput(configuredGitRepository({}, root), "no-such-ref", null, "https://github.com/owner/repo"), (error: HarnessError) => error.code === "projection_source_missing");
});

test("this repository's own HEAD projects: every tracker item is an issue, every lane a label", () => {
  const read = projectionInput(configuredGitRepository({}, REPOSITORY_ROOT), "HEAD", null, "https://github.com/LLM-4-People/bridlewise-testing");
  const { projection } = computeProjection(read);
  assert.equal(projection.objects.filter((object) => object.class === "issue").length, read.items.length);
  assert.ok(read.items.length > 0);
  assert.equal(projection.objects.filter((object) => object.class === "label").length, read.lanes.length);
});
