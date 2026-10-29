// @vitest-environment node
/**
 * Prevention test — SPO: the raw standing-handle owners + the component
 * registry.
 *
 * THE INVARIANT (the harness anatomy): every STANDING handle the
 * web server process holds — a worker thread, a DB thread, a filesystem
 * watcher, a recurring timer, a spawned child process — must be VISIBLE in
 * the component registry, because the anatomy view the user directive asked
 * for ("every component of the harness, at any given point") reads that
 * registry. The forgetting-is-impossible shape is auto-registration AT THE
 * OWNER: the choke point that creates the handle registers it on its own
 * create/destroy path, so no call site can forget.
 *
 * This guard enforces the deny-by-default half MECHANICALLY, class-A style
 * (dynamic discovery, no hand list of allowed files):
 *
 *   A. every `.ts` file under server/ + engine/src that CALLS a raw
 *      standing-handle constructor (`new Worker(`, `setInterval(`,
 *      `spawn(`/`fork(`/`exec(`/`execFile(` from node:child_process,
 *      `watch(` from node:fs) must either
 *        (a) call `registerComponent(` — the registry-registering owner,
 *            derived by scanning, never hand-listed — or
 *        (b) appear in LEGACY_RAW_HANDLE_SITES below, each with its
 *            justification, and each still containing the pattern it is
 *            excused for (a stale exemption that matches nothing narrows
 *            the guard while reading as a stricter one).
 *
 *   B. the legacy list is COUNTED — the number is stated as a number so it
 *      cannot grow quietly, and every entry is argued for in place.
 *
 * SCOPE BOUNDARY, STATED: `setTimeout` is deliberately NOT a guarded
 * pattern. A one-shot timeout is bounded by construction and this codebase
 * uses it for debounces, retries and shutdown grace windows on every side;
 * there is no static rule that separates a "persistent" timeout from a
 * legitimate bounded one (the distinction lives in whether the site clears
 * or unrefs it, which its own tests own). The STANDING-handle classes —
 * intervals, watchers, workers, children — are structural and are guarded.
 *
 * The spawn/exec variants require the file to IMPORT that name from
 * node:child_process (and `watch(` from node:fs): a local helper that
 * happens to be named `exec(` (SQL execution) is not a child process and
 * must not be flagged, while a real child_process call cannot exist without
 * the import — the requirement removes false positives only, never
 * evasions.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { walkTs, stripCommentsAndStringsFor, read } from "../helpers/source-scan.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");
const ENGINE_SRC_DIR = join(REPO_ROOT, "engine/src");

/** One raw standing-handle pattern: what it means + how to detect it. */
type RawHandlePattern = Readonly<{
  /** The literal call the scan looks for (used in failure messages). */
  readonly what: string;
  /** Matches the comment/string-stripped source. */
  readonly matches: (code: string) => boolean;
  /** Whether the RAW source must import the name from its module for the
   * hit to count (kills local-helper false positives; a real call cannot
   * exist without the import). */
  readonly requiresImport: Readonly<{ from: string; name: string }> | null;
}>;

const PATTERNS: readonly RawHandlePattern[] = [
  {
    what: "new Worker(",
    matches: (code) => /\bnew Worker\(/.test(code),
    requiresImport: null,
  },
  {
    what: "setInterval(",
    matches: (code) => /\bsetInterval\(/.test(code),
    requiresImport: null,
  },
  {
    what: "spawn(",
    matches: (code) => /(?<![A-Za-z_.])spawn\(/.test(code),
    requiresImport: { from: "node:child_process", name: "spawn" },
  },
  {
    what: "fork(",
    matches: (code) => /(?<![A-Za-z_.])fork\(/.test(code),
    requiresImport: { from: "node:child_process", name: "fork" },
  },
  {
    what: "exec(",
    matches: (code) => /(?<![A-Za-z_.])exec\(/.test(code),
    requiresImport: { from: "node:child_process", name: "exec" },
  },
  {
    what: "execFile(",
    matches: (code) => /(?<![A-Za-z_.])execFile\(/.test(code),
    requiresImport: { from: "node:child_process", name: "execFile" },
  },
  {
    what: "watch(",
    matches: (code) => /(?<![A-Za-z_.])watch\(/.test(code),
    requiresImport: { from: "node:fs", name: "watch" },
  },
];

/** Does the RAW source import `name` from `from`? (import { x } / { x as y }
 * / import { type x } all count — the binding is what matters.) */
function importsName(rawSource: string, from: string, name: string): boolean {
  const importRe = new RegExp(
    `import\\s+(?:type\\s+)?\\{[^}]*\\b${name}\\b[^}]*\\}\\s+from\\s+["']${from}["']`,
  );
  return importRe.test(rawSource);
}

/**
 * The KNOWN-LEGACY raw-handle sites — each named individually, each with the
 * reason it neither can nor should route through the component registry.
 * A new entry must argue for itself here; an entry whose file no longer
 * matches its pattern is removed (arm B fails on a stale exemption).
 */
const LEGACY_RAW_HANDLE_SITES: ReadonlyArray<Readonly<{
  /** Path relative to the repository root, forward slashes. */
  readonly file: string;
  /** The pattern this site is excused for (must still be present there). */
  readonly what: string;
  /** The justification — why this site does not (or cannot) register. */
  readonly why: string;
}>> = [
  {
    file: modulePathMatching("process/supervised-run.ts"),
    what: "spawn(",
    why: "THE ONE PROCESS SUPERVISOR, in the engine CLI and the test runners only (the web server never loads it, and those processes have no component registry): the test-run mode spawns the native subreaper, whose receipt accounts for every process of the run and which kills them all when the run ends; the work-bounded mode (runCpuBounded: the history importer's pinned tools and the maintainer's `gh` in forge/maintainer-cli.ts, which spawns nothing of its own) spawns its command in a process group of its own, stopped as a group through the owned-process terminate when its CPU budget or stall bound is reached",
  },
  {
    file: modulePathMatching("process/supervised-run.ts"),
    what: "setInterval(",
    why: "the same supervisor's watch clocks — the test-run mode's stall clock and the work-bounded mode's CPU and stall poll — each cleared when its run settles (exit-backed), in an engine CLI or runner process the web server never is",
  },
  {
    file: modulePathMatching("db/client.ts"),
    what: "setInterval(",
    why: "the durability-window passive WAL checkpoint timer: unref'd, cleared in DbClient.close(), and its exact twin lives in engine/src/timeline (which cannot import the server registry) — registering one half of a mirrored pair would be an asymmetric half-truth, not more truth",
  },
  {
    file: modulePathMatching("routes/live.ts"),
    what: "setInterval(",
    why: "the standing liveness stream's heartbeat: the beat's lifecycle is the SSE CONNECTION's (closeAllSseStreams ends it at shutdown), unref'd — the connection itself is the component, not the beat timer",
  },
  {
    file: modulePathMatching("router/sse.ts"),
    what: "setInterval(",
    why: "the SSE keepalive beat: same connection-owned lifecycle as the liveness beat — it dies with the socket it keeps alive, and the socket's lifecycle is owned by the SSE stream registry (sse-connections), not by a timer",
  },
  {
    file: modulePathMatching("safety/landlock-runner.ts"),
    what: "spawn(",
    why: "the confined model-command boundary (execute_command): the child IS the model's command, its lifecycle is the command's own — it is not a harness component the registry could describe",
  },
  {
    file: modulePathMatching("timeline/timeline-store.ts"),
    what: "setInterval(",
    why: "the engine side of the durability-window checkpoint timer (the server/db/client.ts twin): engine cannot import the server registry — import direction is server→engine only",
  },
  {
    file: modulePathMatching("agents/orchestrator.ts"),
    what: "setInterval(",
    why: "the engine CLI runtime's alignment monitor: self-clears when no agents are running; runs in the CLI runtime process, not the web server the anatomy view describes",
  },
  {
    file: modulePathMatching("exposure/registrations/awareness.ts"),
    what: "setInterval(",
    why: "the engine registration surface's background monitor (engine side; import direction forbids the server registry), unref'd, re-armed only while the exposure registry says it should run",
  },
  {
    file: modulePathMatching("tools/built-in-tools.ts"),
    what: "spawn(",
    why: "execute_command's model-chosen command child: the child IS the command (the engine twin of landlock-runner's server-side boundary); its lifecycle is the command's own",
  },
  {
    file: modulePathMatching("process/bounded-run-sync.ts"),
    what: "new Worker(",
    why: "the one bounded run's synchronous bridge: one unreferenced worker per asking thread, started on first use and living as long as that thread, in engine code the server's registry cannot reach (import direction is server→engine only); it holds no work between runs",
  },
  {
    file: modulePathMatching("tools/concurrent/worker-pool.ts"),
    what: "new Worker(",
    why: "the ENGINE CLI runtime's tool-concurrency pool — the web server's executor path never crosses it (architecture-manifest is its only in-repo importer), and engine cannot import the server registry",
  },
  {
    file: modulePathMatching("intelligence/process-farm.ts"),
    what: "fork(",
    why: "THE farm owner: farm children are forked from worker-thread isolates, where a registry write would land in an isolate-local module the server's route can never read — the census owns their anatomy (the farm-child argv spec + their process chains); see component-registry.ts's header for the full statement",
  },
];

/** The registry-registering owners, DERIVED by scanning — never hand-listed.
 * A file that calls registerComponent is allowed to hold raw handles; a
 * file that stops calling it stops being allowed, automatically. */
function registeringOwners(files: readonly string[]): Set<string> {
  const owners = new Set<string>();
  for (const file of files) {
    const code = stripCommentsAndStringsFor(read(file), file);
    if (/\bregisterComponent\(/.test(code)) owners.add(file);
  }
  return owners;
}

/** Every raw-handle hit in server/ + engine/src (comment/string-stripped,
 * import-gated against local-helper false positives). */
function rawHandleHits(
  files: readonly string[],
): ReadonlyArray<Readonly<{ file: string; what: string }>> {
  const hits: Array<{ file: string; what: string }> = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const code = stripCommentsAndStringsFor(raw, file);
    for (const pattern of PATTERNS) {
      if (!pattern.matches(code)) continue;
      if (pattern.requiresImport !== null) {
        const { from, name } = pattern.requiresImport;
        if (!importsName(raw, from, name)) continue; // a local helper, not a child/fs call
      }
      hits.push({ file, what: pattern.what });
    }
  }
  return hits;
}

const serverFiles = walkTs(SERVER_DIR);
const engineFiles = walkTs(ENGINE_SRC_DIR);
const allFiles = [...serverFiles, ...engineFiles];

describe("A. source-scan — raw standing handles appear ONLY in registry-registering owners or argued legacy sites (dynamic discovery)", () => {
  test("every raw-handle site registers a component or carries a argued legacy exemption", () => {
    expect(serverFiles.length, "server/ should contain .ts files").toBeGreaterThan(0);
    expect(engineFiles.length, "engine/src should contain .ts files").toBeGreaterThan(0);
    const owners = registeringOwners(allFiles);
    expect(owners.size, "the registry-registering owners must exist (the derivation found none — the scan is broken, not the codebase)").toBeGreaterThan(0);
    const legacyKeys = new Set(LEGACY_RAW_HANDLE_SITES.map((s) => `${s.file}::${s.what}`));
    const violators: string[] = [];
    for (const hit of rawHandleHits(allFiles)) {
      const rel = relative(REPO_ROOT, hit.file);
      if (owners.has(hit.file)) continue;
      if (legacyKeys.has(`${rel}::${hit.what}`)) continue;
      violators.push(`${rel} — ${hit.what}`);
    }
    expect(
      violators,
      "raw standing handles must live in a registry-registering owner (call registerComponent at " +
        "the create/destroy path) or be argued in LEGACY_RAW_HANDLE_SITES — found: " +
        violators.join(", "),
    ).toEqual([]);
  });

  test("the derivation is real: every file this guard calls a registering owner really calls registerComponent", () => {
    for (const owner of registeringOwners(allFiles)) {
      const code = stripCommentsAndStringsFor(read(owner), owner);
      expect(
        /\bregisterComponent\(/.test(code),
        `${relative(REPO_ROOT, owner)} was derived as a registering owner but no longer calls registerComponent — the derivation and the reality have drifted`,
      ).toBe(true);
    }
  });

  test("at least one legacy site matches every pattern kind the list excuses (the list cannot quietly outlive its exemptions)", () => {
    // The exemption set is checked from BOTH sides: arm A fails when a
    // legacy site stops matching its pattern (stale narrowing), and this
    // arm fails when a pattern has legacy entries but none of them match —
    // the same both-sides discipline the worker-owner guard uses.
    for (const site of LEGACY_RAW_HANDLE_SITES) {
      const abs = join(REPO_ROOT, site.file);
      const raw = readFileSync(abs, "utf8");
      const code = stripCommentsAndStringsFor(raw, abs);
      const pattern = PATTERNS.find((p) => p.what === site.what)!;
      let matches = pattern.matches(code);
      if (matches && pattern.requiresImport !== null) {
        const { from, name } = pattern.requiresImport;
        matches = importsName(raw, from, name);
      }
      expect(
        matches,
        `${site.file} is excused for ${site.what} but no longer contains it — remove the stale exemption`,
      ).toBe(true);
    }
  });
});

describe("B. the legacy list is counted and argued — it cannot grow quietly", () => {
  test("the legacy list holds exactly the declared count", () => {
    expect(LEGACY_RAW_HANDLE_SITES.length, "a new legacy site must argue for itself HERE, in this count").toBe(13);
  });

  test("every legacy entry carries a real justification (not an empty apology)", () => {
    for (const site of LEGACY_RAW_HANDLE_SITES) {
      expect(site.why.length, `${site.file}'s justification must say WHY, in words`).toBeGreaterThan(40);
      expect(site.file.startsWith("server/") || site.file.startsWith("engine/src/"), `${site.file} must be under the guard's scan roots`).toBe(true);
    }
  });
});

describe("C. the registry module is the single registration door", () => {
  test("registerComponent is defined ONLY in server/observability/component-registry.ts among server/ + engine/src", () => {
    const definers: string[] = [];
    for (const file of allFiles) {
      const code = stripCommentsAndStringsFor(read(file), file);
      if (/export function registerComponent\b/.test(code)) {
        definers.push(relative(REPO_ROOT, file));
      }
    }
    expect(definers, "one registration door, one owner").toEqual([
      modulePathMatching("observability/component-registry.ts"),
    ]);
  });

  test("the farm-child boundary is documented at the registry owner, not just excused here", () => {
    // The farm is the one component kind that deliberately does NOT
    // register (worker-isolate boundary — see the registry header). The
    // statement must live at the OWNER, and this arm pins it there so the
    // exemption in this file can never outlive the reasoning it cites.
    const registrySrc = read(modulePathMatching("observability/component-registry.ts"));
    expect(registrySrc, "the registry owner must state WHY farm children are census-owned").toContain("WHY THE FARM CHILDREN ARE NOT HERE");
    expect(registrySrc).toContain("isolate-local registry");
  });
});
