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
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { TRACKER_ITEM_TYPES } from "../../src/workflow/failure-owners.ts";
import { FORGE_ISSUE_TYPES } from "../../src/workflow/forge/declarations.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { schemaId } from "../../src/kernel/product-identity.ts";
import { LABELS_PATH } from "../../src/workflow/community/labels.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { applyProjection, planProjection, projectionFailure } from "../../src/workflow/forge/projector/apply.ts";
import { PROJECTION_INPUT_SCHEMA, type ProjectionInput } from "../../src/workflow/forge/projector/model.ts";
import { computeProjection, deterministicCall, projectionInput } from "../../src/workflow/forge/projector/projection.ts";
import { configuredConfinement, confinedCall, confinedModules, PROJECTION_PROGRAM, ROADMAP_FEED_PROGRAM, type ConfinedModule, type ProjectorConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { compileSelfProtectionConfigToSpec, resolveGuardianBinaryPath } from "../../src/filesystem/self-protection/guardian-binary.ts";
import { narrowGuardianSpec } from "../../src/filesystem/self-protection/confined-run.ts";
import { procfsPath } from "../../src/process/process-facts.ts";
import { DEFAULT_SELF_PROTECTION_CONFIG, parseSelfProtectionConfig } from "../../src/filesystem/self-protection/self-protection-config.ts";
import { emptyKeepOutFacts } from "../support/keep-out-facts.ts";
import { requireHost } from "../support/host-requirement.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";
import { configuredRepositoryIdentity } from "../../src/workflow/forge/repository-identity.ts";
import { memoryStore } from "./projection-store.ts";

const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const ENGINE_ROOT = join(REPOSITORY_ROOT, "engine");
/** Every projection here runs confined: this engine's guardian, an empty keep-out registry of the test's own, a generous CPU ceiling, admitted in the host's run registry (inside a test run, it borrows that run and its caps). */
const CONFINEMENT: ProjectorConfinement = configuredConfinement(ENGINE_ROOT, emptyKeepOutFacts(), 60);

const item = (id: string, overrides: Partial<ProjectionInput["items"][number]> = {}): ProjectionInput["items"][number] => ({
  id, type: "Task", title: null, state: "open", resolution: null, lane: "floor", milestone: null, parent: null, blockedBy: [], decisions: [], tests: [], evidence: null,
  body: `The outcome of ${id}; see [the roadmap](../../floor/roadmap.md#m1).`, path: `${TRACKER_BOARD.items}/${id}.md`, ...overrides,
});
const input = (items: ProjectionInput["items"], source = SOURCE): ProjectionInput => ({
  schema: PROJECTION_INPUT_SCHEMA, source, ledger: null, repositoryUrl: "https://github.com/owner/repo",
  items, decisions: [], recordedEvidence: [], mainRuns: [],
});
const INPUT = input([
  item("A-PARENT", { title: "The parent", type: "Workstream" }),
  item("B-CHILD", { parent: "A-PARENT", blockedBy: ["C-DONE"] }),
  item("C-DONE", { state: "closed", resolution: "not-planned" }),
]);

test("D is the tracker's issues and labels, with permalinks at S and the projector's marker", () => {
  const { projection, digest } = computeProjection(INPUT, CONFINEMENT);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(projection.objects.map((object) => `${object.class}/${object.key}`), ["issue/A-PARENT", "issue/B-CHILD", "issue/C-DONE"]);
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

test("memory is the admitted run's cgroup cap (the one memory-bounds owner): a program allocating three times its run's memory.max, read from the run's own cgroup, is refused typed projection_memory_exhausted", () => {
  requireHost(resolveGuardianBinaryPath(ENGINE_ROOT) !== undefined, "the built guardian (make -C engine/guardian all)");
  // Runs of this test's own registry, admitted at 1% of the host's memory with no swap, in a child process (admission moves its process into the run's scope).
  const directory = createTempDir("projector-memory-");
  const entry = join(directory, "allocate.ts");
  // The input is how many bytes to touch, a MiB at a time: 0 for the probe.
  writeFileSync(entry, "export function projectText(input: string): string { const bytes = Number(input); const kept: Uint8Array[] = []; for (let done = 0; done < bytes; done += 1 << 20) kept.push(new Uint8Array(1 << 20).fill(1)); return String(kept.length); }");
  const script = join(directory, "memory.mjs");
  writeFileSync(script, [
    `const { confinedCall } = await import(${JSON.stringify(join(ENGINE_ROOT, "src/workflow/forge/projector/confined.ts"))});`,
    `const { ownCgroupFile, ownCgroupPath } = await import(${JSON.stringify(join(ENGINE_ROOT, "src/process/process-facts.ts"))});`,
    `const { emptyKeepOutFacts } = await import(${JSON.stringify(join(ENGINE_ROOT, "test/support/keep-out-facts.ts"))});`,
    `const module = { entry: ${JSON.stringify(entry)}, roots: [${JSON.stringify(directory)}], exportName: "projectText" };`,
    `const confinement = { harnessRoot: ${JSON.stringify(ENGINE_ROOT)}, keepOut: emptyKeepOutFacts(), cpuSeconds: 120, run: { lockPath: ${JSON.stringify(join(directory, "instrument.lock"))}, perRun: { memoryMaxPercent: 1, cpuWeight: 100 } } };`,
    // The probe: an admitted run of these caps; this process stays in its scope after it, so the scope's own memory.max is the cap.
    `confinedCall(module, "0", confinement);`,
    `const scope = ownCgroupPath();`,
    `const max = Number(ownCgroupFile("memory.max"));`,
    `if (!Number.isSafeInteger(max) || max <= 0) { process.stdout.write(\`NO-CAP \${ownCgroupFile("memory.max")}\\n\`); process.exit(0); }`,
    `let ending;`,
    `try { confinedCall(module, String(3 * max), confinement); ending = "ANSWERED"; } catch (error) { ending = \`REFUSED \${error.code}\`; }`,
    `process.stdout.write(\`\${ending} scope=\${scope} max=\${max}\\n\`);`,
  ].join("\n"));
  const ran = spawnSync(process.execPath, ["--experimental-strip-types", script], { cwd: ENGINE_ROOT, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  // No swap under the cap: three times memory.max cannot be held, so the kernel ends the program and the admission owner refuses the run, typed.
  assert.match(ran.stdout, /^REFUSED projection_memory_exhausted scope=\/\S+\/bridlewise-run-[0-9a-f-]+\.scope max=[1-9]\d*$/mu, `${ran.stdout} ${ran.stderr}`);
});

test("a confinement is built only under a declared run registry: a root without testExecution.instrumentLock is refused instrument_lock_undeclared", () => {
  assert.throws(() => configuredConfinement(createTempDir("projector-no-lock-"), emptyKeepOutFacts(), 60), (error: HarnessError) => error.code === "instrument_lock_undeclared" && /testExecution\.instrumentLock/u.test(error.message));
  // This checkout declares one: the confinement carries its registry and per-run caps.
  assert.ok(CONFINEMENT.run.lockPath.length > 0 && CONFINEMENT.run.perRun.memoryMaxPercent > 0);
});

test("V-26: purity is a kernel property — two confined processes give one digest, and every reach outside the input is refused", async () => {
  requireHost(resolveGuardianBinaryPath(ENGINE_ROOT) !== undefined, "the built guardian (make -C engine/guardian all)");
  const first = computeProjection(INPUT, CONFINEMENT);
  const second = computeProjection(JSON.parse(JSON.stringify(INPUT)) as ProjectionInput, CONFINEMENT);
  assert.equal(first.digest, second.digest, "two confined processes (each computing twice), one digest");
  const directory = createTempDir("projector-confined-");
  // Each planted program's root is its own folder; a sibling written beside that folder lies outside it.
  const planted = (name: string, source: string, siblings: Readonly<Record<string, string>> = {}): ConfinedModule => {
    const root = join(directory, name);
    mkdirSync(root, { recursive: true });
    const entry = join(root, `${name}.ts`);
    writeFileSync(entry, source);
    for (const [file, text] of Object.entries(siblings)) writeFileSync(join(directory, file), text);
    return { entry, roots: [root], exportName: "projectText" };
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
  // The LINK refuses a module outside the program's roots, and any import that is not relative, before anything runs.
  refused(planted("sibling", "import { value } from '../outside.ts';\nexport function projectText(): string { return value; }", { "outside.ts": "export const value = 'x';" }), "projection_import_refused", /outside\.ts \(imported by [^)]+\) is outside the confined program's roots/u);
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
});

test("each confined program's modules are its entry's import closure, derived, never listed: every module the entry reaches links, and only under its roots", () => {
  for (const program of [PROJECTION_PROGRAM, ROADMAP_FEED_PROGRAM]) {
    const modules = confinedModules(program);
    assert.ok(modules.includes(program.entry), program.entry);
    // tracker-status.ts's own import (the `repo:` reference) links in BOTH programs that reach it: no second list to forget.
    for (const reached of ["workflow/tracker-status.ts", "workflow/forge/repository-reference.ts"]) assert.ok(modules.includes(join(ENGINE_ROOT, "src", reached)), `${program.exportName}: ${reached}`);
    assert.ok(modules.every((path) => path.startsWith(join(REPOSITORY_ROOT, "engine/src/")) || path.startsWith(join(REPOSITORY_ROOT, "shared/"))), `${program.exportName} links only the engine's source and shared/`);
  }
  for (const shared of ["shared/markdown.ts", "shared/markup.ts"]) assert.ok(confinedModules(PROJECTION_PROGRAM).includes(join(REPOSITORY_ROOT, shared)), `the projection reaches ${shared}`);
  // Containment is decided by IDENTITY, never by spelling: a module reached through a link that leaves the root is refused,
  // even though its spelled path lies under the root.
  const directory = createTempDir("projector-links-");
  const root = join(directory, "root");
  const outside = join(directory, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.ts"), "export const value = 'x';\n");
  writeFileSync(join(root, "kept.ts"), "export const value = 'y';\n");
  symlinkSync(join(outside, "secret.ts"), join(root, "file-link.ts"));
  symlinkSync(outside, join(root, "dir-link"));
  symlinkSync(join(root, "kept.ts"), join(root, "inside-link.ts"));
  writeFileSync(join(root, "reexport.ts"), "export { value } from './dir-link/secret.ts';\n");
  let entries = 0;
  const program = (source: string): ConfinedModule => {
    entries += 1;
    const entry = join(root, `entry-${String(entries)}.ts`);
    writeFileSync(entry, `${source}\nexport function projectText(): string { return value; }\n`);
    return { entry, roots: [root], exportName: "projectText" };
  };
  for (const [why, source] of [
    ["a file link out of the root", "import { value } from './file-link.ts';"],
    ["a directory link out of the root", "import { value } from './dir-link/secret.ts';"],
    ["a re-export through a link", "import { value } from './reexport.ts';"],
  ] as const) {
    assert.throws(() => confinedModules(program(source)), (error: HarnessError) => error.code === "projection_import_refused" && /outside the confined program's roots/u.test(error.message), why);
  }
  // Near miss: a link that stays inside the root links.
  assert.ok(confinedModules(program("import { value } from './inside-link.ts';")).length >= 2, "a link inside the root is inside it");
});

test("the first run creates in phase order, verifies, and its receipt names every write", async () => {
  const { projection, digest } = computeProjection(INPUT, CONFINEMENT);
  const github = memoryStore();
  const receipt = await applyProjection(projection, github.store, { allowance: 100, previous: null, foreignEdit: "approval" });
  assert.equal(projectionFailure(receipt), null);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.digest, digest);
  assert.equal(receipt.observedDigest.length, 64);
  // create (every issue) → link (the child's parent and blocker) → state (the closed item).
  assert.deepEqual(receipt.writes.map((write) => `${write.phase}:${write.kind}:${write.class}/${write.key}`), [
    "create:create:issue/A-PARENT", "create:create:issue/B-CHILD", "create:create:issue/C-DONE",
    "link:update:issue/B-CHILD", "state:update:issue/C-DONE",
  ]);
  assert.deepEqual(receipt.writes[3]!.fields, ["blockedBy", "parent"]);
  assert.deepEqual(github.get("issue", "C-DONE")?.fields.stateReason, "not_planned");
});

test("V-25: a second run on the same (S, L) makes zero writes, and a changed record writes only its difference", async () => {
  const { projection } = computeProjection(INPUT, CONFINEMENT);
  const github = memoryStore();
  const first = await applyProjection(projection, github.store, { allowance: 100, previous: null, foreignEdit: "approval" });
  const before = github.writes().length;
  const again = await applyProjection(computeProjection(INPUT, CONFINEMENT).projection, github.store, { allowance: 100, previous: first, foreignEdit: "approval" });
  assert.equal(github.writes().length, before, "no write reached the store");
  assert.deepEqual(again.writes, []);
  assert.equal(again.verified, true);
  assert.equal(again.observedDigest, first.observedDigest, "GitHub is observed exactly as the first run left it");
  // One item closes: one state write, nothing else.
  const changed = input([INPUT.items[0]!, { ...INPUT.items[1]!, state: "closed", resolution: "completed", tests: ["tests/b-child.test.ts"] }, INPUT.items[2]!]);
  const next = await applyProjection(computeProjection(changed, CONFINEMENT).projection, github.store, { allowance: 100, previous: again, foreignEdit: "approval" });
  assert.deepEqual(next.foreignEdits, [], "a changed RECORD is never taken for a foreign edit: it moves D, not the receipt's baseline");
  assert.deepEqual(next.writes.map((write) => `${write.phase}:${write.class}/${write.key}:${write.fields.join(",")}`), [
    "create:issue/A-PARENT:block", "create:issue/B-CHILD:block", "state:issue/B-CHILD:state,stateReason",
  ], "the child's block moves with its record and its state is set; the parent's block states its new roadmap state (B-CHILD shipped); nothing else");
  assert.equal(next.verified, true);
});

test("V-28: a field GitHub silently does not keep is projection_unverified, never a success", async () => {
  const github = memoryStore({ drops: ["issue.type"] });
  const receipt = await applyProjection(computeProjection(INPUT, CONFINEMENT).projection, github.store, { allowance: 100, previous: null, foreignEdit: "approval" });
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
  const first = await applyProjection(projection, github.store, { allowance: 1, previous: null, foreignEdit: "approval" });
  assert.equal(first.writes.length, 1);
  assert.deepEqual(first.refusals.map((refusal) => [refusal.code, refusal.retryable]), [["github_content_budget_exhausted", true]]);
  assert.deepEqual(first.pending, ["issue/B-CHILD", "issue/C-DONE"]);
  assert.deepEqual(first.unverified, [], "the objects the run wrote are verified; the pending ones are only pending");
  assert.equal(projectionFailure(first)?.retryable, true);
  assert.deepEqual(Object.keys(first.objects).sort(), ["issue/A-PARENT"], "a pending object is not recorded: it was never seen on GitHub");
  // The next run resumes from this receipt: a pending object is created, never judged deleted.
  const second = await applyProjection(projection, github.store, { allowance: 100, previous: first, foreignEdit: "approval" });
  assert.deepEqual(second.foreignEdits, []);
  assert.equal(second.verified, true);
  assert.equal(second.writes.length, 4, "it resumes with exactly the writes left");
});

test("a refused write stops the run with the object it was writing; the rest stays as it was", async () => {
  const github = memoryStore({ refuseAt: { write: 1, error: new HarnessError("forbidden", "github_forbidden") } });
  const receipt = await applyProjection(computeProjection(INPUT, CONFINEMENT).projection, github.store, { allowance: 100, previous: null, foreignEdit: "approval" });
  assert.deepEqual(receipt.refusals.map((refusal) => [refusal.code, refusal.class, refusal.key, refusal.retryable]), [["github_forbidden", "issue", "B-CHILD", false]]);
  assert.equal(receipt.writes.length, 1);
  assert.equal(receipt.verified, false);
  assert.equal(projectionFailure(receipt)?.code, "github_forbidden");
  assert.equal(github.get("issue", "C-DONE"), undefined, "nothing after the refusal was written");
});

test("an OWNED live object D does not hold is an orphan: reported, never written; a person's issue is never one, and the projector holds no label", async () => {
  const github = memoryStore();
  github.put({ class: "issue", key: "GONE", fields: { title: "GONE" }, owned: true });
  // A person's issue is GitHub's own: never an orphan.
  github.put({ class: "issue", key: "#7", fields: { title: "A reporter's question" }, owned: false });
  const { projection } = computeProjection(INPUT, CONFINEMENT);
  assert.deepEqual(planProjection(projection, [{ class: "issue", key: "GONE", fields: {}, owned: true }]).orphans, ["issue/GONE"]);
  const receipt = await applyProjection(projection, github.store, { allowance: 100, previous: null, foreignEdit: "approval" });
  assert.deepEqual(receipt.orphans, ["issue/GONE"]);
  assert.ok(receipt.writes.every((write) => !["GONE", "#7"].includes(write.key)));
  // Labels are declared once (docs/community/labels.json) and applied by the forge: D holds none, so the projector neither writes nor reports one.
  assert.deepEqual(projection.objects.filter((object) => !["milestone", "issue"].includes(object.class)), []);
});

/** A repository's declared labels file, as its owner reads it (`docs/community/labels.json`). */
const labelsFile = (root: string, names: readonly string[]): void => {
  mkdirSync(join(root, LABELS_PATH, ".."), { recursive: true });
  writeFileSync(join(root, LABELS_PATH), `${JSON.stringify({ schema: schemaId("community-labels", 1), labels: names.map((name) => ({ name, color: "1d76db", description: `The ${name} label` })) })}\n`);
};

test("the input is read from the source COMMIT, never the working tree", () => {
  const root = createTempDir("projector-input-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  const write = (id: string, title: string): void => writeFileSync(join(root, TRACKER_BOARD.items, `${id}.md`), `---\nschema: bridlewise-tracker-item/v1\npublished: false\nid: ${id}\ntype: Task\ntitle: ${title}\nstate: open\nlane: floor\nopened: 2026-10-21\n---\n\nThe outcome.\n`);
  write("A-ONE", "As committed");
  labelsFile(root, ["lane:floor"]);
  git("add", "."); git("commit", "-q", "-m", "one");
  const commit = git("rev-parse", "HEAD");
  write("A-ONE", "Edited after the commit");
  write("B-TWO", "Never committed");
  const read = projectionInput(configuredGitRepository({}, root), "HEAD", null, "https://github.com/owner/repo");
  assert.equal(read.source, commit, "the source is the full commit id");
  assert.deepEqual(read.items.map((entry) => [entry.id, entry.title, entry.path]), [["A-ONE", "As committed", `${TRACKER_BOARD.items}/A-ONE.md`]]);
  assert.throws(() => projectionInput(configuredGitRepository({}, root), "no-such-ref", null, "https://github.com/owner/repo"), (error: HarnessError) => error.code === "projection_source_missing");
});

test("every lane label an item carries is declared in labels.json AT S: an undeclared one is refused, naming the item; a declaration only in the working tree does not count; a commit without the file is refused", () => {
  const root = createTempDir("projector-labels-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  const write = (id: string, lane: string): void => writeFileSync(join(root, TRACKER_BOARD.items, `${id}.md`), `---\nschema: bridlewise-tracker-item/v1\npublished: false\nid: ${id}\ntype: Task\ntitle: ${id}\nstate: open\nlane: ${lane}\nopened: 2026-10-21\n---\n\nThe outcome.\n`);
  const read = (): ProjectionInput => projectionInput(configuredGitRepository({}, root), "HEAD", null, "https://github.com/owner/repo");
  write("A-ONE", "floor");
  git("add", "."); git("commit", "-q", "-m", "no labels file");
  assert.throws(read, (error: HarnessError) => error.code === "projection_labels_missing");
  labelsFile(root, ["Lane:Floor"]);
  write("B-TWO", "roadmap");
  git("add", "."); git("commit", "-q", "-m", "floor declared, roadmap not");
  assert.throws(read, (error: HarnessError) => error.code === "projection_label_undeclared" && /B-TWO \(lane:roadmap\)/u.test(error.message) && !/A-ONE/u.test(error.message));
  // Declared in the working tree only: S still lacks it.
  labelsFile(root, ["lane:floor", "lane:roadmap"]);
  assert.throws(read, (error: HarnessError) => error.code === "projection_label_undeclared");
  git("add", "."); git("commit", "-q", "-m", "roadmap declared");
  assert.deepEqual(read().items.map((entry) => entry.lane), ["floor", "roadmap"]);
});

test("this repository's own HEAD projects: every tracker item is an issue, and no label", () => {
  const read = projectionInput(configuredGitRepository({}, REPOSITORY_ROOT), "HEAD", null, configuredRepositoryIdentity().webUrl);
  const { projection } = computeProjection(read, CONFINEMENT);
  assert.equal(projection.objects.filter((object) => object.class === "issue").length, read.items.length);
  assert.ok(read.items.length > 0);
});

const MILESTONE_INPUT = input([
  item("M1", { type: "Milestone", title: "First milestone", state: null, lane: null }),
  item("W-ONE", { type: "Workstream", lane: "roadmap", milestone: "M1" }),
  item("T-ONE", { milestone: "M1", parent: "W-ONE", state: "closed", resolution: "completed", tests: ["tests/t-one.test.ts"] }),
  item("T-TWO", { lane: "roadmap", milestone: "M1" }),
]);

test("a Milestone item is a milestone and the head of its hierarchy: milestone → workstream → task, states computed from the records", () => {
  const { projection } = computeProjection(MILESTONE_INPUT, CONFINEMENT);
  const object = (klass: string, key: string) => projection.objects.find((entry) => entry.class === klass && entry.key === key)!;
  assert.deepEqual(object("milestone", "M1").fields.title, "M1 · First milestone");
  assert.equal(object("milestone", "M1").fields.state, "open");
  assert.match(String(object("milestone", "M1").fields.description), /^in progress: 1 of 3 members shipped, 0 claimed, 1 in progress, 0 blocked\. Computed from the records/u);
  // The milestone's own issue heads the hierarchy; a work item without a parent hangs under it.
  assert.deepEqual([object("issue", "M1").fields.type, object("issue", "M1").fields.parent, object("issue", "M1").fields.milestone, object("issue", "M1").fields.labels], ["Milestone", null, "M1", []]);
  assert.deepEqual([object("issue", "W-ONE").fields.parent, object("issue", "W-ONE").fields.milestone], ["M1", "M1"]);
  assert.deepEqual([object("issue", "T-ONE").fields.parent, object("issue", "T-TWO").fields.parent], ["W-ONE", "M1"]);
  assert.match(String(object("issue", "W-ONE").fields.block), /Roadmap state: \*\*in progress\*\* \(T-ONE shipped\)/u);
  // Every member shipped: the milestone and its issue close as completed.
  const done = computeProjection(input(MILESTONE_INPUT.items.map((entry) => entry.type === "Milestone" ? entry : { ...entry, state: "closed", resolution: "completed", tests: [`tests/${entry.id}.test.ts`] })), CONFINEMENT).projection;
  const closed = (klass: string, key: string) => done.objects.find((entry) => entry.class === klass && entry.key === key)!.fields;
  assert.equal(closed("milestone", "M1").state, "closed");
  assert.deepEqual([closed("issue", "M1").state, closed("issue", "M1").stateReason], ["closed", "completed"]);
});

test("V-27: a foreign edit in each class is detected and handled per mode — approval proposes, auto restores (an issue gets a notice), manual reports; a field no record holds is re-projected in every mode, never proposed", async () => {
  const { projection } = computeProjection(MILESTONE_INPUT, CONFINEMENT);
  const projected = (klass: string, key: string, field: string) => projection.objects.find((entry) => entry.class === klass && entry.key === key)!.fields[field]!;
  const edits = [
    // A field no record holds: an issue's generated block.
    { klass: "issue", key: "T-ONE", fields: { block: "Rewritten in the UI" } },
    // Fields a record holds.
    { klass: "milestone", key: "M1", fields: { title: "Renamed in the UI" } },
    { klass: "issue", key: "T-TWO", fields: { title: "Retitled in the UI", labels: ["lane:roadmap", "wontfix"] } },
  ] as const;
  const order = (line: string): number => ["milestone", "issue"].indexOf(line.split("/")[0]!);
  for (const mode of ["approval", "auto", "manual"] as const) {
    const github = memoryStore();
    const first = await applyProjection(projection, github.store, { allowance: 100, previous: null, foreignEdit: mode });
    assert.equal(first.verified, true);
    for (const edit of edits) github.edit(edit.klass, edit.key, edit.fields);
    const run = await applyProjection(projection, github.store, { allowance: 100, previous: first, foreignEdit: mode });
    const action = mode === "auto" ? "restored" : mode === "approval" ? "proposed" : "reported";
    assert.deepEqual(run.foreignEdits.map((edit) => `${edit.class}/${edit.key}:${edit.fields.join(",")}:${edit.action}`).sort((left, right) => order(left) - order(right) || left.localeCompare(right)), [
      `milestone/M1:title:${action}`,
      "issue/T-ONE:block:restored",
      `issue/T-TWO:labels,title:${action}`,
    ], mode);
    // In every mode, the projector-owned fields are written back and never proposed.
    assert.equal(github.get("issue", "T-ONE")?.fields.block, projected("issue", "T-ONE", "block"), mode);
    assert.ok(run.proposals.every((proposal) => proposal.change !== "edited" || !("block" in proposal.fields)), `${mode}: no projector-owned field flows back`);
    if (mode === "auto") {
      assert.equal(run.verified, true, "auto: every projected value is restored and verified");
      assert.equal(github.get("issue", "T-TWO")?.fields.title, "T-TWO");
      assert.deepEqual(github.notices().map((notice) => notice.split(":")[0]).sort(), ["issue/T-ONE", "issue/T-TWO"], "only an issue can carry a notice");
      assert.equal(projectionFailure(run), null);
      continue;
    }
    assert.equal(github.get("issue", "T-TWO")?.fields.title, "Retitled in the UI", `${mode}: a record's field is never written over a foreign edit`);
    assert.equal(run.verified, false);
    assert.equal(projectionFailure(run)?.code, "projection_drift");
    assert.deepEqual(run.proposals, mode === "approval"
      ? [{ class: "milestone", key: "M1", change: "edited", fields: { title: "Renamed in the UI" } }, { class: "issue", key: "T-TWO", change: "edited", fields: { labels: ["lane:roadmap", "wontfix"], title: "Retitled in the UI" } }]
      : [], `${mode}: a proposal only under approval, and only of a record's fields`);
    // The record's edits stay foreign on the next run (the baseline is kept), until the record or GitHub moves.
    const again = await applyProjection(projection, github.store, { allowance: 100, previous: run, foreignEdit: mode });
    assert.equal(again.foreignEdits.length, 2, `${mode}: still held, never silently adopted as the new baseline`);
    // GitHub moved back to the projection: nothing is foreign any more.
    github.edit("milestone", "M1", { title: projected("milestone", "M1", "title") });
    github.edit("issue", "T-TWO", { title: projected("issue", "T-TWO", "title"), labels: projected("issue", "T-TWO", "labels") });
    const healed = await applyProjection(projection, github.store, { allowance: 100, previous: again, foreignEdit: mode });
    assert.deepEqual([healed.foreignEdits, healed.verified], [[], true], `${mode}: once GitHub meets the record again, the projection is verified`);
  }
});

test("a first run has no baseline: every difference is adopted, never a foreign edit", async () => {
  const github = memoryStore();
  github.put({ class: "milestone", key: "M1", fields: { title: "An old title", description: "old", state: "open" }, owned: true });
  const { projection } = computeProjection(MILESTONE_INPUT, CONFINEMENT);
  const receipt = await applyProjection(projection, github.store, { allowance: 100, previous: null, foreignEdit: "manual" });
  assert.deepEqual(receipt.foreignEdits, []);
  assert.equal(github.get("milestone", "M1")?.fields.title, projection.objects.find((entry) => entry.class === "milestone" && entry.key === "M1")!.fields.title);
  assert.equal(receipt.verified, true);
});

test("V-27 per field: a field newly owned by git is written, never held; one edited field never blocks another field or object; the proposal holds only the edited field", async () => {
  const { projection } = computeProjection(MILESTONE_INPUT, CONFINEMENT);
  const github = memoryStore();
  const first = await applyProjection(projection, github.store, { allowance: 100, previous: null, foreignEdit: "approval" });
  // A field newly owned by git: the previous receipt records no value for issue.milestone (an older projector did not own it).
  const olderReceipt = { ...first, objects: Object.fromEntries(Object.entries(first.objects).map(([key, fields]) => [key, Object.fromEntries(Object.entries(fields).filter(([field]) => field !== "milestone"))])) };
  github.edit("issue", "T-TWO", { milestone: null });
  const adopted = await applyProjection(projection, github.store, { allowance: 100, previous: olderReceipt, foreignEdit: "approval" });
  assert.deepEqual(adopted.foreignEdits, [], "a field with no recorded value is nothing an edit could differ from");
  assert.equal(github.get("issue", "T-TWO")?.fields.milestone, "M1", "the newly owned field is written");
  assert.equal(adopted.verified, true);
  // Someone retitles T-TWO on GitHub while its record CLOSES it (proven) and W-ONE's record is retitled.
  github.edit("issue", "T-TWO", { title: "Retitled in the UI" });
  const moved = input(MILESTONE_INPUT.items.map((entry) => entry.id === "T-TWO" ? { ...entry, state: "closed", resolution: "completed", tests: ["tests/t-two.test.ts"] } : entry.id === "W-ONE" ? { ...entry, title: "Renamed workstream" } : entry));
  const run = await applyProjection(computeProjection(moved, CONFINEMENT).projection, github.store, { allowance: 100, previous: adopted, foreignEdit: "approval" });
  assert.deepEqual(run.foreignEdits.map((edit) => [edit.key, edit.change, edit.fields]), [["T-TWO", "edited", ["title"]]]);
  assert.deepEqual(run.proposals, [{ class: "issue", key: "T-TWO", change: "edited", fields: { title: "Retitled in the UI" } }], "the proposal changes only the edited field");
  const tTwo = github.get("issue", "T-TWO")!.fields;
  assert.deepEqual([tTwo.title, tTwo.state, tTwo.stateReason], ["Retitled in the UI", "closed", "completed"], "the held title stays; the record's close is written beside it");
  assert.equal(github.get("issue", "W-ONE")?.fields.title, "Renamed workstream", "another object's change is written");
  assert.equal(run.verified, false, "a held field leaves the projection unverified");
  assert.equal(projectionFailure(run)?.code, "projection_drift");
  assert.ok(run.unverified.every((field) => !(field.key === "T-TWO" && field.field === "title")), "the held field is drift, not an unverified write");
});

test("V-27 deletion: a projected object deleted on GitHub is a foreign change — approval proposes, auto recreates (with a notice), manual reports; never silently recreated", async () => {
  const { projection } = computeProjection(MILESTONE_INPUT, CONFINEMENT);
  for (const mode of ["approval", "auto", "manual"] as const) {
    const github = memoryStore();
    const first = await applyProjection(projection, github.store, { allowance: 100, previous: null, foreignEdit: mode });
    github.remove("issue", "T-TWO");
    const run = await applyProjection(projection, github.store, { allowance: 100, previous: first, foreignEdit: mode });
    assert.deepEqual(run.foreignEdits.map((edit) => [edit.key, edit.change, edit.action]), [["T-TWO", "deleted", mode === "auto" ? "restored" : mode === "approval" ? "proposed" : "reported"]], mode);
    if (mode === "auto") {
      assert.equal(github.get("issue", "T-TWO")?.fields.title, "T-TWO", "auto recreates it");
      assert.match(github.notices().at(-1) ?? "", /was deleted on GitHub and is recreated from its record/u);
      assert.equal(run.verified, true);
    } else {
      assert.equal(github.get("issue", "T-TWO"), undefined, `${mode}: never silently recreated`);
      assert.deepEqual(run.proposals, mode === "approval" ? [{ class: "issue", key: "T-TWO", change: "deleted" }] : []);
      assert.equal(projectionFailure(run)?.code, "projection_drift");
    }
  }
  // A never-projected object is simply created: absence without a baseline is no deletion.
  const fresh = await applyProjection(projection, memoryStore().store, { allowance: 100, previous: null, foreignEdit: "manual" });
  assert.deepEqual(fresh.foreignEdits, []);
});

test("writes go by phase before class: a milestone's state is written after every issue is created", async () => {
  const shippedMilestone = input(MILESTONE_INPUT.items.map((entry) => entry.type === "Milestone" ? entry : { ...entry, state: "closed", resolution: "completed", tests: [`tests/${entry.id}.test.ts`] }));
  const receipt = await applyProjection(computeProjection(shippedMilestone, CONFINEMENT).projection, memoryStore().store, { allowance: 100, previous: null, foreignEdit: "approval" });
  const order = receipt.writes.map((write) => `${write.phase}:${write.class}`);
  const milestoneState = order.indexOf("state:milestone");
  assert.ok(milestoneState > order.lastIndexOf("create:issue"), `the milestone's state (a later class's earlier write would be first by class) comes after every issue create: ${order.join(" ")}`);
});

test("every issue type the projection writes is one the forge declares: each tracker item type, and MAIN-RED's", () => {
  const declared = new Set(FORGE_ISSUE_TYPES.map((type) => type.name));
  const items = TRACKER_ITEM_TYPES.map((type, index) => item(`TYPE-${String(index)}`, type === "Milestone" ? { type, state: null, lane: null } : { type }));
  const red = [{ workflow: "door", commit: "a".repeat(40), conclusion: "failure" as const, runUrl: "https://github.com/owner/repo/actions/runs/1", failedTests: [{ path: "tests/a.test.ts", message: "boom", owners: [] }] }];
  const { projection } = computeProjection({ ...input(items), mainRuns: red }, CONFINEMENT);
  const written = [...new Set(projection.objects.filter((object) => object.class === "issue").map((object) => String(object.fields.type)))].sort();
  assert.ok(written.includes("Bug") && TRACKER_ITEM_TYPES.every((type) => written.includes(type)), `the projection wrote every type: ${written.join(", ")}`);
  assert.deepEqual(written.filter((type) => !declared.has(type)), [], "an issue type GitHub has no declaration for is a write the forge cannot keep: declare it in FORGE_ISSUE_TYPES (declarations.ts)");
});
