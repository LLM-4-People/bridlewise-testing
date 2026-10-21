// @vitest-environment node
/**
 * TEST-ISOLATION OWNER — the mechanical guard on the suite's isolation contract.
 *
 * ── What this file exists to make impossible ─────────────────────────────
 *
 * The node project runs a single worker with `isolate: true` (a fresh module
 * registry per file, but the same `process.env` and `globalThis` for the
 * worker's lifetime); the dom project shares one registry per worker
 * (`isolate: false`). Three defect classes come out of that sharing, and all
 * three were live in this suite. Each was invisible in
 * the file that caused it and surfaced somewhere else, which is why they were
 * diagnosed as "flakes" for so long:
 *
 *   A. FIRE-AND-FORGET HOISTED SETUP. `vi.hoisted(async () => {…})` written
 *      WITHOUT `await`. Vitest hoists the call above the imports but does not
 *      await it (its own hoist transform names only two supported shapes:
 *      `await vi.hoisted(async () => {})` and `vi.hoisted(() => {})`). The
 *      factory's `await import(…)` yields, the module body races ahead, and
 *      whether `process.env.HARNESS_*` is set before the file reads it depends
 *      on how much of the module graph the worker already had cached — i.e.
 *      on which files ran first. Eight files were written this way. Measured
 *      directly with a probe: the same file, same order, read `undefined` on
 *      one run and the temp path on the next, and `lint-gate.test.ts` failed
 *      13–20 tests exactly when the probe read `undefined`.
 *
 *      Worse than a flake: when the env never lands, the file falls back to
 *      the REAL project root and the REAL data stores, which is how test runs
 *      came to write into the developer's own ledger.
 *
 *   B. LEAKED GLOBALS. A file that replaces `globalThis.fetch` (or stubs it
 *      via `vi.stubGlobal`) and does not put it back hands the stub to every
 *      later file in the worker. The failures land in the victim, reading as
 *      `Failed to parse URL from /api/run/start` — the real undici `fetch`
 *      refusing a relative URL — in a file whose own stub "should" be
 *      installed. Enforcement lives in `tests/setup/test-setup.ts`
 *      (restore) and is reported here (fail).
 *
 *   C. THE LIVE LEDGER. `serverConfig.timelineDbPath` / `dbPath` default to
 *      `.bridlewise/*.db` under `process.cwd()`. Nothing pointed them
 *      anywhere else, so ledger-touching tests appended to the running dev
 *      ledger — hundreds of rows per suite run. Redirection is by construction
 *      in the setup owner; this file proves the redirection is in force and
 *      that nobody has re-pointed it at the repo.
 *
 *   D. THE NETWORK. The server read the repository's own settings document,
 *      and a test driving a run dialed the remote MCP servers it lists. The
 *      outbound door refuses any destination that is not this machine in a
 *      process under test (`outbound_network_under_test`), whatever the
 *      settings list. (The document is NOT relocated for this: the harness
 *      root — the guardian binary, the protected trees — is derived from the
 *      document's directory, and a relocated copy turned confinement off for
 *      every spawn.)
 *
 * ── Mutation-verified ────────────────────────────────────────────────────
 * Dropping the `await` from any `vi.hoisted(async …)` fails A.
 * A file that replaces ANY own property of `globalThis` without restoring it
 *   fails its OWN file at teardown (the setup calls the throwing door), and
 *   the planted-arm test below drives exactly that door — under `isolate:
 *   true`, where the old cross-file ledger read was always empty. A REAL
 *   fixture, written to a temp dir and run through the suite's own setup,
 *   proves the module-scope dot and bracket shapes now fail too.
 * Moving `captureGlobals()` out of the setup module's scope (back into a
 *   `beforeAll`) fails the wiring test: the baseline would be taken after the
 *   test file's module body, which is exactly where the leak hides.
 * Removing the `HARNESS_WEB_TIMELINE_DB_PATH` redirection from the setup
 *   owner fails C (the resolved path returns to the repo's `.bridlewise/`).
 * Each was run and observed to fail; see the report accompanying this change.
 */
import { describe, test, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { readSourceView } from "../../engine/scripts/verification/source-view.ts";
import { request as httpRequest } from "node:http";
import { connect as netConnect, Socket } from "node:net";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { outboundFetch } from "../../engine/src/shared/outbound-http.ts";
import { assertGlobalsRestored, captureGlobals } from "../helpers/global-boundary.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const TESTS_ROOT = resolve(import.meta.dirname, "..");
const REPO_ROOT = resolve(TESTS_ROOT, "..");

// The system temp root, obtained THROUGH the temp-dir owner rather than by
// calling `os.tmpdir()` here — `tests/prevention/temp-dir-owner.test.ts` bans
// every other file from reaching the temp root directly, and that ban is
// right: one door in, one door out.
const TEMP_ROOT = resolve(dirname(createTempDir("ch-isolation-probe-")));

/** Every `*.test.ts` under `tests/`, with its source. */
function testFiles(): { path: string; rel: string; source: string }[] {
  const out: { path: string; rel: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".test.ts")) continue;
      out.push({
        path: full,
        rel: relative(REPO_ROOT, full),
        // Quoted strings stay: a bracket write's key IS a string literal, so a
        // view that blanks strings would go blind to that spelling. Comments and
        // prose are blanked, so a comment naming a pattern cannot convict.
        source: readSourceView(full).codeWithStrings(),
      });
    }
  };
  walk(TESTS_ROOT);
  return out;
}

const FILES = testFiles();

describe("A. hoisted setup is awaited (no fire-and-forget env writes)", () => {
  test("the suite is large enough for this scan to mean something", () => {
    expect(FILES.length).toBeGreaterThan(300);
  });

  test("every async vi.hoisted factory is awaited", () => {
    // `vi.hoisted(async …)` unawaited is hoisted as a bare statement: the
    // factory starts, yields on its first `await`, and the module body races
    // past it. Anything the factory writes to `process.env` may or may not be
    // visible to the file's own module scope — and to the product modules the
    // file imports, which read config at module-evaluation time.
    const offenders: string[] = [];
    for (const { rel, source } of FILES) {
      // Comments are blanked first: this file's own header names the banned
      // pattern, and a declaration quoted in prose is not a declaration.
      const lines = sourceViewOf(source, rel).codeWithStringsAndTemplates().split("\n");
      lines.forEach((line, i) => {
        if (!/\bvi\.hoisted\s*\(\s*async\b/.test(line)) return;
        // Accept `await vi.hoisted(async …)` and the destructuring form
        // `const x = await vi.hoisted(async …)`.
        if (/\bawait\s+vi\.hoisted\s*\(\s*async\b/.test(line)) return;
        offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      "async vi.hoisted factories must be awaited — an unawaited one races the " +
        "file's own imports, and the loser is decided by what the worker had cached",
    ).toEqual([]);
  });
});

/**
 * Every write to an own property of `globalThis` that has no restore in the
 * same file. The view blanks comments, quoted-string interiors and template
 * interiors, so prose and source-as-data cannot convict a file; bracket keys
 * are recovered from the strings-intact view at the same offset (every view
 * preserves the source's offsets).
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * `globalThis` as a write target, including a parenthesised type cast:
 * `globalThis`, `(globalThis as any)` and `(globalThis as unknown as {x})`.
 */
const GLOBAL_ACCESS = String.raw`\(?\s*globalThis\s*(?:!\s*)?(?:\s+as\s+[^)\]\n]+)?\s*\)?\s*`;

function globalWriteOffenders(source: string, rel: string): string[] {
  const view = sourceViewOf(source, rel);
  const assigned = new Set<string>();
  const computed: string[] = [];
  for (const match of view.matches(
    // `(globalThis as any)["fetch"] = …` is the same write as the dot form;
    // allow the parenthesised cast between the object and the accessor.
    new RegExp(GLOBAL_ACCESS + String.raw`(?:\.\s*([A-Za-z_$][\w$]*)|\[([^\]]*?)\]\s*)\s*=(?!=)`, "gu"),
    "code",
  )) {
    const dot = match.match[1];
    if (dot !== undefined) {
      assigned.add(dot);
      continue;
    }
    const inner = match.match[2] ?? "";
    const bracketStart = match.index + match.text.indexOf("[") + 1;
    const rawKey = view.codeWithStringsAndTemplates().slice(bracketStart, bracketStart + inner.length).trim();
    const literal = /^(["'`])([A-Za-z_$][\w$]*)\1$/u.exec(rawKey)?.[2];
    if (literal !== undefined) assigned.add(literal);
    else computed.push(`${rel}:${match.line}`);
  }
  // `Object.defineProperty(globalThis, "window", …)` installs a global too.
  for (const match of view.matches(
    new RegExp(
      String.raw`Object\.defineProperty\s*\(\s*` + GLOBAL_ACCESS +
        String.raw`\s*,\s*["']([A-Za-z_$][\w$]*)["']`,
      "gu",
    ),
    "codeWithStrings",
  )) {
    assigned.add(match.match[1]!);
  }
  for (const match of view.matches(/vi\.stubGlobal\s*\(\s*["']([A-Za-z_$][\w$]*)["']/gu, "codeWithStrings")) {
    assigned.add(match.match[1]!);
  }
  const restoresAll = /vi\.unstubAllGlobals\s*\(/u.test(view.code());
  const quoteClass = "([\"'`])";
  const offenders: string[] = [];
  for (const name of [...assigned].sort()) {
    // A restore is an assignment of a captured original back to the global,
    // through either access spelling and either cast form; deleting the
    // property is the restore for a global this file did not inherit.
    const access = "(?:\\.\\s*" + escapeRegExp(name) + "|\\[\\s*" + quoteClass +
      "\\s*" + escapeRegExp(name) + "\\1\\s*\\])";
    const restore = new RegExp(
      GLOBAL_ACCESS + access + "\\s*=\\s*(?:original|real|pristine|saved|prev)\\w*",
      "iu",
    );
    const removed = new RegExp("delete\\s+" + GLOBAL_ACCESS + access, "u");
    if (
      !restoresAll &&
      view.matches(restore, "codeWithStrings").length === 0 &&
      view.matches(removed, "code").length === 0
    ) {
      offenders.push(`${rel}: ${name}`);
    }
  }
  if (!restoresAll) offenders.push(...computed);
  return offenders;
}

describe("B. no test file leaks a global to the next file", () => {
  test("the per-file door FAILS a planted leak the old cross-file guard could not observe", () => {
    // ── The defect this arm exists for ──
    // The old guard read a worker-scoped ledger from a DIFFERENT test file.
    // Under the node project's `isolate: true` every file gets a fresh module
    // registry, so that read was always empty: the guard could not fail, and
    // a file that leaked was never blamed. The victim of a leak cannot name
    // it either — its `captureGlobals()` records the leaked stub as its own
    // pristine entry.
    //
    // So the leak is planted HERE, the way the old guard could not see it,
    // and the door the setup file calls is asked to fail this file.
    const name = "fetch";
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    try {
      captureGlobals();
      Object.defineProperty(globalThis, name, {
        value: () => { throw new Error("planted global leak"); },
        writable: true,
        configurable: true,
        enumerable: true,
      });
      // The observation point the old guard used — a later file's read — is
      // a fresh registry and has nothing to report. There is no "so far"
      // ledger anymore, which is the point: the file itself must be failed.
      expect(() => assertGlobalsRestored("planted-leak.test.ts")).toThrow(
        /planted-leak\.test\.ts changed fetch on globalThis/u,
      );
      // The door repaired what it found before failing, so the worker is not
      // poisoned by the arm itself. A DESCRIPTOR compare, not a value compare:
      // the fix reports a changed writable/enumerable/configurable triple too.
      expect(Object.getOwnPropertyDescriptor(globalThis, name)).toEqual(original);
    } finally {
      if (original === undefined) delete (globalThis as unknown as Record<string, unknown>)[name];
      else Object.defineProperty(globalThis, name, original);
    }
  });

  test("a REAL module-scope leak fixture fails its own file at teardown", () => {
    // The runtime door is only real if the suite's own setup reaches it. Two
    // fixture files are written outside the checkout and run through
    // `tests/setup/test-setup.ts`: one leaks at MODULE scope with a dot
    // assignment (which the old `beforeAll` snapshot recorded as pristine),
    // the other through a BRACKET assignment (invisible to the old static
    // scan). Both must be blamed by name at their own teardown.
    const dir = createTempDir("ch-isolation-leak-fixture-");
    const fixtures = [
      {
        name: "module-scope.fixture.ts",
        source:
          `const realFetch = globalThis.fetch;\n` +
          `globalThis.fetch = (() => { throw new Error("module-scope dot leak"); }) as typeof fetch;\n` +
          `test("leaks at module scope", () => { expect(globalThis.fetch).not.toBe(realFetch); });\n`,
      },
      {
        name: "bracket-scope.fixture.ts",
        source:
          `const realFetch = globalThis.fetch;\n` +
          `(globalThis as any)["fetch"] = (() => { throw new Error("module-scope bracket leak"); }) as typeof fetch;\n` +
          `test("leaks through a bracket write", () => { expect(globalThis.fetch).not.toBe(realFetch); });\n`,
      },
    ];
    for (const fixture of fixtures) writeFileSync(join(dir, fixture.name), fixture.source);
    const config = join(dir, "vitest.config.mjs");
    writeFileSync(config, `export default ${JSON.stringify({
      root: REPO_ROOT,
      test: {
        environment: "node",
        globals: true,
        pool: "forks",
        isolate: true,
        setupFiles: [join(TESTS_ROOT, "setup", "test-setup.ts")],
        include: fixtures.map((fixture) => join(dir, fixture.name)),
        passWithNoTests: false,
      },
    })};\n`);
    const child = spawnSync(
      process.execPath,
      [join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--config", config],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 180_000 },
    );
    const output = `${child.stdout ?? ""}\n${child.stderr ?? ""}`;
    expect(child.error, output).toBeUndefined();
    expect(child.status, output).not.toBe(0);
    for (const fixture of fixtures) {
      expect(output, `${fixture.name} must be blamed by name`).toMatch(
        new RegExp(`${fixture.name.replaceAll(".", "\\.")} changed fetch on globalThis and did not restore`, "u"),
      );
    }
  });

  test("the suite's REAL configuration snapshots at module scope and calls the throwing door at teardown", () => {
    // An arm that proves the helper can throw is not enough: the setup file
    // the node project actually runs must take the snapshot BEFORE the test
    // file is imported, and call the door after the cleanup that must still
    // run. This is the wiring half of the same guarantee.
    const setup = readSourceView(join(TESTS_ROOT, "setup", "test-setup.ts")).code();
    expect(setup).toMatch(/^captureGlobals\(\);$/mu);
    const captureIndex = setup.indexOf("\ncaptureGlobals();");
    const hookIndex = setup.indexOf("beforeAll(() => {");
    expect(captureIndex, "the snapshot must run at setup module scope").toBeGreaterThan(-1);
    expect(captureIndex).toBeLessThan(hookIndex);
    expect(setup).toMatch(/assertGlobalsRestored\(expect\.getState\(\)\.testPath/u);
    // ...and it is the LAST statement of the afterAll hook, so a thrown leak
    // does not skip the temp-dir/env/schema repairs above it.
    const hookStart = setup.lastIndexOf("afterAll(() => {");
    expect(hookStart, "the setup file must own an afterAll hook").toBeGreaterThan(-1);
    const hook = setup.slice(hookStart);
    expect(hook.trimEnd().endsWith("});")).toBe(true);
    expect(hook.lastIndexOf("assertGlobalsRestored")).toBeGreaterThan(hook.lastIndexOf("sweepTempDirs"));
    expect(hook.lastIndexOf("assertGlobalsRestored")).toBeGreaterThan(hook.lastIndexOf("resetServerConfig"));
  });

  test("the static scan recognises bracket and computed writes, not just dot assignments", () => {
    // The old pattern was `globalThis\.(\w+)\s*=`, so a bracket write passed
    // silently. These plants drive the replacement and prove it is not
    // vacuous; the restore and `vi.stubGlobal` controls prove it does not
    // convict the sanctioned shapes.
    expect(globalWriteOffenders("globalThis.fetch = fake;", "planted.test.ts")).toEqual([
      "planted.test.ts: fetch",
    ]);
    expect(globalWriteOffenders('(globalThis as any)["fetch"] = fake;', "planted.test.ts")).toEqual([
      "planted.test.ts: fetch",
    ]);
    expect(
      globalWriteOffenders('const key = "fetch";\n(globalThis as any)[key] = fake;', "planted.test.ts"),
    ).toEqual(["planted.test.ts:2"]);
    expect(
      globalWriteOffenders(
        '(globalThis as any)["fetch"] = fake;\nglobalThis.fetch = realFetch;',
        "planted.test.ts",
      ),
    ).toEqual([]);
    expect(
      globalWriteOffenders(
        '(globalThis as any)["fetch"] = fake;\nglobalThis["fetch"] = originalFetch;',
        "planted.test.ts",
      ),
    ).toEqual([]);
    expect(
      globalWriteOffenders('vi.stubGlobal("fetch", fake);\nvi.unstubAllGlobals();', "planted.test.ts"),
    ).toEqual([]);
    // Source-as-data is not a write: the quoted interior is blanked by the view.
    expect(
      globalWriteOffenders("const sample = 'globalThis[\"fetch\"] = fake';", "planted.test.ts"),
    ).toEqual([]);
  });

  test("a file that replaces a global captures and restores it in the same file", () => {
    // Static half: a file that writes a global — dot, bracket or computed —
    // must also contain a restoring assignment. This catches the shape the
    // runtime check cannot: a leak in a file that happens to run last in its
    // worker.
    const offenders = FILES.flatMap(({ rel, source }) => globalWriteOffenders(source, rel));
    expect(
      offenders,
      "a test file replaces a global with no restore in the same file — under " +
        "`isolate: false` the stub outlives the file and poisons the next one",
    ).toEqual([]);
  });

  test("the sanctioned vi.stubGlobal / unstubAllGlobals pair is not reported as a leak", () => {
    // The fix must not fail the shape fourteen cockpit files use. The setup
    // calls unstubAllGlobals before its descriptor compare, so the exact
    // entry descriptor must be back in place.
    const original = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    vi.stubGlobal("fetch", vi.fn());
    vi.unstubAllGlobals();
    expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")).toEqual(original);
  });
});

describe("C. tests never open the live ledger", () => {
  test("the timeline ledger resolves outside the repository", () => {
    const dbPath = resolve(serverConfig.timelineDbPath);
    expect(
      dbPath.startsWith(TEMP_ROOT),
      `timeline ledger must be a throwaway store, got ${dbPath}`,
    ).toBe(true);
    expect(isRepoPath(dbPath), `test runs must not write ${dbPath}`).toBe(false);
  });

  test("the web database resolves outside the repository", () => {
    const dbPath = resolve(serverConfig.dbPath);
    expect(dbPath.startsWith(TEMP_ROOT), `web db must be a throwaway store, got ${dbPath}`).toBe(
      true,
    );
    expect(isRepoPath(dbPath), `test runs must not write ${dbPath}`).toBe(false);
  });

  test("no test file re-points a data store back into the repository", () => {
    const offenders: string[] = [];
    for (const { rel, source } of FILES) {
      for (const m of source.matchAll(
        /HARNESS_WEB_(?:TIMELINE_)?DB_PATH\s*=\s*([`"'])([^`"']*)\1/g,
      )) {
        const literal = m[2]!;
        // Only a literal path can be judged statically; template values that
        // interpolate a temp dir are the intended shape and read as safe.
        if (literal.includes(".bridlewise") || literal.startsWith("./")) {
          offenders.push(`${rel}: ${literal}`);
        }
      }
    }
    expect(offenders, "a test pointed a data store at the repository's own store").toEqual([]);
  });
});

describe("D. tests never dial a remote host", () => {
  // step6-readiness-2 F-14: a test driving a run booted the repository's real
  // settings document and dialed the MCP servers it lists (mcp.deepwiki.com),
  // unnoticed until the network was down.
  test("the outbound door refuses a remote destination in a test process, before any socket exists", async () => {
    // A public literal passes every other rule (no resolver, public), so the
    // refusal it meets is the under-test one.
    await expect(outboundFetch({
      url: "https://93.184.216.34/", method: "GET", signal: AbortSignal.timeout(5_000),
      protocolHeaders: {}, logCategory: "llm", allowPrivateAddress: false,
    })).rejects.toMatchObject({ code: "outbound_network_under_test" });
  });

  test("a RAW client in a test process is refused at the socket: the platform's fetch, http.request and net.connect, by address and by name", async () => {
    // wf-del2-correctness NEW-5: a raw `fetch("https://example.com")` from a
    // test process answered 200 — the door only refuses what is sent through
    // it. The worker running this file is guarded by the setup file (tests/setup/test-setup.ts →
    // engine/scripts/tooling/network-under-test.ts).
    const refused = (error: unknown): string | undefined => (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    await expect(fetch("http://93.184.216.34/", { signal: AbortSignal.timeout(5_000) }).catch((error: unknown) => refused(error))).resolves.toBe("outbound_network_under_test");
    // A resolver that answers a public address for any name (no DNS needed).
    const publicAnswer = ((_host: string, options: { all?: boolean }, callback: (...answer: unknown[]) => void) => {
      if (options.all === true) callback(null, [{ address: "93.184.216.34", family: 4 }]);
      else callback(null, "93.184.216.34", 4);
    }) as never;
    const byName = await new Promise<string | undefined>((resolveCode) => {
      const request = httpRequest({ host: "remote.example", port: 80, lookup: publicAnswer });
      request.once("error", (error: NodeJS.ErrnoException) => resolveCode(error.code));
      request.end();
    });
    expect(byName).toBe("outbound_network_under_test");
    const raw = await new Promise<string | undefined>((resolveCode) => {
      const socket = netConnect({ host: "93.184.216.34", port: 443 });
      socket.once("error", (error: NodeJS.ErrnoException) => resolveCode(error.code));
      socket.once("connect", () => { socket.destroy(); resolveCode("connected"); });
    });
    expect(raw).toBe("outbound_network_under_test");
    expect((Socket.prototype.connect as unknown as Record<symbol, unknown>)[Symbol.for("bridlewise.networkUnderTest.installed")], "this worker's sockets are not guarded").toBe(true);
  });
});

function isRepoPath(p: string): boolean {
  const rel = relative(REPO_ROOT, p);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}
