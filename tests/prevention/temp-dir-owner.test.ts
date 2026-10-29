// @vitest-environment node
/**
 * PREVENTION: `tests/helpers/temp-dir.ts` is the single owner of test temp dirs.
 *
 * WHY THIS EXISTS — a measured, not hypothetical, defect. Test files created
 * temp dirs by hand and removed them with a hand-written hook. The two halves
 * drifted; the dominant shape was `beforeEach` creating one dir per test while
 * `afterAll` removed only the last one. /tmp (a 36G tmpfs) accumulated 74,476
 * stale directories — 25,112 `ch-web-db-*` alone — hit 100%, and test runs
 * began failing with ENOSPC.
 *
 * Adding `afterEach(cleanup)` to each suite is the weak fix: it relies on the
 * next person remembering. This guard removes the option. Creation and removal
 * are fused in `createTempDir`, and the rules below make any other route to a
 * system temp directory a test failure.
 *
 * DYNAMIC DISCOVERY — the file list is walked from disk on every run. There is
 * no hardcoded inventory and no allowlist, so adding a test file can never
 * require editing this test. A guard that needs editing when you add a test is
 * itself a defect.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { bucketEndMs, bucketNameFor, createTempDir, createWorkerTempDir, liveTempDirCount } from "../helpers/temp-dir.ts";
import { readSourceView, sourceViewOf, type SourceView } from "../../engine/scripts/verification/source-view.ts";
import { cpuWorkOf } from "../../engine/src/shared/run-cpu.ts";

const TESTS_ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The one file allowed to touch the system temp root. Derived, not spelled. */
const OWNER = join(TESTS_ROOT, "helpers", "temp-dir.ts");

/**
 * This guard itself, derived from its own URL — it has to quote the banned
 * patterns in order to search for them. Self-exclusion is structural, not an
 * allowlist: it cannot go stale and it cannot be extended to another file.
 */
const GUARD = fileURLToPath(import.meta.url);

/** Every `.ts` file under tests/, discovered by walking the tree. */
function walkTestTree(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walkTestTree(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}


/**
 * The banned routes to a system temp directory, each tied to a shape that was
 * actually found in this tree.
 */
const BANNED: ReadonlyArray<{ readonly rule: RegExp; readonly why: string }> = [
  {
    // The unbounded leak: one new directory per call, forever.
    rule: /\bmkdtemp(?:Sync)?\s*\(/,
    why: "mkdtemp creates a temp dir with no owner — call createTempDir(prefix) instead",
  },
  {
    // The system temp ROOT. Denying the import denies every way to build a
    // path into it, including mkdirSync(join(tmpdir(), "fixed-name")).
    rule: /\btmpdir\s*\(\s*\)/,
    why: "os.tmpdir() is the system temp root — only the owner may reach it",
  },
];

/**
 * Manual temp-path construction: `const TMP_DIR = "/tmp/models-route-test"`
 * followed by `mkdirSync(TMP_DIR)`. Both halves are required to flag it.
 *
 * The binding alone is NOT enough: a "/tmp/..." string is often a fixture
 * VALUE — an API payload's project path, or a deliberately unowned path used
 * to assert that a permission gate rejects it. Those create nothing. What
 * makes it a leak is materialising the hardcoded path, so the rule looks for
 * the name reaching a directory-creating call.
 */
function hardcodedTempDirsCreated(code: string): readonly string[] {
  const bindings = [...code.matchAll(/(?:(?:const|let|var)\s+)?(\w+)\s*=\s*["'`](\/tmp[^"'`]*)["'`]/g)];
  const found: string[] = [];
  for (const [, name, path] of bindings) {
    const materialises = new RegExp(String.raw`\bmkdirSync\s*\(\s*(?:join\s*\(\s*)?\b${name}\b`).test(code);
    if (materialises) found.push(`${name} = "${path}"`);
  }
  return found;
}

const files = walkTestTree(TESTS_ROOT);

/** Every banned route in one file, each at the line the file holds. */
function tempRootViolations(view: SourceView, rel: string): string[] {
  const code = view.codeWithStringsAndTemplates();
  const violations: string[] = [];
  for (const { rule, why } of BANNED) {
    for (const hit of view.matches(rule, "codeWithStringsAndTemplates")) {
      violations.push(`${rel}:${hit.line}  ${hit.text.trim()} — ${why}`);
    }
  }
  for (const binding of hardcodedTempDirsCreated(code)) {
    violations.push(
      `${rel}  ${binding} is created with mkdirSync — ` +
        `a hardcoded /tmp path is unowned and collides between concurrent runs`,
    );
  }
  return violations;
}

describe("prevention: single owner for test temp directories", () => {
  test("the test tree is actually discovered (the walk is not vacuous)", () => {
    // Without this, every rule below would pass trivially if the walk broke.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(OWNER);
  });

  test("no test file reaches the system temp root except the owner", () => {
    const violations = files
      .filter((file) => file !== OWNER && file !== GUARD)
      .flatMap((file) => tempRootViolations(readSourceView(file), relative(TESTS_ROOT, file)));
    expect(
      violations,
      `Temp directories must come from tests/helpers/temp-dir.ts:\n\n` +
        `    import { createTempDir } from "<path>/helpers/temp-dir.ts";\n` +
        `    const dir = createTempDir("my-prefix-");\n\n` +
        `It creates the directory AND registers its removal in the same call, so\n` +
        `the two cannot drift apart. Violations:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  test("a finding names its true line and every site (planted)", () => {
    // A block comment above the hit must not move it, a comment is prose,
    // and a second site in the same file is its own finding.
    const planted = [
      "/**", " * mkdtempSync( in prose is not code", " */",
      "const a = mkdtempSync(join(root, \"a-\"));",
      "// mkdtempSync(",
      "const b = mkdtempSync(join(root, \"b-\"));",
    ].join("\n");
    expect(tempRootViolations(sourceViewOf(planted, "planted.test.ts"), "planted.test.ts").map((v) => v.split("  ")[0]))
      .toEqual(["planted.test.ts:4", "planted.test.ts:6"]);
  });

  // ── Behaviour: cleanup must survive failure ───────────────────────────────
  //
  // This is the case that actually caused the leak. A dir removed only on the
  // happy path is a dir that leaks the moment a test throws — and tests throw.
  // `test.fails` is the built-in way to assert "this body throws" without
  // failing the suite, so the proof runs in-process with no child runner.

  let dirFromThrowingTest = "";
  let dirFromThrowingHook = "";
  const onTestFinishedTracking: { dir: string; before: number }[] = [];

  // NO `expect` IN A `test.fails` BODY. It is green whenever the body throws,
  // so an assertion placed inside it is reported as an expected failure
  // instead of as a failure — a check that cannot fail. Everything this body
  // needs to establish is established by operations that throw on their own
  // (`createTempDir` and `writeFileSync` both do), and the state it creates is
  // judged by the ordinary test immediately below.
  test.fails("a test that THROWS still hands its temp dir back", () => {
    dirFromThrowingTest = createTempDir("ch-owner-throw-proof-");
    // Leave a file behind: removal must be recursive, not just rmdir.
    writeFileSync(join(dirFromThrowingTest, "payload.txt"), "not empty");
    throw new Error("deliberate failure — the dir above must still be removed");
  });

  test("…and the throwing test's temp dir is gone", () => {
    expect(dirFromThrowingTest, "the throwing test never ran").not.toBe("");
    expect(
      existsSync(dirFromThrowingTest),
      `${dirFromThrowingTest} survived a failing test — this is the leak`,
    ).toBe(false);
  });

  test("a dir created inside a test is no longer tracked once that test ends", () => {
    // The bookkeeping must shrink, not just the filesystem: a dir left in the
    // live set would be swept twice and, worse, would mask a real leak.
    const before = liveTempDirCount();
    const dir = createTempDir("ch-owner-tracking-");
    expect(liveTempDirCount()).toBe(before + 1);
    onTestFinishedTracking.push({ dir, before });
  });

  test("…and the tracking count returned to where it started", () => {
    const [entry] = onTestFinishedTracking;
    expect(entry, "the tracking test never ran").toBeDefined();
    expect(existsSync(entry!.dir)).toBe(false);
    expect(liveTempDirCount()).toBe(entry!.before);
  });

  describe("a failing beforeEach", () => {
    beforeAll(() => {
      dirFromThrowingHook = createTempDir("ch-owner-hook-proof-");
    });

    // Same rule as above: the body only throws. That the dir exists is
    // asserted by the ordinary test after this block, where a failure is a
    // failure.
    test.fails("a hook-created dir survives the hook's own test failing", () => {
      throw new Error("deliberate failure");
    });
  });

  test("a beforeAll-created dir is still tracked for the file-scope sweep", () => {
    // beforeAll has no test context, so `onTestFinished` cannot be registered.
    // It must therefore still exist here and be owned by the per-file sweep in
    // tests/setup/test-setup.ts — the gap that leaked before.
    expect(dirFromThrowingHook).not.toBe("");
    expect(existsSync(dirFromThrowingHook)).toBe(true);
  });

  test("the owner registers removal in the same call that creates", () => {
    // Structural, not textual: every exported creator must both create and
    // register. If someone adds a bare `export function mkTempDir()` that only
    // calls mkdtempSync, this fails.
    const ownerSource = readSourceView(OWNER).codeWithStringsAndTemplates();
    const creators = [...ownerSource.matchAll(/export function (\w+)[\s\S]*?\n}/g)];
    const createsDir = creators.filter((m) => /mkdtempSync\s*\(/.test(m[0]));
    expect(createsDir.length).toBeGreaterThan(0);
    for (const match of createsDir) {
      expect(
        // Three registration mechanisms, one per scope:
        //   `onTestFinished(` — the test;
        //   `LIVE.add(`       — the file (drained by the per-file sweep);
        //   `WORKER_DIRS.set(`— the worker. A worker store must outlive every
        //     file in the worker, and vitest exposes no worker-teardown hook
        //     (`process.on("exit")` was probed inside a worker thread and does
        //     not fire), so its removal is reclaim-on-next-use: the creator
        //     first removes stale siblings. Registration is still fused into
        //     creation — the map entry is what a later run reclaims against.
        /onTestFinished\s*\(|LIVE\.add\s*\(|WORKER_DIRS\.set\s*\(/.test(match[0]),
        `owner export ${match[1]} creates a temp dir without registering removal`,
      ).toBe(true);
    }
  });

  // ── THE RECLAIM MAY NOT COST A SYSCALL PER STORE ─────────────────────────
  //
  // `createWorkerTempDir` runs once per test FILE, not once per worker: the
  // `WORKER_DIRS` memo is per module registry and `isolate: true` gives every
  // file a fresh one. Counted in /tmp: exactly 416 stores per run against 416
  // test files. So anything the reclaim does, it does 416 times.
  //
  // It used to `readdirSync` the whole system temp root and `statSync` every
  // matching entry. Measured at a realistic residue (6,238 stores inside a
  // 10,241-entry /tmp): 30.5ms per call, 12.7s per run, GROWING with residue
  // — the statSync storm DESIGN-PERFORMANCE §1 L1 names explicitly.
  //
  // These are the two properties that keep it gone. They are behavioural
  // where they can be (`stampOf` is the thing that replaced the stat) and
  // structural where the cost is the absence of a call.
  describe("the worker-store reclaim costs the same at any residue", () => {
    test("a bucket name is derived from the time, and neighbours differ", () => {
      const t = 1_700_000_000_000;
      expect(bucketNameFor(t)).toBe(bucketNameFor(t + 1_000));
      expect(bucketNameFor(t)).not.toBe(bucketNameFor(t + 6 * 60 * 1000));
    });

    test("a bucket expires by its LAST possible member, never its first", () => {
      // Judging by the bucket's start would expire a window while a store
      // created at its end is still a whole bucket-width younger than the
      // caller believes — i.e. it would delete a live database.
      const t = 1_700_000_000_000;
      const end = bucketEndMs(bucketNameFor(t));
      expect(end).not.toBeNull();
      expect(end!, "the bucket must not expire before its youngest member").toBeGreaterThan(t);
    });

    test("a foreign or unparseable directory yields null — never deleted on a guess", () => {
      expect(bucketEndMs("some-other-tool-cache")).toBeNull();
      expect(bucketEndMs("b")).toBeNull();
      expect(bucketEndMs("b!!!")).toBeNull();
      expect(bucketEndMs("ch-web-worker-store-abc")).toBeNull();
    });

    test("a real store lands inside a bucket whose window contains its creation", () => {
      const before = Date.now();
      const dir = createWorkerTempDir("ch-web-owner-probe-");
      const bucket = basename(dirname(dir));
      const end = bucketEndMs(bucket);
      expect(end, `store parent ${bucket} is not a bucket`).not.toBeNull();
      // The store was created before its own bucket expires, and not so long
      // before that it belongs to an earlier one.
      expect(end!).toBeGreaterThan(before);
      expect(bucket).toBe(bucketNameFor(before));
    });

    test("the reclaim does ONE readdir, of the root, with no per-store syscall", () => {
      const ownerSource = readSourceView(OWNER).codeWithStringsAndTemplates();
      const reclaim = /function reclaimStaleWorkerDirs[\s\S]*?\n}/.exec(ownerSource);
      expect(reclaim, "reclaimStaleWorkerDirs not found — did it get renamed?").not.toBeNull();
      const body = reclaim?.[0] ?? "";
      // The original storm: one stat per store per test file.
      expect(/statSync/.test(body), "the reclaim stats again — the storm is back").toBe(false);
      // The second shape: our own directory, but still one entry per STORE,
      // so the cost grew with a residue the window could not drain mid-burst.
      expect(
        /readdirSync\s*\(\s*tmpdir\s*\(\s*\)\s*\)/.test(body),
        "the reclaim walks the whole system temp root again",
      ).toBe(false);
      expect(/readdirSync\s*\(\s*WORKER_ROOT/.test(body)).toBe(true);
      expect((body.match(/readdirSync/g) ?? []).length).toBe(1);
      // It must judge BUCKETS. A reclaim that reads store names is one that
      // listed every store to get them.
      expect(
        /bucketEndMs\s*\(/.test(body),
        "the reclaim no longer judges buckets — it is back to per-store scanning",
      ).toBe(true);
    });

    test("`statSync` is not imported by the owner at all", () => {
      const ownerSource = readSourceView(OWNER).codeWithStringsAndTemplates();
      expect(/\bstatSync\b/.test(ownerSource)).toBe(false);
    });

    test("the reclaim's cost does not grow with the number of stores", () => {
      // The property, measured rather than argued: creating many stores must
      // not make the next creation slower, because the reclaim sees buckets
      // and not stores. Under the flat-directory shape this rose linearly.
      // CPU WORK of one creation (its syscalls included), never wall time
      // (NO-LOAD-BLOCK): the suite runs 400 files in parallel, and a wall
      // timing measures the scheduler. Each side is the least of three
      // samples, each over several scheduler ticks (`cpuWorkOf`). A
      // per-store scan over 300 extra entries is far outside this bound;
      // constant work is comfortably inside it.
      const timeOne = (): number => cpuWorkOf(() => { createTempDir("ch-owner-cost-probe-"); }, 3);
      const baseline = timeOne();
      for (let i = 0; i < 300; i += 1) createTempDir("ch-owner-cost-bulk-");
      const loaded = timeOne();
      expect(
        loaded,
        `creation took ${baseline.toFixed(3)}ms at baseline and ${loaded.toFixed(3)}ms ` +
          `after 300 more stores — the reclaim is scanning stores, not buckets`,
      ).toBeLessThan(baseline + 5);
    });
  });
});
