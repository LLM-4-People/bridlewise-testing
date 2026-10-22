/**
 * THE PROJECTOR (src/workflow/forge/projector/, github-only §9.0): D is a pure
 * function of the source commit, computed in a confined process, and one apply
 * algorithm makes GitHub equal to it — writing only the difference, re-reading,
 * and verifying every git-owned field.
 *
 *   V-25 idempotent: a second run on the same (S, L) makes zero writes.
 *   V-26 pure, by the kernel: the projection runs in a separate process under
 *        the guardian (no readable file but node's own, nothing writable, no
 *        socket, no signal outside its domain, CPU and memory ceilings, no
 *        environment); a write, a harness or /proc read, a connect, a signal
 *        to another process and an allocation past the ceiling are refused;
 *        the clock and randomness, which no kernel boundary refuses, are
 *        caught by computing twice.
 *   V-28 a field GitHub silently drops is `projection_unverified`, never a success.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { applyProjection, planProjection, projectionFailure } from "../../src/workflow/forge/projector/apply.ts";
import { PROJECTION_INPUT_SCHEMA, type ProjectionInput } from "../../src/workflow/forge/projector/model.ts";
import { computeProjection, deterministicCall, projectionInput } from "../../src/workflow/forge/projector/projection.ts";
import { confinedCall, PROJECTION_PROGRAM, type ConfinedModule, type ProjectorConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { compileSelfProtectionConfigToSpec, resolveGuardianBinaryPath } from "../../src/filesystem/self-protection/guardian-binary.ts";
import { narrowGuardianSpec } from "../../src/filesystem/self-protection/confined-run.ts";
import { procfsPath } from "../../src/process/process-facts.ts";
import { DEFAULT_SELF_PROTECTION_CONFIG, parseSelfProtectionConfig } from "../../src/filesystem/self-protection/self-protection-config.ts";
import { emptyKeepOutFacts } from "../support/keep-out-facts.ts";
import { requireHost } from "../support/host-requirement.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";
import { memoryStore } from "./projection-store.ts";

const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const ENGINE_ROOT = join(REPOSITORY_ROOT, "engine");
/** Every projection here runs confined: this engine's guardian, an empty keep-out registry of the test's own, a generous CPU ceiling, 1.5 GiB of address space. */
const CONFINEMENT: ProjectorConfinement = { harnessRoot: ENGINE_ROOT, keepOut: emptyKeepOutFacts(), cpuSeconds: 60, memoryBytes: 1_610_612_736 };

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
  const { projection, digest } = computeProjection(INPUT, CONFINEMENT);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(projection.objects.map((object) => `${object.class}/${object.key}`), ["label/lane:floor", "issue/A-PARENT", "issue/B-CHILD", "issue/C-DONE"]);
  const child = projection.objects.find((object) => object.key === "B-CHILD")!;
  // Input order never reaches D: blocked-by is sorted.
  const unordered = computeProjection(input([item("A-ONE", { blockedBy: ["Z-LAST", "B-FIRST"] }), item("Z-LAST"), item("B-FIRST")]), CONFINEMENT).projection;
  assert.deepEqual(unordered.objects.find((object) => object.key === "A-ONE")!.fields.blockedBy, ["B-FIRST", "Z-LAST"]);
  assert.equal(child.fields.title, "B-CHILD", "an item without a title is titled by its id");
  assert.deepEqual([child.fields.parent, child.fields.blockedBy, child.fields.labels], ["A-PARENT", ["C-DONE"], ["lane:floor"]]);
  const block = String(child.fields.block);
  assert.match(block, /^<!-- bridlewise:item=B-CHILD digest=[0-9a-f]{64} -->\n/u);
  assert.match(block, new RegExp(`\\(https://github\\.com/owner/repo/blob/${SOURCE}/docs/floor/roadmap\\.md#m1\\)`, "u"), "a relative link is a permalink at S");
  assert.match(block, new RegExp(`Projected from \\[\`${TRACKER_BOARD.items}/B-CHILD\\.md\`\\]\\(https://github\\.com/owner/repo/blob/${SOURCE}/`, "u"));
  const done = projection.objects.find((object) => object.key === "C-DONE")!;
  assert.deepEqual([done.fields.state, done.fields.stateReason], ["closed", "not_planned"]);
  // An input of another schema, or one that would key two objects alike, is refused typed.
  assert.throws(() => computeProjection({ ...INPUT, schema: "other/v9" } as unknown as ProjectionInput, CONFINEMENT), (error: HarnessError) => error.code === "projection_input_invalid");
  assert.throws(() => computeProjection(input([item("A-ONE"), item("A-ONE")]), CONFINEMENT), (error: HarnessError) => error.code === "projection_input_invalid" && /issue\/A-ONE/u.test(error.message));
  // Another source commit is another D (the permalinks move with it).
  assert.notEqual(computeProjection(input(INPUT.items, "f".repeat(40)), CONFINEMENT).digest, digest);
});

test("V-26: purity is a kernel property — two confined processes give one digest, and every reach outside the input is refused", async () => {
  requireHost(resolveGuardianBinaryPath(ENGINE_ROOT) !== undefined, "the built guardian (make -C engine/guardian all)");
  const first = computeProjection(INPUT, CONFINEMENT);
  const second = computeProjection(JSON.parse(JSON.stringify(INPUT)) as ProjectionInput, CONFINEMENT);
  assert.equal(first.digest, second.digest, "two confined processes (each computing twice), one digest");
  const directory = createTempDir("projector-confined-");
  const planted = (name: string, source: string, siblings: Readonly<Record<string, string>> = {}): ConfinedModule => {
    const entry = join(directory, `${name}.ts`);
    writeFileSync(entry, source);
    for (const [file, text] of Object.entries(siblings)) writeFileSync(join(directory, file), text);
    return { entry, modules: [entry], exportName: "projectText" };
  };
  const refused = (module: ConfinedModule, code: string, what: RegExp, call: () => unknown = () => deterministicCall(module, "{}", CONFINEMENT)): void => {
    assert.throws(call, (error: HarnessError) => {
      assert.equal(error.code, code, `${module.entry}: ${error.message}`);
      assert.match(error.message, what, module.entry);
      return true;
    });
  };
  // A WRITE through a dynamic import of node:fs (the escape a JS realm could not close): the kernel refuses it, nothing is written.
  const written = join(directory, "written-by-the-projection");
  // (A computed specifier: no static link can see it, so only the kernel stands in the way; a literal one is refused at link, below.)
  refused(planted("write", `const fs = await import(["node", "fs"].join(":"));\nfs.writeFileSync(${JSON.stringify(written)}, "x");\nexport function projectText(): string { return ""; }`), "projection_impure", /EACCES/u);
  assert.equal(existsSync(written), false, "the write never happened");
  // A READ of the harness's own code, and of /proc (a clock): refused.
  refused(planted("read", `const fs = process.getBuiltinModule("node:fs");\nexport function projectText(): string { return fs.readFileSync(${JSON.stringify(join(ENGINE_ROOT, "src/kernel/root-policy.ts"))}, "utf8"); }`), "projection_impure", /EACCES/u);
  refused(planted("uptime", `const fs = process.getBuiltinModule("node:fs");\nexport function projectText(): string { return fs.readFileSync(${JSON.stringify(procfsPath("uptime"))}, "utf8"); }`), "projection_impure", /EACCES/u);
  // A CONNECT to a live local server: refused at socket(), the server never sees it.
  const server = createServer((socket) => { connections += 1; socket.end(); });
  let connections = 0;
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  try {
    refused(planted("connect", `const net = await import(["node", "net"].join(":"));\nawait new Promise((resolve, reject) => { const socket = net.connect(${String(port)}, "127.0.0.1"); socket.on("connect", resolve); socket.on("error", reject); });\nexport function projectText(): string { return "connected"; }`), "projection_impure", /EACCES/u);
    refused(planted("fetch", `await fetch("http://127.0.0.1:${String(port)}/");\nexport function projectText(): string { return "fetched"; }`), "projection_impure", /EACCES/u);
  } finally {
    server.close();
  }
  assert.equal(connections, 0, "no connection reached the server");
  // The CLOCK and RANDOMNESS reach no kernel wall (the vDSO): two confined runs that answer differently are refused.
  refused(planted("clock", "export function projectText(): string { return String(Date.now()) + String(performance.now()); }"), "projection_nondeterministic", /answered differently/u);
  refused(planted("random", "export function projectText(): string { return String(Math.random()); }"), "projection_nondeterministic", /answered differently/u);
  // The LINK refuses what the program does not declare, before anything runs.
  refused(planted("sibling", "import { value } from './undeclared.ts';\nexport function projectText(): string { return value; }", { "undeclared.ts": "export const value = 'x';" }), "projection_import_refused", /undeclared\.ts \(imported by [^)]+\) is not a module of the confined program/u);
  refused(planted("builtin", "import { readFileSync } from 'node:fs';\nexport function projectText(): string { return String(readFileSync); }"), "projection_import_refused", /node:fs/u);
  refused(planted("literal-dynamic", "const fs = await import('node:fs');\nexport function projectText(): string { return String(fs); }"), "projection_import_refused", /node:fs/u);
  refused(planted("bare", "import x from 'zod';\nexport function projectText(): string { return String(x); }"), "projection_import_refused", /zod/u);
  // A CPU spin is ended by its CPU ceiling (by CPU work, never wall time). The spin is BOUNDED (far past a 1-second ceiling):
  // with the ceiling gone it returns an answer and the assertion fails, never a hung file.
  const spin = planted("spin", "export function projectText(): string { let n = 0; for (let i = 0; i < 2e10; i += 1) n += i & 1; return String(n); }");
  refused(spin, "projection_cpu_exhausted", /CPU seconds/u, () => confinedCall(spin, "{}", { ...CONFINEMENT, cpuSeconds: 1 }));
  // A SIGNAL to any other process (here, a live child of this test): refused by the guardian's seccomp filter on every kernel, and it lives.
  const outsider = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    refused(planted("signal", `export function projectText(): string { process.kill(${String(outsider.pid)}, "SIGTERM"); return "sent"; }`), "projection_impure", /EPERM/u);
    assert.equal(outsider.exitCode, null, "the outside process was not signalled");
    assert.equal(outsider.signalCode, null);
  } finally {
    outsider.kill("SIGKILL");
  }
  // An ALLOCATION past the address-space ceiling (2 GiB, bounded: with no ceiling it answers and the assertion fails).
  refused(planted("allocate", "export function projectText(): string { const kept: Uint8Array[] = []; for (let i = 0; i < 2048; i += 1) kept.push(new Uint8Array(1 << 20).fill(1)); return String(kept.length); }"), "projection_memory_exhausted", /address-space ceiling/u);
  // A large answer arrives whole (a pipe write can still be pending when write() returns).
  const large = confinedCall(planted("large", "export function projectText(): string { return 'x'.repeat(4_000_000) + 'END'; }"), "{}", CONFINEMENT);
  assert.equal(large.length, 4_000_003);
  assert.ok(large.endsWith("END"));
  refused(planted("not-text", "export function projectText(): number { return 1; }"), "projection_failed", /answered number, not text/u);
  // The parent's environment never reaches the program: a NODE_OPTIONS preload is ignored.
  const preload = join(directory, "preload.cjs");
  writeFileSync(preload, "process.stdout.write('PRELOADED');");
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require=${preload}`;
  try {
    assert.equal(confinedCall(planted("pure", "export function projectText(input: string): string { return [...input].reverse().join(''); }"), "abc", CONFINEMENT), "cba", "honest pure work computes, and the preload never ran");
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
  // A host whose guardian cannot confine is a typed refusal, never an unconfined run.
  refused(planted("pure2", "export function projectText(): string { return 'x'; }"), "projection_confinement_refused", /binary_missing/u, () => confinedCall(planted("pure2", "export function projectText(): string { return 'x'; }"), "{}", { ...CONFINEMENT, harnessRoot: createTempDir("no-guardian-") }));
  // Narrowing only takes authority away: a rule outside the compiled floor, or wider than it, is refused.
  const scratch = createTempDir("narrow-");
  const compiled = compileSelfProtectionConfigToSpec(parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true, tempDir: scratch }), ENGINE_ROOT, scratch, process.execPath, emptyKeepOutFacts());
  assert.deepEqual(narrowGuardianSpec(compiled, [{ path: "/usr/lib", access: ["READ_FILE"] }]).allow_rules, [{ path: "/usr/lib", access: ["READ_FILE"] }]);
  assert.equal(narrowGuardianSpec(compiled, [{ path: "/usr/lib", access: ["READ_FILE"] }]).temp_dir, undefined, "the temp folder grant is dropped");
  for (const rule of [{ path: "/home", access: ["READ_FILE"] as const }, { path: "/usr", access: ["WRITE_FILE"] as const }, { path: join(ENGINE_ROOT, "src"), access: ["READ_FILE"] as const }]) {
    assert.throws(() => narrowGuardianSpec(compiled, [rule]), (error: HarnessError) => error.code === "confined_rule_outside_floor", rule.path);
  }
  assert.ok(PROJECTION_PROGRAM.modules.every((path) => path.startsWith(join(REPOSITORY_ROOT, "engine/src/")) || path === join(REPOSITORY_ROOT, "shared/markdown.ts")), "the projection's program links only the source it declares");
});

test("the first run creates in phase order, verifies, and its receipt names every write", async () => {
  const { projection, digest } = computeProjection(INPUT, CONFINEMENT);
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
  const { projection } = computeProjection(INPUT, CONFINEMENT);
  const github = memoryStore();
  const first = await applyProjection(projection, github.store, { allowance: 100 });
  const before = github.writes().length;
  const again = await applyProjection(computeProjection(INPUT, CONFINEMENT).projection, github.store, { allowance: 100 });
  assert.equal(github.writes().length, before, "no write reached the store");
  assert.deepEqual(again.writes, []);
  assert.equal(again.verified, true);
  assert.equal(again.observedDigest, first.observedDigest, "GitHub is observed exactly as the first run left it");
  // One item closes: one state write, nothing else.
  const changed = input([INPUT.items[0]!, { ...INPUT.items[1]!, state: "closed", resolution: "completed" }, INPUT.items[2]!]);
  const next = await applyProjection(computeProjection(changed, CONFINEMENT).projection, github.store, { allowance: 100 });
  assert.deepEqual(next.writes.map((write) => `${write.phase}:${write.class}/${write.key}:${write.fields.join(",")}`), [
    "create:issue/B-CHILD:block", "state:issue/B-CHILD:state,stateReason",
  ], "the block's digest moves with the record; the state is set; nothing else");
  assert.equal(next.verified, true);
});

test("V-28: a field GitHub silently does not keep is projection_unverified, never a success", async () => {
  const github = memoryStore({ drops: ["issue.type"] });
  const receipt = await applyProjection(computeProjection(INPUT, CONFINEMENT).projection, github.store, { allowance: 100 });
  assert.equal(receipt.verified, false);
  assert.deepEqual(receipt.unverified.map((field) => `${field.class}/${field.key}.${field.field}`), ["issue/A-PARENT.type", "issue/B-CHILD.type", "issue/C-DONE.type"]);
  assert.equal(receipt.unverified[0]!.expected, "Workstream");
  assert.equal(receipt.unverified[0]!.observed, undefined);
  const failure = projectionFailure(receipt);
  assert.equal(failure?.code, "projection_unverified");
  assert.match(failure!.message, /issue\/A-PARENT\.type, issue\/B-CHILD\.type, issue\/C-DONE\.type are not what the projection/u);
});

test("an exhausted allowance stops typed and retryable, and the next run resumes the diff to a verified state", async () => {
  const { projection } = computeProjection(INPUT, CONFINEMENT);
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
  const receipt = await applyProjection(computeProjection(INPUT, CONFINEMENT).projection, github.store, { allowance: 100 });
  assert.deepEqual(receipt.refusals.map((refusal) => [refusal.code, refusal.class, refusal.key, refusal.retryable]), [["github_forbidden", "issue", "A-PARENT", false]]);
  assert.equal(receipt.writes.length, 1);
  assert.equal(receipt.verified, false);
  assert.equal(projectionFailure(receipt)?.code, "github_forbidden");
  assert.equal(github.get("issue", "B-CHILD"), undefined, "nothing after the refusal was written");
});

test("an OWNED live object D does not hold is an orphan: reported, never written; a person's label or issue is never one", async () => {
  const github = memoryStore();
  github.put({ class: "issue", key: "GONE", fields: { title: "GONE" }, owned: true });
  github.put({ class: "label", key: "lane:retired", fields: { color: "000000", description: "x" }, owned: true });
  // A person's label and a person's issue are GitHub's own: never orphans.
  github.put({ class: "label", key: "bug", fields: { color: "d73a4a", description: "Something isn't working" }, owned: false });
  github.put({ class: "issue", key: "#7", fields: { title: "A reporter's question" }, owned: false });
  const { projection } = computeProjection(INPUT, CONFINEMENT);
  assert.deepEqual(planProjection(projection, [{ class: "issue", key: "GONE", fields: {}, owned: true }]).orphans, ["issue/GONE"]);
  const receipt = await applyProjection(projection, github.store, { allowance: 100 });
  assert.deepEqual(receipt.orphans, ["issue/GONE", "label/lane:retired"]);
  assert.ok(receipt.writes.every((write) => !["GONE", "lane:retired", "bug", "#7"].includes(write.key)));
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
  const { projection } = computeProjection(read, CONFINEMENT);
  assert.equal(projection.objects.filter((object) => object.class === "issue").length, read.items.length);
  assert.ok(read.items.length > 0);
  assert.equal(projection.objects.filter((object) => object.class === "label").length, read.lanes.length);
});
