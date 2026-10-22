// @vitest-environment node
/**
 * Project map lifecycle: start when a project is added, refresh after
 * an editor write, re-read by hand. One door (`kickRebuild` /
 * `beginIndexingIfConfigured` / `noteIndexedFilesChanged`). The folder
 * watch arms a refresh only for paths the scan would index.
 */
import { describe, test, expect, afterEach } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { modulePathMatching } from "../helpers/module-resolver.ts";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  writeFileRaw,
  installAfterProjectWrite,
  clearAfterProjectWrite,
} from "../../server/filesystem/editor-bridge.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { bodyCalls, callArgumentsOf, functionBody } from "../helpers/function-scope.ts";
import { stripCommentsOnly } from "../helpers/source-scan.ts";
import { ROOT_POLICY } from "../../server/kernel/canonical.ts";
import { STATE_DIRECTORY_NAME } from "../../engine/src/kernel/product-identity.ts";
import { isIndexableWatchFilename } from "../../server/intelligence/intelligence-bridge.ts";
import { getIndexWatchDebounceMs } from "../../server/kernel/harness-config.ts";

const REPO_ROOT = process.cwd();

function src(ref: string): string {
  // The callers pass product-module paths; resolve through the owner so a
  // move never touches this guard.
  return readFileSync(modulePathMatching(ref), "utf8");
}

describe("map index lifecycle — one door", () => {
  test("adding a project starts indexing through the intelligence owner", () => {
    const projects = src(modulePathMatching("server/routes/projects.ts"));
    expect(projects).toContain("beginIndexingIfConfigured");
    // The create and restore handlers each kick indexing — asked of the
    // handler's own call argument, so a kick in an unrelated later route
    // cannot satisfy the claim.
    const posts = callArgumentsOf(projects, "router.post");
    for (const [verb, label] of [["createProject(", "create"], ["restoreProject(", "restore"]] as const) {
      const handlers = posts.filter((args) => args.includes(verb));
      expect(handlers.length, `the ${label} route is present`).toBeGreaterThan(0);
      for (const handler of handlers) {
        expect(handler, `the ${label} route kicks indexing`).toContain("beginIndexingIfConfigured(");
      }
    }
  });

  test("boot installs the editor-write listener at the map owner", () => {
    expect(src(modulePathMatching("server/index.ts"))).toContain("installIndexRefreshFromEditorWrites");
    expect(src(modulePathMatching("server/intelligence/intelligence-bridge.ts"))).toContain(
      "installAfterProjectWrite(noteIndexedFilesChanged)",
    );
  });

  test("auto-index is the exposed config knob, not a second switch", () => {
    const bridge = src(modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    expect(bridge).toContain("getAutoIndexOnProjectAdd");
    expect(src(modulePathMatching("engine/src/shared/exposure/registrations/intelligence.ts"))).toContain(
      "intelligence.autoIndexOnProjectAdd",
    );
  });

  test("manual re-read is the served block action, shown on the run pane", () => {
    const block = src(modulePathMatching("server/blocks/intelligence.ts"));
    expect(block).toMatch(/reindex:\s*\{/);
    expect(block).toContain("Re-read the code");
    const pane = src(modulePathMatching("src/cockpit/flow/RunPane.svelte"));
    expect(pane).toContain("code.map/reindex");
    expect(pane).toContain('action("code.map", "reindex"');
  });

  test("a successful editor write notifies the installed listener with the changed path", () => {
    // (The write signal carries the FILE path — the hint the incremental
    // rebuild consumes so an internal write skips the tree stat walk for
    // the 99.9% of files it did not touch.)
    const dir = createTempDir("map-write-hook-");
    const seen: Array<[string, string | undefined]> = [];
    installAfterProjectWrite((root, changedPath) => {
      seen.push([root, changedPath]);
    });
    try {
      writeFileRaw(join(dir, "a.ts"), "export const a = 1;\n", dir);
      expect(seen).toEqual([[dir, "a.ts"]]);
    } finally {
      clearAfterProjectWrite();
    }
  });

  test("opening a project starts indexing through the same owner", () => {
    const projects = src(modulePathMatching("server/routes/projects.ts"));
    const getById = callArgumentsOf(projects, "router.get").filter((args) => args.includes('"/api/projects/:id"'));
    expect(getById.length, "the open-project route is present").toBeGreaterThan(0);
    for (const handler of getById) {
      expect(handler, "opening a project kicks indexing").toContain("beginIndexingIfConfigured(");
    }
    expect(src(modulePathMatching("src/client.ts"))).toContain("openSelectedProject");
    expect(src(modulePathMatching("src/client.ts"))).toContain("getProject(id)");
  });

  test("a finished map starts folder watch; census is not stored as memory", () => {
    const bridge = src(modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const ready = functionBody(bridge, "onMapReady");
    expect(bodyCalls(ready, "watchIndexedFolder"), "map-ready must still start the folder watch").toBe(true);
    expect(bodyCalls(ready, "rememberCodeIndex"), "map-ready must not dump the census into memory").toBe(false);
    // MAP-CENSUS-TC-1: a storeProvenance / memory-bridge write at this door
    // is the class, not only a deleted helper name.
    expect(bodyCalls(ready, "storeProvenance"), "map-ready must not write conversation memory").toBe(false);
    expect(ready.body.includes("storeProvenance"), "map-ready body must not name the memory store").toBe(false);
    expect(ready.body.includes("memory-bridge"), "map-ready must not import the memory store").toBe(false);
    expect(ready.body.includes("addLongTerm")).toBe(false);
    expect(bridge.includes("storeProvenance"), "intelligence owner must not write conversation memory").toBe(false);
    expect(bridge.includes("memory-bridge")).toBe(false);
    expect(bridge.includes("function rememberCodeIndex"), "the census memory store must be gone, not switched off").toBe(false);
    expect(bridge.includes("getRememberIndexInMemory")).toBe(false);
    expect(bridge.includes("bindIndexOwner")).toBe(false);
    expect(src(modulePathMatching("engine/src/shared/exposure/registrations/intelligence.ts"))).not.toContain(
      "intelligence.rememberIndexInMemory",
    );
    expect(src(modulePathMatching("engine/src/shared/exposure/registrations/intelligence.ts"))).not.toContain(
      "Keep a memory of each finished project map",
    );
    expect(src(modulePathMatching("engine/src/kernel/config-contracts.ts"))).not.toContain("rememberIndexInMemory");
    expect(src(modulePathMatching("engine/src/shared/exposure/registrations/intelligence.ts"))).toContain(
      "intelligence.watchIndexedProjects",
    );
    expect(src(modulePathMatching("engine/src/shared/exposure/registrations/intelligence.ts"))).toContain(
      "intelligence.indexWatchDebounceMs",
    );
    expect(
      src(modulePathMatching("server/kernel/harness-config.ts")).includes("getRememberIndexInMemory"),
      "the remember-index knob accessor must be gone with the store",
    ).toBe(false);
    const assemble = functionBody(src(modulePathMatching("server/context/context-bridge.ts")), "assembleSystemPrompt");
    expect(
      bodyCalls(assemble, "injectRepositoryMapIntoPrompt"),
      "this-turn census has one door: inject at prompt assembly",
    ).toBe(true);
  });

  test("beginIndexingIfConfigured does not force a rebuild of a warm cache", () => {
    const body = src(modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const kick = functionBody(body, "beginIndexingIfConfigured");
    expect(kick.body, "a warm cache is served, not rebuilt").toContain("mapCache.get(projectPath)");
    expect(kick.body).toContain("onMapReady(projectPath)");
  });

  test("the folder watch is created non-holding — persistent: false at the watch call", () => {
    // WATCHER-LEAK-1 (the static shape). Measured on linux/Node 24: a
    // RECURSIVE fs.watch creates internal FSEventWrap handles that the
    // public `watcher.unref()` does NOT reach, so a bounded script that
    // imported the bridge and finished one map stayed alive indefinitely on
    // the project watcher (a leaked coverage probe ran 15.5h past its 20s
    // deadline this way). The owner fix is `persistent: false` AT THE WATCH
    // CALL — the watcher is non-holding from creation for every internal
    // handle, which is the forgetting-is-impossible shape: no unref
    // discipline, no shutdown call a caller must remember. This static arm
    // pins the option at the single watch site; the behavioral arm below
    // proves the exit it buys.
    const bridge = src(modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    // Comments are stripped before the structural read so this arm matches
    // the CODE, never a doc comment that explains the rule (the mutation
    // proved a comment spelling the option satisfies a raw includes check).
    const body = functionBody(stripCommentsOnly(bridge), "watchIndexedFolder");
    expect(
      body.body.includes("persistent: false"),
      "the recursive folder watch must be created with persistent: false — " +
        "on linux, watcher.unref() does not reach the recursive watcher's internal handles, " +
        "and a bounded script importing this bridge would hang on it (the 15.5h probe leak)",
    ).toBe(true);
  });

  test("a bounded script that imports the bridge and finishes EXITS — the watch never holds the loop", async () => {
    // WATCHER-LEAK-2 (the behavioral proof). A REAL child process plays the
    // probe's role: import the bridge, build one map over a tiny project
    // (which starts the folder watch through onMapReady), settle, and then
    // do NOTHING. If any handle the module opened still holds the loop, the
    // child never exits. The race below is the arm's OWN hang detector — a
    // leaked child fails THIS arm with the leak named, never the runner's
    // global timeout — and the child is reaped on every path (graceful,
    // then SIGKILL after a bounded wait), so the arm cannot leak the very
    // process class it guards against.
    const bridgeAbs = join(REPO_ROOT, modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const project = createTempDir("ch-watch-exit-");
    writeFileSync(join(project, "one.ts"), "export const one = 1;\n");
    const script =
      `const bridge = await import(${JSON.stringify(pathToFileURL(bridgeAbs).href)});\n` +
      `const map = await bridge.getRepositoryMapAsync(${JSON.stringify(project)});\n` +
      `if (map.files.length < 1) throw new Error("map built nothing — the arm's premise failed");\n` +
      `await new Promise((r) => setImmediate(r));\n`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const reap = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const bound = setTimeout(() => r(), 2_000);
        bound.unref();
        child.on("exit", () => { clearTimeout(bound); r(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    try {
      const EXIT_BOUND_MS = 10_000;
      const outcome = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
        new Promise<"hang">((resolve) => {
          const detector = setTimeout(() => resolve("hang"), EXIT_BOUND_MS);
          detector.unref();
        }),
      ]);
      if (outcome === "hang") {
        await reap();
        expect(
          `child still running ${EXIT_BOUND_MS}ms after its work finished — the bridge holds the ` +
            `event loop open (the folder-watch leak class: recursive fs.watch handles that ` +
            `unref() cannot release). Child output so far: ${out}`,
        ).toBe("exited within the bound");
      }
      expect(outcome, `the bridge child failed instead of exiting cleanly: ${out}`).toBe(0);
    } finally {
      await reap();
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("map index lifecycle — the folder watch arms only on indexable paths", () => {
  test("an event under a scan-excluded directory does not arm a rebuild; an indexable event does; unknown arms", () => {
    // WATCH-FILTER-1 (the predicate, behaviorally). The measured defect:
    // a recursive fs.watch over the project root with no path filter, so
    // runtime data the scanner never indexes (the state directory's WAL
    // ticking 1-2x/s, .git writes, node_modules, coverage output) armed a
    // debounce → a map worker that re-walked the tree and concluded
    // "nothing changed" — ~2s of CPU per 15s at idle when the selected
    // project is the repo itself.
    expect(isIndexableWatchFilename(`${STATE_DIRECTORY_NAME}/timeline.db-wal`)).toBe(false);
    expect(isIndexableWatchFilename(".git/index")).toBe(false);
    expect(isIndexableWatchFilename("node_modules/y.js")).toBe(false);
    expect(isIndexableWatchFilename("coverage/out.json")).toBe(false);
    // nested — the scanner prunes these names wherever they appear, so the
    // watch filter must too, or a nested runtime dir re-arms the burn
    expect(isIndexableWatchFilename(`src/${STATE_DIRECTORY_NAME}/wal`)).toBe(false);
    expect(isIndexableWatchFilename("packages/app/node_modules/y.js")).toBe(false);
    // indexable paths keep the CURRENT behavior exactly: editor write →
    // debounce → rebuild
    expect(isIndexableWatchFilename(modulePathMatching("src/client.ts"))).toBe(true);
    expect(isIndexableWatchFilename("deep/nested/path/README.md")).toBe(true);
    // exact-segment matching, not substring: a similar name is not excluded
    expect(isIndexableWatchFilename("node_modules-extra/y.js")).toBe(true);
    expect(isIndexableWatchFilename("src/not-node_modules/a.ts")).toBe(true);
    // conservative: a filename the platform cannot report stays indexable
    expect(isIndexableWatchFilename(undefined)).toBe(true);
    expect(isIndexableWatchFilename(null)).toBe(true);
    expect(isIndexableWatchFilename("")).toBe(true);
  });

  test("the watch exclusion set is DERIVED from the scanner's owner, not restated", () => {
    // WATCH-FILTER-2 (derivation, behaviorally + structurally). The filter
    // answers "would the scan index this?" with the SAME list the scan
    // prunes with — every name the owner lists is filtered, at the root
    // and nested. If the bridge ever restated the list, a name added to
    // the owner fails here (and the structural arm below fails on removal).
    for (const name of ROOT_POLICY.configuration.repositoryScanExclusions) {
      expect(isIndexableWatchFilename(`${name}/x.ts`), `root-level ${name}`).toBe(false);
      expect(isIndexableWatchFilename(`src/${name}/x.ts`), `nested ${name}`).toBe(false);
    }
    const bridge = stripCommentsOnly(src(modulePathMatching("server/intelligence/intelligence-bridge.ts")));
    expect(bridge, "the set is built from the canonical owner").toContain(
      "ROOT_POLICY.configuration.repositoryScanExclusions",
    );
    // The guard runs inside the watch callback BEFORE the debounce timer is
    // armed — filtering after arming would still pay the rebuild.
    const body = functionBody(bridge, "watchIndexedFolder");
    expect(bodyCalls(body, "isIndexableWatchFilename"), "the watch callback filters through the predicate").toBe(true);
    expect(
      body.body.indexOf("isIndexableWatchFilename(") < body.body.indexOf("setTimeout("),
      "the filter runs BEFORE the debounce timer is armed",
    ).toBe(true);
    // The watch itself stays non-holding (WATCHER-LEAK-1's rule survives
    // this change).
    expect(body.body.includes("persistent: false")).toBe(true);
  });

  test("excluded-dir writes never rebuild; an indexable write does — through the REAL watcher", async () => {
    // WATCH-FILTER-3 (the live proof through real fs.watch + the real
    // debounce + the real worker). A child process plays the server's
    // role: build one map (which starts the folder watch through
    // onMapReady), then first PROVE the observation channel and the
    // pipeline are live by writing an indexable file and sighting the
    // in-flight repository-map worker (the pool's public
    // getInFlightWorker) plus the rebuilt map (file count grows). Only
    // then write inside scan-excluded directories — the exact classes
    // that burned idle CPU (state-dir WAL file, node_modules, coverage) —
    // and poll the whole quiet window: ZERO worker sightings means no
    // debounce armed, no worker spawned, nothing rebuilt. With the filter
    // removed (the mutation this arm exists to catch) the excluded writes
    // rebuild and the worker is sighted in the window.
    const bridgeAbs = join(REPO_ROOT, modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const poolAbs = join(REPO_ROOT, modulePathMatching("server/run/worker-pool.ts"));
    const debounceMs = getIndexWatchDebounceMs();
    const project = createTempDir("ch-watch-filter-");
    writeFileSync(join(project, "one.ts"), "export const one = 1;\n");
    const script = [
      "const fs = await import('node:fs');",
      "const path = await import('node:path');",
      `const bridgeUrl = ${JSON.stringify(pathToFileURL(bridgeAbs).href)};`,
      `const bridge = await import(bridgeUrl);`,
      `const pool = await import(${JSON.stringify(pathToFileURL(poolAbs).href)});`,
      `const project = ${JSON.stringify(project)};`,
      `const stateDir = ${JSON.stringify(STATE_DIRECTORY_NAME)};`,
      `const workerUrl = new URL('./repository-map-worker.ts', bridgeUrl);`,
      "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
      "const inFlight = () => pool.getInFlightWorker(workerUrl, project) !== undefined;",
      "const first = await bridge.getRepositoryMapAsync(project);",
      // Phase 1 — an indexable write MUST rebuild: sight the in-flight
      // worker (proves the channel) AND the grown map (proves the
      // rebuild) before phase 2's zero means anything.
      "fs.writeFileSync(path.join(project, 'two.ts'), 'export const two = 2;\\n');",
      "let sawWorker = false;",
      "let second = null;",
      "const liveDeadline = Date.now() + 15_000;",
      "while (Date.now() < liveDeadline && !(sawWorker && second !== null)) {",
      "  if (inFlight()) sawWorker = true;",
      "  const m = await bridge.getRepositoryMapAsync(project);",
      "  if (m.files.length === 2 && second === null) second = m;",
      "  await sleep(100);",
      "}",
      "if (!(sawWorker && second !== null)) {",
      "  console.log('__RESULT__' + JSON.stringify({ stage: 'indexable-write-rebuild', ok: false, sawWorker, secondFiles: second === null ? null : second.files.length, firstFiles: first.files.length }));",
      "} else {",
      // Phase 2 — excluded-dir writes must NOT rebuild. Poll the pool's
      // in-flight map for the whole quiet window (past the debounce plus
      // a rebuild's travel time): a single sighting is the defect.
      "  fs.mkdirSync(path.join(project, 'node_modules'), { recursive: true });",
      "  fs.writeFileSync(path.join(project, 'node_modules', 'dep.ts'), 'export const dep = 1;\\n');",
      `  fs.mkdirSync(path.join(project, stateDir), { recursive: true });`,
      `  fs.writeFileSync(path.join(project, stateDir, 'timeline.db-wal'), 'wal-bytes\\n');`,
      "  fs.mkdirSync(path.join(project, 'coverage'), { recursive: true });",
      "  fs.writeFileSync(path.join(project, 'coverage', 'out.json'), '{}\\n');",
      `  const quietEnd = Date.now() + ${JSON.stringify(debounceMs + 2500)};`,
      "  let excludedSightings = 0;",
      "  while (Date.now() < quietEnd) {",
      "    if (inFlight()) excludedSightings++;",
      "    await sleep(100);",
      "  }",
      "  const third = await bridge.getRepositoryMapAsync(project);",
      "  console.log('__RESULT__' + JSON.stringify({",
      "    stage: 'excluded-writes-no-rebuild',",
      "    ok: true,",
      "    firstFiles: first.files.length,",
      "    secondFiles: second.files.length,",
      "    sawWorker,",
      "    excludedSightings,",
      "    thirdFiles: third.files.length,",
      "  }));",
      "}",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const reap = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const bound = setTimeout(() => r(), 2_000);
        bound.unref();
        child.on("exit", () => { clearTimeout(bound); r(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    try {
      const EXIT_BOUND_MS = 45_000;
      const outcome = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
        new Promise<"hang">((resolve) => {
          const detector = setTimeout(() => resolve("hang"), EXIT_BOUND_MS);
          detector.unref();
        }),
      ]);
      if (outcome === "hang") {
        await reap();
        expect(`child still running ${EXIT_BOUND_MS}ms in — the filter arm cannot leak its own child. Output: ${out}`).toBe(
          "exited within the bound",
        );
      }
      expect(outcome, `the filter-arm child failed instead of exiting cleanly: ${out}`).toBe(0);
      const marker = out.lastIndexOf("__RESULT__");
      expect(marker, `the child reported no result. Output: ${out}`).toBeGreaterThan(-1);
      const report = JSON.parse(out.slice(marker + "__RESULT__".length).trim()) as {
        stage: string;
        ok: boolean;
        firstFiles?: number;
        secondFiles?: number | null;
        sawWorker?: boolean;
        excludedSightings?: number;
        thirdFiles?: number;
      };
      if (report.stage === "indexable-write-rebuild") {
        // The pipeline-liveness premise failed — name it, so a config
        // change (watch off, debounce huge) or a filter that also drops
        // indexable paths reads as its own failure, not as "excluded
        // writes rebuilt".
        expect(
          `the indexable write did not rebuild the map (sawWorker: ${report.sawWorker}, files: ` +
            `${report.secondFiles} of ${report.firstFiles}) — the watch pipeline is not live in this ` +
            `child, so the zero-sighting claim below would be vacuous`,
        ).toBe("the indexable write rebuilt the map");
      }
      expect(report.firstFiles, "the first map indexed the seed file").toBe(1);
      expect(report.secondFiles, "the indexable write rebuilt the map (pipeline live)").toBe(2);
      expect(report.sawWorker, "the in-flight worker was sighted for the indexable write (channel live)").toBe(true);
      expect(report.thirdFiles, "excluded writes did not change the map").toBe(2);
      expect(
        report.excludedSightings,
        `excluded-directory writes spawned ${report.excludedSightings} map worker pass(es) — the ` +
          `folder watch is arming rebuilds for paths the scan never indexes`,
      ).toBe(0);
    } finally {
      await reap();
      rmSync(project, { recursive: true, force: true });
    }
  });
});

afterEach(() => {
  clearAfterProjectWrite();
});

describe("map index lifecycle — the smart trigger (the hinted, stat-diffed rebuild)", () => {
  // The rebuild chain under test: watcher debounce / editor-write hint /
  // TTL refresh → worker → STAT WALK FIRST (cheap: readdir+lstat, zero
  // reads) → diff against the last successful scan's stat snapshot →
  // only the dirty files are read + parsed; an empty diff posts
  // "unchanged" and the cached map object is kept (no swap, no cache
  // write). Editor writes carry the changed path as a HINT so the
  // internal-write rebuild skips even the stat walk for unaffected
  // files.

  test("an editor write rebuilds through the path hint — the real worker, the real write chain", async () => {
    const bridgeAbs = join(REPO_ROOT, modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const editorAbs = join(REPO_ROOT, modulePathMatching("server/filesystem/editor-bridge.ts"));
    const project = createTempDir("ch-hint-write-");
    writeFileSync(join(project, "one.ts"), "export const one = 1;\n");
    const script = [
      "const fs = await import('node:fs');",
      "const path = await import('node:path');",
      `const bridge = await import(${JSON.stringify(pathToFileURL(bridgeAbs).href)});`,
      `const editor = await import(${JSON.stringify(pathToFileURL(editorAbs).href)});`,
      `const project = ${JSON.stringify(project)};`,
      // Wire the production chain exactly as boot does: editor write →
      // listener → noteIndexedFilesChanged(project, changedPath).
      "editor.installAfterProjectWrite(bridge.noteIndexedFilesChanged);",
      "const first = await bridge.getRepositoryMapAsync(project);",
      "if (first.files.length !== 1) throw new Error('first build did not index the seed file');",
      // INTERNAL write through the editor bridge — carries the path hint.
      "editor.writeFileRaw(path.join(project, 'two.ts'), 'export const two = 2;\\n', project);",
      "const deadline = Date.now() + 15_000;",
      "let second = null;",
      "while (Date.now() < deadline && second === null) {",
      "  const m = await bridge.getRepositoryMapAsync(project);",
      "  if (m.files.length === 2) second = m;",
      "  else await new Promise((r) => setTimeout(r, 100));",
      "}",
      "console.log('__RESULT__' + JSON.stringify({ ok: second !== null, firstFiles: first.files.length, secondFiles: second === null ? null : second.files.length, hasTwo: second === null ? false : second.modules.some((m) => m.path === 'two.ts') }));",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const reap = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const bound = setTimeout(() => r(), 2_000);
        bound.unref();
        child.on("exit", () => { clearTimeout(bound); r(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    try {
      const EXIT_BOUND_MS = 45_000;
      const outcome = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
        new Promise<"hang">((resolve) => {
          const detector = setTimeout(() => resolve("hang"), EXIT_BOUND_MS);
          detector.unref();
        }),
      ]);
      if (outcome === "hang") {
        await reap();
        expect(`child still running ${EXIT_BOUND_MS}ms in — the hint arm cannot leak its own child. Output: ${out}`).toBe(
          "exited within the bound",
        );
      }
      expect(outcome, `the hint-arm child failed instead of exiting cleanly: ${out}`).toBe(0);
      const marker = out.lastIndexOf("__RESULT__");
      expect(marker, `the child reported no result. Output: ${out}`).toBeGreaterThan(-1);
      const report = JSON.parse(out.slice(marker + "__RESULT__".length).trim()) as {
        ok: boolean; firstFiles: number; secondFiles: number | null; hasTwo: boolean;
      };
      expect(report.ok, `the hinted editor write did not rebuild the map. Output: ${out}`).toBe(true);
      expect(report.firstFiles).toBe(1);
      expect(report.secondFiles).toBe(2);
      expect(report.hasTwo, "the rebuilt map contains the written file").toBe(true);
    } finally {
      await reap();
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("the hinted rebuild's WORKER INPUT carries the changed path — observed at the pool seam", async () => {
    // SMART-TRIGGER-HINT (the forwarding proof). The arm above proves a
    // hinted editor write rebuilds to the correct map — but the full
    // stat walk delivers that same end-to-end correctness, so a bridge
    // that DROPS the forwarding (collects no hints, sends the worker
    // nothing) ships green there. This arm observes the hinted fast
    // path at the bridge/worker BOUNDARY instead: before the child
    // imports the bridge, a module-load seam (node:module registerHooks)
    // wraps `runWorkerTask` inside the pool — the single owner that
    // hands `workerData` to every worker — and records each
    // repository-map worker input's summary. The rebuild a hinted
    // editor write triggers must arrive CARRYING the hint
    // (`changedPaths` includes the written file) on top of the warm
    // `previousCache` — the O(hints) fast-path shape. With forwarding
    // dropped the rebuild still happens and the map still ends correct,
    // but no worker input ever carries the hint and this arm reds. The
    // seam lives entirely in the child (no production logging); it
    // throws if the pool's runWorkerTask signature moves, and every
    // skip path records nothing — the arm fails closed.
    const bridgeAbs = join(REPO_ROOT, modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const editorAbs = join(REPO_ROOT, modulePathMatching("server/filesystem/editor-bridge.ts"));
    const project = createTempDir("ch-hint-boundary-");
    writeFileSync(join(project, "one.ts"), "export const one = 1;\n");
    const script = [
      "const fs = await import('node:fs');",
      "const path = await import('node:path');",
      // The seam FIRST — it must be registered before the bridge (and
      // its transitive pool import) loads.
      "const { registerHooks } = await import('node:module');",
      "const originalSeenInputs = globalThis.__seenMapWorkerInputs;",
      "globalThis.__seenMapWorkerInputs = [];",
      "registerHooks({",
      "  load(url, context, nextLoad) {",
      "    const result = nextLoad(url, context);",
      `    if (!url.endsWith(${JSON.stringify("/server/run/worker-pool.ts")})) return result;`,
      "    const raw = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');",
      `    const marker = ${JSON.stringify("export async function runWorkerTask<TOk>(opts: RunWorkerTaskOptions<TOk>): Promise<TOk> {")};`,
      "    if (!raw.includes(marker)) throw new Error('pool seam: the runWorkerTask signature moved — update the seam marker');",
      "    let src = raw.replace(marker, 'async function __origRunWorkerTask<TOk>(opts: RunWorkerTaskOptions<TOk>): Promise<TOk> {');",
      "    src += '\\nexport function runWorkerTask<TOk>(opts: RunWorkerTaskOptions<TOk>): Promise<TOk> {'",
      "      + '\\n  if (opts.label === \"repository-map\") {'",
      "      + '\\n    const w = opts.workerData;'",
      "      + '\\n    (globalThis.__seenMapWorkerInputs ??= []).push({'",
      "      + '\\n      projectPath: typeof (w && w.projectPath) === \"string\" ? w.projectPath : null,'",
      "      + '\\n      changedPaths: w && Array.isArray(w.changedPaths) ? w.changedPaths.slice() : undefined,'",
      "      + '\\n      hasPreviousCache: !!(w && w.previousCache !== undefined && w.previousCache !== null),'",
      "      + '\\n    });'",
      "      + '\\n  }'",
      "      + '\\n  return __origRunWorkerTask<TOk>(opts);'",
      "      + '\\n}';",
      "    return { ...result, source: src };",
      "  },",
      "});",
      `const bridge = await import(${JSON.stringify(pathToFileURL(bridgeAbs).href)});`,
      `const editor = await import(${JSON.stringify(pathToFileURL(editorAbs).href)});`,
      `const project = ${JSON.stringify(project)};`,
      // Wire the production chain exactly as boot does: editor write →
      // listener → noteIndexedFilesChanged(project, changedPath).
      "editor.installAfterProjectWrite(bridge.noteIndexedFilesChanged);",
      "const first = await bridge.getRepositoryMapAsync(project);",
      "if (first.files.length !== 1) throw new Error('first build did not index the seed file');",
      // INTERNAL write through the editor bridge — carries the path hint.
      "editor.writeFileRaw(path.join(project, 'two.ts'), 'export const two = 2;\\n', project);",
      "const deadline = Date.now() + 15_000;",
      "let second = null;",
      "while (Date.now() < deadline && second === null) {",
      "  const m = await bridge.getRepositoryMapAsync(project);",
      "  if (m.files.length === 2) second = m;",
      "  else await new Promise((r) => setTimeout(r, 100));",
      "}",
      "const inputs = (globalThis.__seenMapWorkerInputs ?? []).filter((i) => i.projectPath === project);",
      "globalThis.__seenMapWorkerInputs = originalSeenInputs;",
      "console.log('__RESULT__' + JSON.stringify({",
      "  rebuilt: second !== null,",
      "  hasTwo: second !== null && second.modules.some((m) => m.path === 'two.ts'),",
      "  inputs: inputs.map((i) => ({ changedPaths: i.changedPaths, hasPreviousCache: i.hasPreviousCache })),",
      "}));",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const reap = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const bound = setTimeout(() => r(), 2_000);
        bound.unref();
        child.on("exit", () => { clearTimeout(bound); r(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    try {
      const EXIT_BOUND_MS = 45_000;
      const outcome = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
        new Promise<"hang">((resolve) => {
          const detector = setTimeout(() => resolve("hang"), EXIT_BOUND_MS);
          detector.unref();
        }),
      ]);
      if (outcome === "hang") {
        await reap();
        expect(`child still running ${EXIT_BOUND_MS}ms in — the boundary arm cannot leak its own child. Output: ${out}`).toBe(
          "exited within the bound",
        );
      }
      expect(outcome, `the boundary-arm child failed instead of exiting cleanly: ${out}`).toBe(0);
      const marker = out.lastIndexOf("__RESULT__");
      expect(marker, `the child reported no result. Output: ${out}`).toBeGreaterThan(-1);
      const report = JSON.parse(out.slice(marker + "__RESULT__".length).trim()) as {
        rebuilt: boolean; hasTwo: boolean;
        inputs: Array<{ changedPaths?: string[]; hasPreviousCache: boolean }>;
      };
      expect(report.rebuilt, `the hinted editor write did not rebuild the map. Output: ${out}`).toBe(true);
      expect(report.hasTwo, "the rebuilt map contains the written file").toBe(true);
      const hinted = report.inputs.filter(
        (i) => Array.isArray(i.changedPaths) && i.changedPaths.includes("two.ts"),
      );
      expect(
        hinted.length,
        `no repository-map worker input carried the editor write's path hint ('two.ts') — the ` +
          `bridge dropped the hint forwarding and the rebuild fell back to the full stat walk. ` +
          `Recorded inputs: ${JSON.stringify(report.inputs)}`,
      ).toBeGreaterThan(0);
      expect(
        hinted.every((i) => i.hasPreviousCache),
        "the hinted rebuild must ride the warm previousCache (the O(hints) fast-path shape)",
      ).toBe(true);
    } finally {
      await reap();
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("a no-change TTL refresh keeps the SAME map object WITHOUT spawning a worker (the empty-diff gate on the main thread), then a real change swaps it through the worker", async () => {
    // SMART-TRIGGER-1, updated to the no-change TTL refresh's new owner:
    // the stat walk + diff runs ON THE MAIN THREAD (measured ~18ms on this
    // repository's tree vs ~1.25s of one-shot worker CPU — boot +
    // tree-sitter init + the previousCache clone — for the same verdict),
    // so a read past the TTL with a warm cache and an unchanged tree must
    // keep the cached map OBJECT (identity, not just equality — the
    // no-swap proof) while refreshing the TTL, and must NOT spawn a worker.
    // A subsequent real external write produces a NEW map object THROUGH
    // the worker (the changed-file rebuild keeps the worker).
    const bridgeAbs = join(REPO_ROOT, modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const poolAbs = join(REPO_ROOT, modulePathMatching("server/run/worker-pool.ts"));
    const configDir = createTempDir("ch-ttl-cfg-");
    writeFileSync(join(configDir, "harness.json"), `${JSON.stringify({ codeIntelligence: { mapCacheTtlMs: 250 } })}\n`);
    const project = createTempDir("ch-ttl-refresh-");
    writeFileSync(join(project, "one.ts"), "export const one = 1;\n");
    const script = [
      "const fs = await import('node:fs');",
      "const path = await import('node:path');",
      `const bridge = await import(${JSON.stringify(pathToFileURL(bridgeAbs).href)});`,
      `const pool = await import(${JSON.stringify(pathToFileURL(poolAbs).href)});`,
      `const project = ${JSON.stringify(project)};`,
      `const bridgeUrl = ${JSON.stringify(pathToFileURL(bridgeAbs).href)};`,
      "const workerUrl = new URL('./repository-map-worker.ts', bridgeUrl);",
      "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
      "const first = await bridge.getRepositoryMapAsync(project);",
      "if (first.files.length !== 1) throw new Error('first build did not index the seed file');",
      // Let the 250ms TTL expire, then read: the no-change verdict runs on
      // the MAIN THREAD (stat walk → diff → unchanged → TTL refresh), so no
      // worker may ever be in flight for it.
      "await sleep(600);",
      "let settled = false;",
      "const read = bridge.getRepositoryMapAsync(project).then((m) => { settled = true; return m; });",
      "let sawWorker = false;",
      "const sightDeadline = Date.now() + 10_000;",
      "while (Date.now() < sightDeadline && !settled) {",
      "  if (pool.getInFlightWorker(workerUrl, project) !== undefined) sawWorker = true;",
      "  await sleep(5);",
      "}",
      "const second = await read;",
      // The real change must go through the worker: the changed-file rebuild
      // keeps the worker (the walk found a non-empty diff and handed off).
      "let sawWorkerOnChange = false;",
      // A real external write must still swap in a new map: the gate
      // only no-ops when NOTHING changed.
      "fs.writeFileSync(path.join(project, 'added.ts'), 'export const added = 1;\\n');",
      "const swapDeadline = Date.now() + 15_000;",
      "let third = null;",
      // A concurrent watcher: the read that triggers the changed-file
      // rebuild AWAITS the worker, so a between-reads poll can never see
      // the in-flight window — observe it from a timer instead.
      "const swapWatcher = setInterval(() => {",
      "  if (pool.getInFlightWorker(workerUrl, project) !== undefined) sawWorkerOnChange = true;",
      "}, 5);",
      "try {",
      "  while (Date.now() < swapDeadline && third === null) {",
      "    const m = await bridge.getRepositoryMapAsync(project);",
      "    if (m.files.length === 2) third = m;",
      "    else await sleep(100);",
      "  }",
      "} finally { clearInterval(swapWatcher); }",
      "console.log('__RESULT__' + JSON.stringify({",
      "  sameObject: second === first,",
      "  sawWorker,",
      "  sawWorkerOnChange,",
      "  thirdIsNew: third !== null && third !== first && third !== second,",
      "  firstFiles: first.files.length,",
      "  thirdFiles: third === null ? null : third.files.length,",
      "}));",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HARNESS_CONFIG_PATH: join(configDir, "harness.json") },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const reap = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const bound = setTimeout(() => r(), 2_000);
        bound.unref();
        child.on("exit", () => { clearTimeout(bound); r(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    try {
      const EXIT_BOUND_MS = 45_000;
      const outcome = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
        new Promise<"hang">((resolve) => {
          const detector = setTimeout(() => resolve("hang"), EXIT_BOUND_MS);
          detector.unref();
        }),
      ]);
      if (outcome === "hang") {
        await reap();
        expect(`child still running ${EXIT_BOUND_MS}ms in — the TTL arm cannot leak its own child. Output: ${out}`).toBe(
          "exited within the bound",
        );
      }
      expect(outcome, `the TTL-arm child failed instead of exiting cleanly: ${out}`).toBe(0);
      const marker = out.lastIndexOf("__RESULT__");
      expect(marker, `the child reported no result. Output: ${out}`).toBeGreaterThan(-1);
      const report = JSON.parse(out.slice(marker + "__RESULT__".length).trim()) as {
        sameObject: boolean; sawWorker: boolean; sawWorkerOnChange: boolean;
        thirdIsNew: boolean; firstFiles: number; thirdFiles: number | null;
      };
      expect(
        report.sameObject,
        "a no-change TTL refresh must keep the cached map OBJECT (no map swap) — the empty-diff gate",
      ).toBe(true);
      expect(
        report.sawWorker,
        "a no-change TTL refresh must NOT spawn a worker — the stat walk runs on the main thread; " +
          "a worker sighting here means the ~1.25s one-shot-worker refresh is back on the no-change path",
      ).toBe(false);
      expect(
        report.sawWorkerOnChange,
        "the changed-file rebuild must still go through the worker (only the no-change verdict moved)",
      ).toBe(true);
      expect(report.thirdIsNew, "a real change must swap in a new map object").toBe(true);
      expect(report.firstFiles).toBe(1);
      expect(report.thirdFiles).toBe(2);
    } finally {
      await reap();
      rmSync(project, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("a previous scan BIGGER than the main-thread door takes the WORKER path — the request thread never stat-walks a huge tree", async () => {
    // THE SIZE DOOR. The no-change TTL refresh's stat walk is O(tree)
    // syscalls paid on the request thread; the door bound
    // (intelligence.mainThreadStatWalkMaxEntries, default 20,000) is
    // consulted PRE-walk against the previous scan's own size —
    // `previousCache.stats.size` — which is known without walking
    // anything. Above it the refresh declines the main-thread verdict up
    // front and the worker owns the window; at or below
    // it the walk runs on the main thread as measured.
    //
    // The arm plays a huge previous scan WITHOUT building one: a
    // module-load seam exposes the bridge's incremental cache (one
    // import-time export appended in the child only), a fake cache with
    // stats.size = doorBound + 1 is installed for a real 1-file project,
    // and a second seam counts MAIN-THREAD scanRepositoryStats calls
    // (worker threads load their own unpatched copy, so the counter sees
    // only request-thread walks). With the door: zero main-thread walks
    // and a sighted worker. With the door check REMOVED (the mutation
    // this arm exists to catch): the huge tree is stat-walked on the
    // request thread — the counter goes ≥ 1 and the arm reds.
    const bridgeAbs = join(REPO_ROOT, modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const scanAbs = join(REPO_ROOT, modulePathMatching("engine/src/intelligence/repository-stat-scan.ts"));
    const configAbs = join(REPO_ROOT, modulePathMatching("engine/src/intelligence/intelligence-config.ts"));
    const poolAbs = join(REPO_ROOT, modulePathMatching("server/run/worker-pool.ts"));
    const configDir = createTempDir("ch-door-cfg-");
    writeFileSync(join(configDir, "harness.json"), `${JSON.stringify({ codeIntelligence: { mapCacheTtlMs: 250 } })}\n`);
    const project = createTempDir("ch-door-");
    writeFileSync(join(project, "one.ts"), "export const one = 1;\n");
    const script = [
      "const path = await import('node:path');",
      "const { registerHooks } = await import('node:module');",
      `const bridgeUrl = ${JSON.stringify(pathToFileURL(bridgeAbs).href)};`,
      `const scanUrl = ${JSON.stringify(pathToFileURL(scanAbs).href)};`,
      `const configUrl = ${JSON.stringify(pathToFileURL(configAbs).href)};`,
      // The seams FIRST — they must be registered before the bridge (and
      // its transitive engine imports) loads.
      "registerHooks({",
      "  load(url, context, nextLoad) {",
      "    const result = nextLoad(url, context);",
      "    if (url === scanUrl) {",
      "      const raw = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');",
      `      const marker = ${JSON.stringify("export function scanRepositoryStats(")};`,
      "      if (!raw.includes(marker)) throw new Error('door arm seam: scanRepositoryStats moved — update the marker');",
      "      let src = raw.replace(marker, 'function __origScanRepositoryStats(');",
      "      src += '\\nexport function scanRepositoryStats(rootPath: string, limits?: Readonly<Partial<RepositoryReadLimits>>): RepositoryWalkResult {';",
      "      src += '\\n  globalThis.__mainThreadStatWalks = (globalThis.__mainThreadStatWalks ?? 0) + 1;';",
      "      src += '\\n  return __origScanRepositoryStats(rootPath, limits);';",
      "      src += '\\n}';",
      "      return { ...result, source: src };",
      "    }",
      "    if (url === bridgeUrl) {",
      "      const raw = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');",
      `      const marker = ${JSON.stringify("const mapIndexIncremental = new Map")};`,
      "      if (!raw.includes(marker)) throw new Error('door arm seam: the incremental cache declaration moved — update the marker');",
      "      return { ...result, source: raw + '\\nexport { mapIndexIncremental };' };",
      "    }",
      "    return result;",
      "  },",
      "});",
      `const bridge = await import(bridgeUrl);`,
      `const scan = await import(scanUrl);`,
      `const intelligenceConfig = await import(configUrl);`,
      `const pool = await import(${JSON.stringify(pathToFileURL(poolAbs).href)});`,
      `const project = ${JSON.stringify(project)};`,
      "const workerUrl = new URL('./repository-map-worker.ts', bridgeUrl);",
      "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));",
      "const originalMainThreadStatWalks = globalThis.__mainThreadStatWalks;",
      "const first = await bridge.getRepositoryMapAsync(project);",
      "if (first.files.length !== 1) throw new Error('first build did not index the seed file');",
      // THE FAKE HUGE PREVIOUS SCAN: doorBound + 1 stat entries, the real
      // default config shape (so isRepositoryMapCacheReusable admits it).
      "const doorBound = intelligenceConfig.resolveIntelligenceConfig().mainThreadStatWalkMaxEntries;",
      "const stats = new Map();",
      "for (let i = 0; i < doorBound + 1; i++) stats.set('__fake__/mod' + i + '.ts', { mtimeMs: 0, sizeBytes: 0 });",
      "const configKey = scan.repositoryConfigKey(scan.resolveRepositoryReadLimits(), intelligenceConfig.resolveIntelligenceConfig().maxFileBytes);",
      "bridge.mapIndexIncremental.set(project, { entries: new Map(), stats, configKey });",
      // Let the 250ms TTL expire, then read: the door must decline the
      // main-thread verdict BEFORE any walk and hand the window to the
      // worker.
      "await sleep(600);",
      "let settled = false;",
      "const read = bridge.getRepositoryMapAsync(project).then((m) => { settled = true; return m; });",
      "let sawWorker = false;",
      "const sightDeadline = Date.now() + 15_000;",
      "while (Date.now() < sightDeadline && !settled) {",
      "  if (pool.getInFlightWorker(workerUrl, project) !== undefined) sawWorker = true;",
      "  await sleep(5);",
      "}",
      "const second = await read;",
      "const mainThreadWalks = globalThis.__mainThreadStatWalks ?? 0;",
      "globalThis.__mainThreadStatWalks = originalMainThreadStatWalks;",
      "console.log('__RESULT__' + JSON.stringify({",
      "  mainThreadWalks,",
      "  sawWorker,",
      "  files: second.files.length,",
      "  doorBound,",
      "  fakeStats: stats.size,",
      "}));",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HARNESS_CONFIG_PATH: join(configDir, "harness.json") },
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const reap = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const bound = setTimeout(() => r(), 2_000);
        bound.unref();
        child.on("exit", () => { clearTimeout(bound); r(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    try {
      const EXIT_BOUND_MS = 45_000;
      const outcome = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
        new Promise<"hang">((resolve) => {
          const detector = setTimeout(() => resolve("hang"), EXIT_BOUND_MS);
          detector.unref();
        }),
      ]);
      if (outcome === "hang") {
        await reap();
        expect(`child still running ${EXIT_BOUND_MS}ms in — the door arm cannot leak its own child. Output: ${out}`).toBe(
          "exited within the bound",
        );
      }
      expect(outcome, `the door-arm child failed instead of exiting cleanly: ${out}`).toBe(0);
      const marker = out.lastIndexOf("__RESULT__");
      expect(marker, `the child reported no result. Output: ${out}`).toBeGreaterThan(-1);
      const report = JSON.parse(out.slice(marker + "__RESULT__".length).trim()) as {
        mainThreadWalks: number; sawWorker: boolean; files: number; doorBound: number; fakeStats: number;
      };
      expect(report.fakeStats, "the fake previous scan must be bigger than the door bound (the arm's premise)").toBe(
        report.doorBound + 1,
      );
      expect(
        report.mainThreadWalks,
        "a previous scan bigger than the door bound was stat-walked on the REQUEST THREAD " +
          `(${report.mainThreadWalks} main-thread walk(s)) — the size door must decline the main-thread ` +
          `verdict pre-walk and route the window to the worker`,
      ).toBe(0);
      expect(
        report.sawWorker,
        "the big-tree verdict must go to the repository-map worker",
      ).toBe(true);
      expect(report.files, "the worker rebuild still serves the real tree's map").toBe(1);
    } finally {
      await reap();
      rmSync(project, { recursive: true, force: true });
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test("an external same-bytes touch (mtime-only change) rebuilds to a byte-identical map", async () => {
    // SMART-TRIGGER-2 (precision). A touch that changes nothing but the
    // mtime still arms the watcher → the worker stat-walks, finds the
    // file dirty (mtime moved), re-reads it, reuses the cached extraction
    // by content hash (zero parses), and rebuilds a map whose content is
    // IDENTICAL to before — the gate must never corrupt or drift the
    // map through a spurious trigger.
    const bridgeAbs = join(REPO_ROOT, modulePathMatching("server/intelligence/intelligence-bridge.ts"));
    const project = createTempDir("ch-touch-");
    const seed = "export const one = 1;\nexport function oneFn() { return 1; }\n";
    writeFileSync(join(project, "one.ts"), seed);
    const script = [
      "const fs = await import('node:fs');",
      "const path = await import('node:path');",
      `const bridge = await import(${JSON.stringify(pathToFileURL(bridgeAbs).href)});`,
      `const project = ${JSON.stringify(project)};`,
      `const seed = ${JSON.stringify(seed)};`,
      "const first = await bridge.getRepositoryMapAsync(project);",
      "if (first.files.length !== 1) throw new Error('first build did not index the seed file');",
      // EXTERNAL write with the SAME bytes: mtime moves, content does not.
      "fs.writeFileSync(path.join(project, 'one.ts'), seed);",
      "const deadline = Date.now() + 15_000;",
      "let second = null;",
      "let sawMapHash = null;",
      "while (Date.now() < deadline && second === null) {",
      "  const m = await bridge.getRepositoryMapAsync(project);",
      "  sawMapHash = m.mapHash;",
      "  if (m !== first) second = m;",
      "  else await new Promise((r) => setTimeout(r, 100));",
      "}",
      "console.log('__RESULT__' + JSON.stringify({",
      "  rebuilt: second !== null,",
      "  sameMapHash: second !== null && second.mapHash === first.mapHash,",
      "  sameFiles: second !== null && second.files.length === first.files.length,",
      "  sameSymbols: second !== null && second.totalSymbols === first.totalSymbols,",
      "}));",
    ].join("\n");
    const child = spawn(process.execPath, ["--experimental-strip-types", "-e", script], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
    const reap = async (): Promise<void> => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => {
        const bound = setTimeout(() => r(), 2_000);
        bound.unref();
        child.on("exit", () => { clearTimeout(bound); r(); });
      });
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    try {
      const EXIT_BOUND_MS = 45_000;
      const outcome = await Promise.race([
        new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code))),
        new Promise<"hang">((resolve) => {
          const detector = setTimeout(() => resolve("hang"), EXIT_BOUND_MS);
          detector.unref();
        }),
      ]);
      if (outcome === "hang") {
        await reap();
        expect(`child still running ${EXIT_BOUND_MS}ms in. Output: ${out}`).toBe("exited within the bound");
      }
      expect(outcome, `the touch-arm child failed instead of exiting cleanly: ${out}`).toBe(0);
      const marker = out.lastIndexOf("__RESULT__");
      expect(marker, `the child reported no result. Output: ${out}`).toBeGreaterThan(-1);
      const report = JSON.parse(out.slice(marker + "__RESULT__".length).trim()) as {
        rebuilt: boolean; sameMapHash: boolean; sameFiles: boolean; sameSymbols: boolean;
      };
      expect(report.rebuilt, "the mtime-only touch rebuilt the map (the trigger fired; the stat gate saw the new mtime)").toBe(true);
      expect(report.sameMapHash, "a same-bytes touch rebuilds to a byte-identical mapHash").toBe(true);
      expect(report.sameFiles).toBe(true);
      expect(report.sameSymbols).toBe(true);
    } finally {
      await reap();
      rmSync(project, { recursive: true, force: true });
    }
  });
});
