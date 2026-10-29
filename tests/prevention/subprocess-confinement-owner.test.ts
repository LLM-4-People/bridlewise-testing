// @vitest-environment node
/**
 * SUBPROCESS CONFINEMENT — the model's commands are held inside the project,
 * or they do not run.
 *
 * ── WHAT IS BEING DEFENDED ────────────────────────────────────────────────
 *
 * `execute_command` hands a model-chosen program the SERVER's filesystem
 * authority. Landlock takes that authority away for the life of the child:
 * read and write the selected project, read-and-execute the system paths in
 * the root policy's floor, nothing else. The decision is made once, at
 * `spawnAsyncSafe` in `server/tool-executor.ts` — the only place in this
 * server where a model-directed process is created.
 *
 * ── THE THREE WAYS THIS DIES, AND THE THREE DEFENCES ──────────────────────
 *
 * 1. THE DECISION IS MADE AND IGNORED. The classic wired-but-inert shape:
 *    `prepareConfinedSpawn` is called, its answer discarded, and the raw
 *    command spawned. Every structural check still passes — the import is
 *    there, the call is there. So the behavioural tests here never assert
 *    that a decision was COMPUTED; they assert on what only a CONSUMED
 *    decision can produce: a child that cannot read a file outside the
 *    project, and a `confinement` field in the tool result that names the
 *    authority the child actually had.
 *
 * 2. THE REFUSAL BECOMES A WARNING. Confinement is asked for, the guardian
 *    is missing, and the command runs anyway with a note attached. That is
 *    the failure mode the experiment this was ported from actually had: it
 *    emitted a typed `landlock_unavailable` event and then streamed the
 *    unprotected result underneath it. So the refusal is tested as a
 *    REFUSAL: no process, `ran: false`, and a code.
 *
 * 3. A SECOND SPAWN APPEARS. Someone adds another `spawn` for a
 *    model-directed program somewhere else in `server/`, and it is
 *    unconfined by construction. The structural half below counts every
 *    subprocess creation in the server, states that count as a runtime
 *    number, asserts a floor on it, and plants a violation — because a count
 *    proves the scanner is awake and only a plant proves it still disagrees
 *    with a bypass.
 *
 * ── WHY THIS SUITE ADAPTS TO THE HOST INSTEAD OF SKIPPING ─────────────────
 *
 * Landlock is a Linux feature and this suite must be meaningful without it.
 * A skip would be the quiet death of the guard, so instead the host is
 * MEASURED and the assertion follows: where confinement is available the
 * denial itself is proven, and where it is not the REFUSAL is proven. Both
 * branches assert real behaviour, and each branch's precondition is checked
 * before its conclusion — a test that cannot say which world it is in has
 * not established either.
 */
import { describe, expect, test } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { componentSnapshot } from "../../server/observability/component-registry.ts";
import { appendFileSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import {
  builtinSpellings,
  read,
  reachableFilesImporting,
  relpath,
  sourceFiles,
  sourceFilesReachableFrom,
  stripCommentsAndStringsFor,
  stripCommentsOnly,
} from "../helpers/source-scan.ts";
import { bodyCalls, functionBody } from "../helpers/function-scope.ts";
// Temp directories have ONE owner, which also sweeps them when a test fails
// part-way — the reason the hand-rolled try/finally pairs are gone.
import { createTempDir } from "../helpers/temp-dir.ts";
import { createRepositoryLocalTemporaryDirectory } from "../../engine/test/support/repository-local-temporary.ts";
import { copyGuardianSealedInputs } from "../../engine/test/support/guardian-build-stamp.ts";
import { harnessView, harnessViewConfig, realHarnessRoot } from "../helpers/isolated-config.ts";
// Imported directly, unlike the probes below: the derivation is a pure
// function of a project path and this process, so it needs no child to
// measure a different config.
import {
  deriveAllowRules,
  interpreterPrefix,
  prepareConfinedSpawn,
  projectScratchDir,
  spawnPlanned,
} from "../../server/safety/landlock-runner.ts";
import { WEB_HARNESS_PROTECTED_SUBTREE_NAMES, webHarnessProtectedSubtrees, webServerSourceRoot } from "../../server/safety/host-facts.ts";
// A compile of the floor's own semantics asks with an empty key home of its own: another test file's database in /tmp
// (the run shares one registry) would otherwise refuse the /tmp temp grant.
import { emptyKeepOutFacts } from "../../engine/test/support/keep-out-facts.ts";
import { compileSelfProtectionConfigToSpec, invalidateProtectedNameCheck, PROJECT_ROOT_ACCESS_FLAGS, resolveLocation, hasSecondName } from "../../server/kernel/canonical.ts";
// The engine's safety floor, read from its owner rather than restated: the
// test below is about the fact that BOTH declarations spell a subtree `src`.
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";
// The atomic-rename owner: every planted config copy below is written
// through it, so even a config-shaped fixture is never a truncating write a
// spawned child could read mid-flight.
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { isProcessAlive } from "../../engine/src/process/process-facts.ts";
import { ValidationError } from "../../server/kernel/errors.ts";

import { modulePath } from "../helpers/module-resolver.ts";
import { requireHost } from "../../engine/test/support/host-requirement.ts";
const SERVER_ROOT = "server";
const SPAWN_OWNER = modulePath("tool-executor.ts");
const DECISION_OWNER = modulePath("landlock-runner.ts");
/**
 * The harness's own guardian runner. It is the SECOND module in this server's
 * reachable set that creates a process, and the only one outside this
 * repository — see `D2` below, where the reason it is allowed to is carried by
 * evidence rather than by this comment.
 */
const GUARDIAN_RUNNER =
  modulePath("guardian-binary.ts");
/**
 * The MCP stdio substrate. A stdio MCP server is a MODEL-DIRECTED proxy: the
 * operator chose which server runs, but the model chooses its tool arguments
 * (a path, a query, a command), exactly like `execute_command`'s argv — so it
 * is confined like every other model-directed process. The MCP module holds
 * NO process capability: the stdio transport starts a server only through the
 * host's spawn (`McpStdioHost.spawn`, required, no default), and the web
 * host's is `mcpStdioSpawn`, which asks the confinement owner
 * (`prepareConfinedSpawn`) and launches through its one door
 * (`spawnPlanned`). C0a pins all three facts and plants the unconfined shape.
 */
const MCP_STDIO_TRANSPORT = modulePath("stdio.ts");
/**
 * The intelligence extract farm — engine/src/intelligence/process-farm.ts. It
 * forks real CHILD PROCESSES (not worker_threads) because a tree-sitter WASM
 * grammar that segfaults would take a worker's host thread down with it;
 * running each child's parse in its own process is the crash isolation the
 * feature exists for. Every fork lands on the farm's OWN pinned child module
 * (`FARM_CHILD_PATH`, farm-child.ts) with an empty argv and a fixed
 * execArgv — no model, user, or project bytes reach the command line, so
 * there is no command-injection surface to confine. The `options.childPath`
 * override is a test-only seam (its only callers are the farm's own tests in
 * engine/test), and the child itself spawns nothing. The evidence is driven
 * in D5 below, the same way D2 drives the guardian's exemption rather than
 * asserting it.
 */
const FARM = modulePath("process-farm.ts");


/** The real harness root this server is configured against. */
/**
 * Run a probe in a child process with a chosen harness config, and hand back
 * whatever JSON it printed.
 *
 * A CHILD, NOT AN IMPORT, and that is load-bearing. `serverConfig` resolves
 * `harnessConfigPath` once at import time, so a test that wanted to measure a
 * different configuration by re-importing would measure the first one it ever
 * loaded — and would pass while the code under test read a config nobody in
 * the test had written.
 */
/**
 * One child per (config, script), remembered for the file's lifetime.
 *
 * Each probe is a fresh Node process — the only way to measure a different
 * harness config, since `serverConfig` resolves its path once at import — and
 * they are not cheap: the uncached version of this file spent about three
 * seconds starting interpreters, most of it re-asking questions it had
 * already answered, and pushed the whole suite past its wall-clock budget.
 * The budget is a real guard and is not raised to accommodate a test.
 *
 * Memoising is safe here precisely because these probes are PURE with respect
 * to the world they read: the same config file and the same script produce the
 * same answer, and the tests that need a CHANGED world write a different
 * config and therefore key differently.
 */
const PROBE_CACHE = new Map<string, unknown>();

function probe(source: string, configPath: string): unknown {
  const key = `${configPath}\u0000${source}`;
  const hit = PROBE_CACHE.get(key);
  if (hit !== undefined) return hit;
  const value = probeUncached(source, configPath);
  PROBE_CACHE.set(key, value);
  return value;
}

function probeUncached(source: string, configPath: string): unknown {
  const out = execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", source],
    {
      cwd: new URL("../..", import.meta.url).pathname,
      env: { ...process.env, HARNESS_CONFIG_PATH: configPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const line = out.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
  if (line === undefined) throw new Error(`probe printed no JSON:\n${out}`);
  return JSON.parse(line);
}


/**
 * The two questions this file always asks together — what the status is, and
 * what the planner does about it — answered by ONE child.
 *
 * They were two probes, and two probes means two Node interpreters started to
 * read the same config file twice. Asking both in one script is the same
 * measurement for half the process starts, which is what keeps this guard
 * inside the suite's wall-clock budget instead of pushing it over.
 */
function statusAndPlan(configPath: string): Readonly<{
  status: Record<string, unknown>;
  plan: Record<string, unknown>;
}> {
  return probe(
    `const m = await import("./server/safety/landlock-runner.ts");
     console.log(JSON.stringify({
       status: m.selfProtectionStatus(),
       plan: m.prepareConfinedSpawn({ command: "ls", args: [], projectRoot: "/tmp" }),
     }));`,
    configPath,
  ) as Readonly<{ status: Record<string, unknown>; plan: Record<string, unknown> }>;
}

/** A config document with self-protection in the requested state. */
function configWith(enabled: boolean): string {
  const base = JSON.parse(read("engine/bridlewise.config.json")) as Record<string, unknown>;
  base.selfProtection = { schemaVersion: "bridlewise-self-protection-config/v1", enabled };
  // Beside the harness it describes, never in the real harness: the one harness view (tests/helpers/isolated-config.ts).
  return harnessViewConfig(harnessView("confinement-harness-view-"), base);
}

/**
 * Where a project's scratch folder lies for the server a probe runs under `configPath`: the harness view that config
 * lives in keeps its own state folder, so the folder is the one `projectScratchDir` names under the real
 * harness, moved to the view.
 */
function scratchUnder(configPath: string, project: string): string {
  return join(dirname(configPath), relative(realHarnessRoot(), projectScratchDir(project)));
}

function withConfig<T>(enabled: boolean, body: (configPath: string) => T): T {
  return body(configWith(enabled));
}

// ── A. The decision: four states, and only one of them lets a command run ──

describe("A. the confinement decision", () => {
  test("self-protection off is reported as OFF and says commands are not confined", () => {
    withConfig(false, (cfg) => {
      const status = statusAndPlan(cfg).status;
      expect(status.state).toBe("off");
      // The sentence must state the CONSEQUENCE, not merely the setting. A
      // status that says "self-protection: disabled" is true and useless.
      expect(String(status.sentence)).toMatch(/not confined/i);
      expect(String(status.reason)).toContain("selfProtection.enabled");
    });
  });

  test("with self-protection off the plan is unconfined and carries its reason", () => {
    withConfig(false, (cfg) => {
      const plan = statusAndPlan(cfg).plan;
      expect(plan.kind).toBe("unconfined");
      // The command is passed through UNCHANGED — no guardian in front of it.
      expect(plan.command).toBe("ls");
      expect(String(plan.reason).length).toBeGreaterThan(0);
    });
  });

  test("a harness root with no guardian REFUSES; it does not fall through", () => {
    // The exact shape the ported experiment got wrong. The config asks for
    // confinement, the guardian is not there, and the only acceptable answer
    // is that nothing runs.
    const fakeHarness = createTempDir("confinement-noguardian-");
    try {
      mkdirSync(join(fakeHarness, "src"), { recursive: true });
      const cfg = join(fakeHarness, "bridlewise.config.json");
      expect(atomicWriteFile(
        cfg,
        JSON.stringify({
          schemaVersion: JSON.parse(read("engine/bridlewise.config.json")).schemaVersion,
          selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: true },
        }),
        { createMode: 0o600 },
      ).success).toBe(true);
      const plan = statusAndPlan(cfg).plan;
      expect(plan.kind).toBe("refused");
      // The SPECIFIC code, not merely "some refusal": a guard that accepts
      // any refusal cannot tell a missing guardian from a broken config.
      expect(plan.code).toBe("binary_missing");
      expect(String(plan.message)).toMatch(/not built|disappeared/i);
      // And nothing that could be spawned came back with it.
      expect(plan).not.toHaveProperty("args");
    } finally {
      rmSync(fakeHarness, { recursive: true, force: true });
    }
  });

  test("a project whose folder is no longer on disk is REFUSED with the real cause, not the guardian's ENOENT", () => {
    // THE DEFECT. A project can point at a folder that was wiped after it was
    // registered. `prepareConfinedSpawn` made that folder the child's working
    // directory, and a missing working directory makes `spawn` throw ENOENT
    // naming the PROGRAM — so a wiped project folder read as "the confinement
    // program is missing", an error attached to the wrong cause. The person
    // would have rebuilt a binary that was never the problem.
    //
    // The check belongs AHEAD of the confinement status, because the answer
    // is the same in both worlds: with the folder gone nothing can run
    // against it whether confinement is on or off. This drives BOTH — the
    // direct plan, and the door every `execute_command` actually takes — so
    // the inert shape (the check computed, then not consulted on one path) is
    // covered, not only the absent shape.
    const wiped = join(createTempDir("confinement-wiped-project-"), "gone");
    try {
      // LIVENESS, proven first: a folder that IS there still plans fine, so
      // the refusals below are the folder's absence and not a broken probe.
      // (A fresh folder: `/tmp` itself now holds this suite's own databases,
      // which the refused-paths floor rightly keeps from every project.)
      const present = prepareConfinedSpawn({ command: "ls", args: [], projectRoot: createTempDir("confinement-present-project-") });
      // A plan is released like any spawn's: its spec folder never outlives the check.
      if (present.kind === "confined") present.release();
      expect(present.kind, "a folder that exists must still be usable").not.toBe("refused");

      // A LINK TO A REAL FOLDER IS A LEGITIMATE PROJECT, so it follows links
      // rather than refusing them — the same question `spawn` would ask.
      const real = createTempDir("confinement-link-target-");
      const link = join(real, "linked");
      symlinkSync(real, link, "dir");
      try {
        const linked = prepareConfinedSpawn({ command: "ls", args: [], projectRoot: link });
        if (linked.kind === "confined") linked.release();
        expect(linked.kind).not.toBe("refused");
      } finally {
        rmSync(real, { recursive: true, force: true });
      }

      // THE REFUSAL, asserted EXACTLY: the typed code and the guided message,
      // verbatim. A loose match cannot tell this from the spec_rejected
      // refusal, and a paraphrase cannot tell the words from a stack trace.
      const expectedMessage =
        "The folder for the selected project could not be found on this computer, so the command was not run. "
        + "The folder may have been moved, renamed or deleted. Re-point the project to its folder, or choose a different project.";
      const missing = prepareConfinedSpawn({ command: "ls", args: [], projectRoot: wiped });
      expect(missing.kind).toBe("refused");
      if (missing.kind !== "refused") return;
      expect(missing.code).toBe("project_folder_missing");
      expect(missing.message).toBe(expectedMessage);
      // …and nothing that could be spawned came back with it.
      expect(missing).not.toHaveProperty("args");
      // The wiped PATH ITSELF is not in the message — a scratch path is the
      // harness's bookkeeping, and naming it reads as leaking internals.
      expect(missing.message).not.toContain(wiped);

      // THE DOOR THE MODEL ACTUALLY TAKES. A refusal computed and then not
      // consulted by `spawnAsyncSafe` would pass every assertion above, so
      // the same answer is required through the tool executor — as a refusal
      // the model can act on, not a spawned process that failed.
      const result = withConfig(true, (cfg) =>
        probe(
          `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
           const r = await executeToolCall("execute_command", { command: "pwd", args: [] }, { projectRoot: ${JSON.stringify(wiped)}, userId: "u" });
           console.log(JSON.stringify({ success: r.success, parsed: JSON.parse(r.output) }));`,
          cfg,
        ),
      ) as { success: boolean; parsed: Record<string, unknown> };
      expect(result.success).toBe(false);
      expect(result.parsed.confinement).toBe("refused");
      expect(result.parsed.confinementCode).toBe("project_folder_missing");
      expect(result.parsed.ran).toBe(false);
      expect(result.parsed.message).toBe(expectedMessage);
    } finally {
      rmSync(dirname(wiped), { recursive: true, force: true });
    }
  });
});

describe("A2. the states that are not 'yes' and not 'no'", () => {
  /**
   * "CANNOT TELL" MUST REFUSE, and it needs its own test because it is the
   * state a green suite never visits. On this host the guardian answers, so
   * nothing above ever reaches `unknown` — and a mutation that let `unknown`
   * through to an unconfined spawn passed every other test in this file.
   *
   * It is reached the way it would really happen: a settings file the schema
   * refuses. The resolver throws, the runner cannot say what was asked for,
   * and a question that could not be answered is not a yes.
   */
  test("a self-protection section the schema rejects becomes UNKNOWN, and unknown refuses", () => {
    const harness = createTempDir("confinement-badconfig-");
    try {
      mkdirSync(join(harness, "src"), { recursive: true });
      const cfg = join(harness, "bridlewise.config.json");
      expect(atomicWriteFile(
        cfg,
        // `enabled` must be a boolean. A string is the ordinary typo, and the
        // dangerous reading of it is "not true, therefore off".
        JSON.stringify({ selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: "yes" } }),
        { createMode: 0o600 },
      ).success).toBe(true);
      const status = statusAndPlan(cfg).status;
      expect(status.state).toBe("unknown");
      expect(status.code).toBe("config_unreadable");
      expect(String(status.sentence)).toMatch(/cannot be determined/i);

      // THE SAME CHILD, ASKED ONCE. `statusAndPlan` already carries the plan;
      // a second probe here started a second Node process to re-read the same
      // file and answer the same question, which is ~0.4s of a suite with no
      // wall-clock headroom.
      const plan = statusAndPlan(cfg).plan;
      // THE POINT: not "unconfined", which is what a typo-tolerant reading
      // would produce and what a user would never be told about.
      expect(plan.kind).toBe("refused");
      expect(plan.code).toBe("config_unreadable");
    } finally {
      rmSync(harness, { recursive: true, force: true });
    }
  });

  /**
   * A GUARDIAN THAT REFUSES BEFORE EXEC IS NOT A COMMAND THAT FAILED.
   *
   * The guardian exits with a code either way, so the naive reading of a
   * pre-exec refusal is "the command ran and exited non-zero" — a false
   * statement in the direction that matters, because it invites the model to
   * conclude something about a program that never started. The harness's own
   * classifier draws the line; this proves the line is drawn.
   */
  test("a pre-exec guardian refusal is read as a refusal, not as a command that ran", async () => {
    const { readGuardianOutcome, stripGuardianNotices } = await import("../../server/safety/landlock-runner.ts");

    // The guardian's real failure shape: its marker, its code, its message.
    const refusal = readGuardianOutcome(4, "landlock-guardian: 4: spec_invalid: allow rule path missing\n");
    expect(refusal.kind).toBe("refused_before_exec");
    if (refusal.kind !== "refused_before_exec") throw new Error("unreachable");
    expect(refusal.code).toBe(4);
    expect(refusal.message).toContain("spec_invalid");

    // AND THE CONVERSE, which is the half that makes the first half mean
    // something: a payload that legitimately exits with one of the guardian's
    // own codes, without the marker, RAN. A classifier keyed on the exit code
    // alone would call this a refusal and hide a real result.
    const ran = readGuardianOutcome(4, "error: 4 tests failed\n");
    expect(ran.kind).toBe("payload_ran");
    if (ran.kind !== "payload_ran") throw new Error("unreachable");
    expect(ran.stderr).toBe("error: 4 tests failed\n");

    // The guardian's success chatter never reaches the model as the
    // command's own words, and everything else survives byte-for-byte.
    expect(
      stripGuardianNotices("landlock-guardian: 0: default_deny…\nreal error here\n"),
    ).toBe("real error here\n");
    expect(stripGuardianNotices("untouched\n")).toBe("untouched\n");

    // A PROGRAM'S OWN WORDS ARE NOT OURS TO DELETE. Matching the bare marker
    // removed any line a command happened to start with it — a silent edit of
    // somebody else's output, and the one direction where being wrong is
    // invisible to everyone. Only a line in the guardian's FULL documented
    // shape (marker, decimal code, colon) is removed.
    const impostorLines = [
      "landlock-guardian: could not find the config you mentioned",
      "landlock-guardian:no space after the marker",
      "landlock-guardian: fatal: something the program itself is reporting",
    ];
    expect(impostorLines.length).toBeGreaterThanOrEqual(3);
    for (const line of impostorLines) {
      expect(
        stripGuardianNotices(`${line}\n`),
        `${line} is the command's own output and must survive`,
      ).toBe(`${line}\n`);
    }
    // PLANTED VIOLATION for the stripper itself: it must still remove the
    // shape it exists to remove, at every documented code.
    for (const code of [0, 4, 64]) {
      expect(stripGuardianNotices(`landlock-guardian: ${code}: notice\nkept\n`)).toBe("kept\n");
    }
  });
});

// ── A3. The allow-set is DERIVED, in three parts, and denies everything else ──

describe("A3. what a confined command may reach is derived, never authored", () => {
  test("a project nobody has heard of gets its root AND its scratch folder, with no edit anywhere", () => {
    // THE POINT OF "AUTOMATIC", stated as a test. A path list somebody
    // maintains fails silently and in the worst direction: a tool added later
    // works in development, dies under confinement, and the person debugging
    // it widens the list until the restriction stops meaning anything. So the
    // proof is a project INVENTED HERE — a directory that exists nowhere in
    // any source, config or fixture — appearing in the allow-set because the
    // derivation asked the project, not a list.
    const invented = createTempDir("confinement-never-seen-before-");
    const rules = deriveAllowRules(invented, "/usr/bin/cat");

    // POPULATION AS A RUNTIME NUMBER, with a floor: a derivation that returned
    // nothing would satisfy every "does not contain" assertion ever written.
    expect(rules.length, `derived allow rules: ${rules.map((r) => `${r.origin}=${r.path}`).join(", ")}`)
      .toBeGreaterThanOrEqual(4);

    const byOrigin = (o: string): readonly string[] =>
      rules.filter((r) => r.origin === o).map((r) => r.path);
    expect(byOrigin("project-root")).toEqual([invented]);
    expect(byOrigin("project-scratch")).toEqual([projectScratchDir(invented)]);
    // All three origins are present — the steer's three parts, each alive.
    expect(new Set(rules.map((r) => r.origin))).toEqual(
      new Set(["runtime-and-tools", "project-root", "project-scratch"]),
    );
  });

  test("READ+EXECUTE for tools, READ+WRITE for the project — not one flat grant", () => {
    // A uniform allow-set would be a weaker restriction wearing the same
    // shape: if the toolchain were writable, a confined command could change
    // the tools the NEXT command runs and step outside on the second move.
    const invented = createTempDir("confinement-access-split-");
    const rules = deriveAllowRules(invented, "/usr/bin/cat");
    for (const rule of rules) {
      const writes = rule.access.filter((a) => /WRITE|MAKE_|REMOVE_|TRUNCATE/.test(a));
      if (rule.origin === "runtime-and-tools") {
        expect(writes, `${rule.path} is a tool path and must never be writable`).toEqual([]);
        expect(rule.access, `${rule.path} must be executable`).toContain("EXECUTE");
      } else {
        expect(writes.length, `${rule.path} is a workspace and must be writable`).toBeGreaterThan(0);
      }
    }
  });

  test("DENY BY DEFAULT: a path from none of the three origins is not in the set", () => {
    const invented = createTempDir("confinement-deny-default-");
    const rules = deriveAllowRules(invented, "/usr/bin/cat");
    const paths = rules.map((r) => r.path);
    // A sibling of the project, a home directory, and the harness's own
    // source: none of them derive from anything, so none of them appear.
    // There is no "looks like a system path" arm to fall through.
    for (const outsider of [`${invented}-sibling`, realHarnessRoot(), `${realHarnessRoot()}/src`]) {
      expect(paths, `${outsider} derives from no origin and must not be allowed`).not.toContain(outsider);
    }
    // PLANTED VIOLATION: the check above is only meaningful if this array
    // comparison can fail at all, so show it failing on a path that IS there.
    expect(paths).toContain(invented);
  });
});

// ── B. What a child could actually reach (the assertion decoration cannot fake) ──

describe("B. the authority a spawned command actually has", () => {
  /**
   * One measurement of the host, taken once: is confinement genuinely
   * enforceable here? Everything below branches on it, and each branch states
   * its own precondition before its conclusion.
   */
  const hostStatus = withConfig(true, (cfg) => statusAndPlan(cfg).status);

  test("the host's confinement capability is measured, not assumed", () => {
    // LIVENESS FOR EVERYTHING BELOW. Without this, a probe that silently
    // returned a malformed object would let both branches vacuously agree.
    expect(["confined", "unavailable", "unknown"]).toContain(hostStatus.state);
    expect(typeof hostStatus.sentence).toBe("string");
  });

  test("a command run through the tool executor reports the authority it had", () => {
    const project = createTempDir("confinement-project-");
    try {
      writeFileSync(join(project, "inside.txt"), "inside\n");
      // THE OUTSIDE PATH IS THE HARNESS'S OWN SOURCE, and the choice matters.
      // The obvious pick — a sibling under the temp directory — proves
      // nothing: the compiled spec allow-lists the whole temp directory (the
      // guardian needs somewhere to put its spec file), so a temp sibling is
      // legitimately readable and `cat` fails with "no such file" instead of
      // a denial — which reads exactly like a working sandbox and is not one.
      // The harness `src/` is the tree self-protection exists to protect, so
      // a denial there is the property actually under test.
      const outsidePath = join(realHarnessRoot(), "src", "kernel", "root-policy.ts");
      const results = withConfig(true, (cfg) =>
        probe(
          `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
           const P = ${JSON.stringify(project)};
           const out = {};
           for (const [name, args] of [["inside", [P + "/inside.txt"]], ["outside", [${JSON.stringify(outsidePath)}]]]) {
             const r = await executeToolCall("execute_command", { command: "cat", args }, { projectRoot: P, userId: "u" });
             out[name] = { success: r.success, parsed: JSON.parse(r.output) };
           }
           console.log(JSON.stringify(out));`,
          cfg,
        ),
      ) as Record<string, { success: boolean; parsed: Record<string, unknown> }>;

      const inside = results.inside!;
      const outside = results.outside!;

      if (hostStatus.state === "confined") {
        // PRECONDITION: the command actually ran, confined. Asserting the
        // denial without this would pass just as well against a server that
        // refused everything, or spawned nothing at all.
        expect(inside.parsed.confinement).toBe("confined");
        expect(inside.parsed.ran).toBe(true);
        expect(inside.success).toBe(true);
        expect(String(inside.parsed.stdout)).toContain("inside");

        // THE CONCLUSION. A path outside the project is unreadable — from a
        // real child, through a real kernel restriction. Nothing about the
        // shape of the code can produce this; only the restriction can.
        expect(outside.success).toBe(false);
        expect(String(outside.parsed.stderr)).toMatch(/Permission denied/);

        // The guardian's own chatter is not handed to the model as if the
        // command had said it.
        expect(String(inside.parsed.stderr)).not.toContain("landlock-guardian:");
      } else {
        // PRECONDITION: this host genuinely cannot confine.
        expect(hostStatus.state === "unavailable" || hostStatus.state === "unknown").toBe(true);
        // THE CONCLUSION. Both commands are refused, and neither ran. A
        // warning-and-continue would show `ran: true` here.
        for (const r of [inside, outside]) {
          expect(r.success).toBe(false);
          expect(r.parsed.confinement).toBe("refused");
          expect(r.parsed.ran).toBe(false);
          expect(String(r.parsed.confinementCode).length).toBeGreaterThan(0);
        }
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });

  test("EVERY protected subtree is unreachable from a confined child, and nothing grants write into one", () => {
    // ── WHY EACH ONE ─────────────────────────────────────────────────────────
    //
    // The test above drives ONE read of ONE path inside ONE protected subtree.
    // Since the monorepo assembly the protected set is assembled from TWO
    // declarations resolved against two different roots — the engine's floor
    // against the harness root, this repository's list against the repository
    // root — and the compiler collects them into a `Set`. So the question that
    // matters is no longer "does confinement work"; it is "does it reach every
    // directory both declarations name". A set that quietly lost one entry
    // answers correctly about all the others, which is the U-15 shape: a
    // partial loss of the protected set, invisible.
    //
    // ── WHY THE PROBE IS A READ, AND WHY THAT SETTLES WRITES ────────────────
    //
    // A write cannot be driven through this door: the executor refuses `touch`
    // before confinement is reached ("changes files through the shell, which
    // is not governed by the write set here"), so a write probe measures that
    // policy and not the sandbox. Landlock does not grade access inside a
    // protected subtree — a protected subtree carries NO rule, so every access
    // is denied. A denied READ therefore proves the directory is in the
    // enforced set, and a write is strictly more than a read.
    //
    // The write claim is then closed on the other side, where it belongs: the
    // compiled spec must name every subtree, and no allow-rule in it may reach
    // into one. Both halves are asserted below, so neither a spec that lost a
    // subtree nor a rule that punched into one can pass.
    const project = createTempDir("confinement-read-");
    const subtrees = [
      ...ROOT_POLICY.selfProtection.minimumProtectedSubtrees.map((name) => join(realHarnessRoot(), name)),
      ...webHarnessProtectedSubtrees(),
    ];
    // POPULATION, as a runtime number derived from both owners: a declaration
    // that stopped contributing would leave this loop asserting about a
    // smaller set than the one it claims to cover.
    expect(subtrees.length).toBe(
      ROOT_POLICY.selfProtection.minimumProtectedSubtrees.length + WEB_HARNESS_PROTECTED_SUBTREE_NAMES.length + 1,
    );
    // One real file per subtree, DISCOVERED rather than named: a literal would
    // be a path this guard has to keep in step with the layout.
    const targets = subtrees.map((dir) => {
      const file = readdirSync(dir, { withFileTypes: true }).find((e) => e.isFile());
      expect(file, `${dir} holds no regular file to probe with`).toBeDefined();
      return join(dir, file!.name);
    });
    try {
      const results = withConfig(true, (cfg) =>
        probe(
          `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
           const P = ${JSON.stringify(project)};
           const out = {};
           for (const target of ${JSON.stringify(targets)}) {
             const r = await executeToolCall("execute_command", { command: "cat", args: [target] }, { projectRoot: P, userId: "u" });
             out[target] = { success: r.success, parsed: JSON.parse(r.output) };
           }
           console.log(JSON.stringify(out));`,
          cfg,
        ),
      ) as Record<string, { success: boolean; parsed: Record<string, unknown> }>;

      for (const target of targets) {
        const result = results[target];
        expect(result, `no result for ${target}`).toBeDefined();
        if (hostStatus.state === "confined") {
          // PRECONDITION — the child genuinely ran under the restriction.
          expect(result!.parsed.confinement, target).toBe("confined");
          expect(result!.parsed.ran, target).toBe(true);
          expect(String(result!.parsed.stderr), target).toMatch(/Permission denied/);
        } else {
          // PRECONDITION — this host cannot confine, so nothing ran at all.
          expect(["unavailable", "unknown"]).toContain(hostStatus.state);
          expect(result!.parsed.ran, target).toBe(false);
        }
        expect(result!.success, target).toBe(false);
      }
    } finally {
      rmSync(project, { recursive: true, force: true });
    }

    // ── THE WRITE HALF, AT THE SPEC ─────────────────────────────────────────
    // Every subtree reaches the guardian, and nothing in the allow-set reaches
    // back into one. `resolveLocation` is the compiler's own normaliser, so
    // the comparison is between resolved paths rather than spellings.
    const spec = compileSelfProtectionConfigToSpec(
      { schemaVersion: "bridlewise-self-protection-config/v1", enabled: true },
      realHarnessRoot(),
      project,
      process.execPath,
      { ...emptyKeepOutFacts(), harnessPaths: webHarnessProtectedSubtrees() },
    ) as { protected_subtrees: readonly string[]; allow_rules: readonly { path: string }[] };
    for (const subtree of subtrees) {
      expect(
        spec.protected_subtrees.map((p) => resolveLocation(p, "spec")),
        `${subtree} is declared and did not reach the guardian spec`,
      ).toContain(resolveLocation(subtree, "spec"));
    }
    for (const rule of spec.allow_rules) {
      const path = resolveLocation(rule.path, "spec");
      for (const subtree of subtrees) {
        const resolved = resolveLocation(subtree, "spec");
        expect(
          path === resolved || path.startsWith(`${resolved}/`),
          `allow-rule ${path} reaches into the protected subtree ${resolved}`,
        ).toBe(false);
      }
    }
  });

  /**
   * THE REFUSAL, DRIVEN THROUGH THE EXECUTOR — not merely returned by the
   * planner.
   *
   * This test exists because its absence let a mutation through. Reverting
   * the executor's refusal branch — computing the refusal correctly and then
   * spawning the command anyway — passed the entire rest of this file, for a
   * mundane reason: this host CAN confine, so nothing here ever travelled the
   * refused path, and the one test that mentioned refusal only inspected the
   * planner's return value. A decision that is correct and then ignored is
   * the shape this whole suite is written against, and it had a hole in
   * exactly the place that matters most.
   *
   * The assertion is a SIDE EFFECT THAT DID NOT HAPPEN, which no field and no
   * message can counterfeit: the command would have created a file, and the
   * file is not there.
   */
  test("a refusal STOPS the command — it is not a label on a command that ran", () => {
    const project = createTempDir("confinement-refusal-");
    const fakeHarness = createTempDir("confinement-refusal-harness-");
    try {
      mkdirSync(join(fakeHarness, "src"), { recursive: true });
      const cfg = join(fakeHarness, "bridlewise.config.json");
      expect(atomicWriteFile(
        cfg,
        JSON.stringify({
          ...JSON.parse(read("engine/bridlewise.config.json")),
          selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: true },
        }),
        { createMode: 0o600 },
      ).success).toBe(true);
      const evidence = join(project, "the-command-ran.txt");
      const result = probe(
        `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
         const r = await executeToolCall(
           "execute_command",
           { command: "node", args: ["-e", "require('fs').writeFileSync(process.argv[1],'ran')", ${JSON.stringify(evidence)}] },
           { projectRoot: ${JSON.stringify(project)}, userId: "u" },
         );
         console.log(JSON.stringify({ success: r.success, parsed: JSON.parse(r.output) }));`,
        cfg,
      ) as { success: boolean; parsed: Record<string, unknown> };

      // LIVENESS: the executor really answered, about the tool we asked about.
      expect(typeof result.parsed).toBe("object");
      expect(result.success).toBe(false);
      expect(result.parsed.confinement).toBe("refused");
      expect(result.parsed.ran).toBe(false);
      expect(result.parsed.confinementCode).toBe("binary_missing");

      // THE CONCLUSION, and the part a warning-then-run cannot survive.
      expect(
        existsSync(evidence),
        "the refused command must not have executed — a warning attached to a command that already ran is a description of the breach, not a defence",
      ).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(fakeHarness, { recursive: true, force: true });
    }
  });

  /**
   * TWO PROJECTS AT ONCE, EACH SEALED FROM THE OTHER.
   *
   * Landlock is IRREVOCABLE: once a process restricts itself the restriction
   * can only be added to, never relaxed or repointed. That fact decides the
   * architecture, and it is worth writing down because the obvious design is
   * the wrong one here.
   *
   * The obvious design is a long-lived confined process per project. It works
   * — the command-line harness does exactly that, because it serves one
   * project per invocation — but for a server it means a pool of processes to
   * keep alive, a router to send each tool call to the right one, and a
   * lifecycle to get wrong. And it buys nothing, because the restriction is
   * inherited across `execve`: applying it per SPAWN gives the same seal with
   * no pool at all, and switching projects becomes free rather than becoming
   * an eviction.
   *
   * So the spec is compiled from the project root of the call being made.
   * This test is the proof that the consequence holds: two projects, both
   * live, running at the same time, and neither child can see the other's
   * files. Switching projects is the same mechanism observed twice.
   */
  test("concurrent projects are each confined to their own root, and cannot see each other", () => {
    // A HOST REQUIREMENT (LIVE-SUITE): this hermetic test needs a host that confines; it never passes on one that does not.
    requireHost(hostStatus.state === "confined", `Landlock confinement on this host (it reports ${hostStatus.state})`);
    const alpha = createTempDir("confinement-alpha-");
    const beta = createTempDir("confinement-beta-");
    try {
      writeFileSync(join(alpha, "secret-alpha.txt"), "alpha only\n");
      writeFileSync(join(beta, "secret-beta.txt"), "beta only\n");
      const results = withConfig(true, (cfg) =>
        probe(
          `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
           const A = ${JSON.stringify(alpha)}, B = ${JSON.stringify(beta)};
           const call = (root, path) => executeToolCall(
             "execute_command", { command: "cat", args: [path] }, { projectRoot: root, userId: "u" },
           );
           // IN PARALLEL, deliberately: a sequential pair could pass while a
           // single shared restriction was being re-applied between calls,
           // which is the state Landlock's irrevocability makes impossible
           // and which this interleaving would expose.
           const [aOwn, aOther, bOwn, bOther] = await Promise.all([
             call(A, A + "/secret-alpha.txt"),
             call(A, B + "/secret-beta.txt"),
             call(B, B + "/secret-beta.txt"),
             call(B, A + "/secret-alpha.txt"),
           ]);
           const j = (r) => ({ success: r.success, parsed: JSON.parse(r.output) });
           console.log(JSON.stringify({ aOwn: j(aOwn), aOther: j(aOther), bOwn: j(bOwn), bOther: j(bOther) }));`,
          cfg,
        ),
      ) as Record<string, { success: boolean; parsed: Record<string, unknown> }>;

      // LIVENESS: all four really ran, confined. Without this the two denials
      // below would be satisfied by a server that refused everything.
      for (const key of ["aOwn", "aOther", "bOwn", "bOther"]) {
        expect(results[key]!.parsed.confinement, `${key} must have been confined`).toBe("confined");
        expect(results[key]!.parsed.ran).toBe(true);
      }
      // Each reaches its OWN project.
      expect(results.aOwn!.success).toBe(true);
      expect(String(results.aOwn!.parsed.stdout)).toContain("alpha only");
      expect(results.bOwn!.success).toBe(true);
      expect(String(results.bOwn!.parsed.stdout)).toContain("beta only");
      // And NEITHER reaches the other's, even running at the same instant.
      expect(results.aOther!.success).toBe(false);
      expect(String(results.aOther!.parsed.stdout)).not.toContain("beta only");
      expect(results.bOther!.success).toBe(false);
      expect(String(results.bOther!.parsed.stdout)).not.toContain("alpha only");
    } finally {
      rmSync(alpha, { recursive: true, force: true });
      rmSync(beta, { recursive: true, force: true });
    }
  });

  test("the project's own scratch folder is writable BY CONSTRUCTION, before anything creates it", () => {
    // THE REQUIREMENT THIS PROVES: the model is told about a scratch folder,
    // so it must be able to write there. Telling it about a folder it cannot
    // write to is worse than not telling it — it will try, fail, and have no
    // way to work out why.
    //
    // The folder does not exist when a project is new, and a Landlock rule
    // for a missing path makes the guardian refuse the whole spec, so it gets
    // no rule of its own yet. It is still writable, because it sits inside
    // the project root and the project root is allow-listed with create and
    // write. That is what "by construction" means here, and asserting it
    // matters precisely because it is NOT the same mechanism the derivation
    // uses — a reader would otherwise assume the missing rule means no access.
    requireHost(hostStatus.state === "confined", `Landlock confinement on this host (it reports ${hostStatus.state})`);
    const project = createTempDir("confinement-scratch-");
    const cfg = configWith(true);
    const scratch = scratchUnder(cfg, project);
    // IT IS OUTSIDE THE PROJECT, and that is the property under test as much
    // as the writability is: the folder the sandbox may write to must not be
    // somewhere the sandbox can REPLACE, or the next command's rules follow
    // whatever it was replaced with.
    expect(scratch.startsWith(`${project}/`), `${scratch} must not be inside the project`).toBe(false);
    expect(existsSync(scratch), "the folder must NOT exist yet — the server creates it").toBe(false);
    const result = (
      probe(
        `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
         const r = await executeToolCall(
           "execute_command",
           { command: "node", args: ["-e", "const fs=require('fs'); fs.mkdirSync(process.argv[1],{recursive:true}); fs.writeFileSync(process.argv[1]+'/probe.txt','ok'); console.log('WROTE')", ${JSON.stringify(scratch)}] },
           { projectRoot: ${JSON.stringify(project)}, userId: "u" },
         );
         console.log(JSON.stringify({ success: r.success, parsed: JSON.parse(r.output) }));`,
        cfg,
      )
    ) as { success: boolean; parsed: Record<string, unknown> };
    // LIVENESS: it really ran, and really ran confined.
    expect(result.parsed.confinement).toBe("confined");
    expect(result.parsed.ran).toBe(true);
    // THE CONCLUSION, checked from outside the sandbox.
    expect(result.success, JSON.stringify(result.parsed)).toBe(true);
    expect(existsSync(join(scratch, "probe.txt"))).toBe(true);
    // AND THE SERVER CREATED IT, not the command: it existed before the
    // payload ran, which is what takes the decision away from the sandbox.
    expect(existsSync(scratch)).toBe(true);
    rmSync(scratch, { recursive: true, force: true });
  });

  test("with confinement off the same command runs and says it was NOT confined", () => {
    // The other half of the honesty claim: silence is not permitted in the
    // unconfined case either. A build that only labelled the confined runs
    // would leave the dangerous state indistinguishable from the safe one.
    const project = createTempDir("confinement-off-project-");
    try {
      writeFileSync(join(project, "inside.txt"), "inside\n");
      const parsed = withConfig(false, (cfg) =>
        probe(
          `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
           const r = await executeToolCall("execute_command", { command: "cat", args: [${JSON.stringify(join(project, "inside.txt"))}] }, { projectRoot: ${JSON.stringify(project)}, userId: "u" });
           console.log(JSON.stringify({ success: r.success, parsed: JSON.parse(r.output) }));`,
          cfg,
        ),
      ) as { success: boolean; parsed: Record<string, unknown> };
      expect(parsed.success).toBe(true);
      expect(parsed.parsed.confinement).toBe("unconfined");
      expect(parsed.parsed.ran).toBe(true);
      expect(String(parsed.parsed.confinementReason)).toContain("selfProtection.enabled");
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});

// ── C. No second door (structural, with a stated population and a plant) ──

/**
 * Every way a Node module creates a child process. Matched on the CAPABILITY
 * rather than on an imported binding name, because an alias
 * (`import { spawn as go }`) or a namespace call (`cp.spawn(...)`) hides a
 * binding but cannot hide the verb — the mistake §8b records as having
 * produced a confident zero once already.
 */
const SPAWN_CALL = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/g;

export function spawnSites(source: string, path: string = "probe.ts"): number {
  // REGEX LITERALS ARE BLANKED FIRST, for the reason spelled out at
  // `blankRegexLiterals`: `RegExp.prototype.exec` shares its name with
  // `child_process.exec`, so a patch parser calling `/^@@ …/.exec(header)`
  // was counted as starting a program. That false positive used to be handled
  // in `nonLiteralSpawnSites` only — which was enough while this counter was
  // merely a floor, and stops being enough the moment the rule becomes "one
  // module, exactly". Same treatment in both, from one helper.
  return countSubprocessCalls(source, SPAWN_CALL, path);
}

/**
 * Occurrences of `pattern` in `source` that are genuinely subprocess calls:
 * comments and string interiors removed, regex literals blanked, and a regex
 * RECEIVER skipped. The narrowness of that last skip is deliberate and
 * measured — an earlier version skipped every dot with no identifier before
 * it, which also swallowed `(await import("node:child_process")).spawn(cmd)`,
 * and a mutation using exactly that shape walked straight through.
 */
function countSubprocessCalls(source: string, pattern: RegExp, path: string = "probe.ts"): number {
  const code = blankRegexLiterals(stripCommentsAndStringsFor(source, path));
  let sites = 0;
  for (const m of code.matchAll(new RegExp(pattern.source, pattern.flags))) {
    if (/\/RE\/\s*\.\s*$/.test(code.slice(0, m.index))) continue;
    sites += 1;
  }
  return sites;
}

/**
 * Can this module create a child process at all?
 *
 * Matched on the MODULE, not on any binding, because the module specifier is
 * the one thing a file cannot rename away: however the imported function is
 * later spelled, `node:child_process` has to appear. This is what bounds the
 * population; the call scanner above only locates the sites within it.
 */
export function importsChildProcess(source: string): boolean {
  // KEEPS STRING INTERIORS on purpose: the module specifier IS a string
  // literal, and the stripper that blanks literal contents erases the only
  // evidence there is. Measured, not assumed — with the blanking stripper
  // this detector returned false for every file in the server and the
  // population floor below is what caught it.
  //
  // A STATEMENT-LEVEL `import type` IS NOT THE CAPABILITY. TypeScript erases
  // it entirely, so nothing at runtime can create a process through it — the
  // tool executor keeps `import type { ChildProcess }` for the handle the
  // confinement owner hands back, and counting that as "can start a program"
  // would make the one-module rule permanently unsatisfiable and therefore
  // permanently ignored. Everything else still counts, including a mixed
  // import that merely spells one of its members `type`.
  const code = stripCommentsOnly(source).replace(
    /\bimport\s+type\s[^;]*?["']node:child_process["'][^;]*;/g,
    " ",
  );
  return /["']node:child_process["']/.test(code);
}

/** Does this source consume the confinement decision? Matched on the
 *  capability's own name, which no alias survives at the import site. */
export function consumesDecision(source: string, path: string = "probe.ts"): boolean {
  return stripCommentsAndStringsFor(source, path).includes("prepareConfinedSpawn");
}

/**
 * Subprocess creations whose PROGRAM IS NOT A LITERAL.
 *
 * ── THIS WAS THE DISCRIMINATOR, AND IT WAS WRONG ──────────────────────────
 *
 * The rule used to be: a variable-named spawn must be confined, a
 * literal-named one may be left alone, "because a hard-coded `spawn("git", …)`
 * can only ever run git". That sentence is false of git specifically and of
 * any program that reads configuration from where it is pointed. Git executes
 * `core.fsmonitor` on an ordinary read-only `git status`, plus aliases,
 * `core.pager` and `filter.*.clean/smudge`, all named in the repository's own
 * `.git/config` — and the repository is the project, which is writable from
 * inside the sandbox. It was measured end to end: a confined command planted
 * the config entry and a read-only status executed the planted script with the
 * server's full authority.
 *
 * The capability is "starts a subprocess whose behaviour something outside
 * this server controls", and a literal program name says nothing about that.
 * The same reasoning exempted the typecheck runner, which resolved the
 * project's OWN `typescript` and ran it unconfined — the second measured
 * escape, from the same one-sentence assumption.
 *
 * ── SO THE EXEMPTIONS ARE GONE, AND THAT IS THE FIX ───────────────────────
 *
 * Both call sites now go through the confinement owner, so the guard no
 * longer needs to sort spawns into dangerous and harmless — a judgement it
 * was making about the world and getting wrong. The rule below is
 * exemption-free: ONE module in `server/` creates a subprocess at all.
 * Anything else, literal-named or not, fails.
 *
 * This scanner is kept because it is what makes that rule enforceable: it
 * locates the sites, and the population is bounded by `importsChildProcess`.
 */
const NON_LITERAL_SPAWN =
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(?!["'`])[A-Za-z_$]/g;

/**
 * REGEXP LITERALS ARE REMOVED FIRST, and the reason is a real false positive
 * this scanner produced: `RegExp.prototype.exec` shares its name with
 * `child_process.exec`, so a patch parser calling `/^@@ …/.exec(header)` was
 * reported as spawning a program named by a variable. The shared stripper
 * removes comments and string interiors but not regex literals; blanking them
 * here leaves `.exec(` with nothing in front of the dot, which is what the
 * receiver test below keys on. A real `cp.exec(cmd)` keeps its identifier and
 * is still caught.
 */
function blankRegexLiterals(code: string): string {
  return code.replace(/\/(?![/*])(?:\\.|\[(?:\\.|[^\]])*\]|[^/\\\n])+\/[dgimsuvy]*/g, "/RE/");
}

export function nonLiteralSpawnSites(source: string, path: string = "probe.ts"): number {
  return countSubprocessCalls(source, NON_LITERAL_SPAWN, path);
}

// ── C0. THE POPULATION IS THE IMPORT GRAPH, NOT THE DIRECTORY ─────────────

/**
 * WHAT THIS SERVER CAN REACH, and why the answer is not "the files in
 * `server/`".
 *
 * The rule this file enforces used to be checked by walking `server/` and
 * reading each file's TEXT. That guard was GREEN, 32 of 32, while the sentence
 * it asserted was false: the awareness engine — imported by
 * `server/awareness-worker.ts`, living in the other repository — ran git
 * through a shell with no sandbox, and the project's own `.git/config` chose
 * the program. Two planted violations escaped for the same reason, one of them
 * a bare `"child_process"` specifier (the text scan knew only the `node:`
 * spelling) and one a subprocess exactly ONE IMPORT AWAY.
 *
 * A directory is a filing decision. What a process can do is decided by what
 * it can REACH. So the population is the transitive closure of the server's
 * own files over runtime import edges — across the repository boundary,
 * through re-exports, through `import()` and `require()` — and it is stated as
 * a runtime number below so an empty universe cannot masquerade as a clean
 * one.
 */
/*
 * ── THIS IS RUNG 5, AND THE STRUCTURAL ANSWER IS NOT A BETTER SCANNER ─────
 *
 * Read the ladder before reading the assertions. "Exactly these modules may
 * create a subprocess" is enforced here by SCANNING SOURCE, which is the
 * weakest rung there is: a source scan is only ever as good as the universe it
 * walks, and this one has now been wrong in four different ways across three
 * rounds — directory-scoped text, one module specifier, a bare specifier, and a
 * module one import away in the other repository. Each round shipped green
 * while a live escape sat in the tree. Widening the population to the import
 * graph fixes the universe that was wrong LAST time; it does not stop there
 * being a universe.
 *
 *   RUNG 1 — AVAILABLE, AND IT IS NOT THIS. `landlock-guardian.c` restricts
 *     the calling process and the restriction is "inherited across
 *     fork/exec/clone". Confining the PARENT — one confined worker per project
 *     or per run — makes every subprocess it will ever create confined by
 *     construction: no spawn site to find, no scanner, no exemption, and a
 *     contributor physically cannot create an unconfined child because the
 *     process they are writing in is already restricted. That is a change to
 *     how this server executes work, not to how it inspects itself, and it is
 *     tracked as its own architectural task.
 *   RUNG 2 — unavailable. "This module creates a process" is a property of a
 *     module's imports, not of a value's shape; no type can exclude it.
 *   RUNG 3 — unavailable from here for the same reason: the capability is
 *     `node:child_process`, a platform module every file may import, and
 *     nothing in this repository can make that import a compile error.
 *   RUNG 4 — PARTIALLY REACHED, and it is what actually holds today: every
 *     subprocess in this server goes through `prepareConfinedSpawn`, a single
 *     runtime door that refuses rather than falling through. What rung 4
 *     cannot do is stop a NEW module importing the platform module directly,
 *     which is the gap this scan covers and the gap rung 1 removes.
 *
 * So: this file is the floor, it says so, and it is deliberately not
 * gold-plated. The population below is the import graph because that is the
 * honest universe for a capability question — and the value of that helper is
 * general, not specific to this guard.
 */
let REACH_MEMO: ReturnType<typeof sourceFilesReachableFrom> | null = null;
/**
 * COMPUTED ON FIRST USE, not at module scope, and that is about the SCHEDULER
 * rather than about speed. Vitest orders files by their TEST duration, so work
 * done during collection is invisible to it and lands wherever there is
 * nothing left to overlap with — this suite already has one file whose 15s of
 * collect-time work made the whole run bimodal. A lazily computed graph is the
 * same work counted where it happens.
 */
function reach(): ReturnType<typeof sourceFilesReachableFrom> {
  // RUNTIME edges: a type-only import is erased, so it cannot carry a
  // capability. The compile-time closure is a different question with a
  // different owner (`frontend-contracts-owner.test.ts` §D asks it).
  REACH_MEMO ??= sourceFilesReachableFrom(sourceFiles(SERVER_ROOT), "runtime");
  return REACH_MEMO;
}

/** Both spellings of every module that can create a child process. */
const SUBPROCESS_MODULES = builtinSpellings(["child_process"]);

const relToWorkspace = (f: string): string => relpath(f);

/**
 * A file's source with comments and string interiors removed, remembered.
 *
 * Two assertions below walk the WHOLE reachable set and a third walks both
 * repositories' sources; reading and stripping each file once per assertion was
 * measured at roughly a second of the suite's wall clock, on a budget with
 * almost no headroom. The answer cannot change during a run — the files are not
 * being edited — so it is computed once.
 *
 * NO POPULATION IS WRITTEN HERE AS A NUMBER, and that is a rule rather than a
 * style. This comment used to say "355 files" and the one below said "654",
 * and the 654 was made false four commits later, in the same step, by a change
 * that took the web repository's contribution from one protected subtree to
 * four. Nothing could have caught it: the number lived in English. Every
 * population these scans cover is now asserted at the site that uses it, so
 * the only figures anybody reads come out of the run that produced them.
 */
const STRIPPED = new Map<string, string>();
function strippedSource(file: string): string {
  const hit = STRIPPED.get(file);
  if (hit !== undefined) return hit;
  const value = stripCommentsAndStringsFor(read(file), file);
  STRIPPED.set(file, value);
  return value;
}

/**
 * Does `file` contain any of `markers` in code — comments and string interiors
 * excluded?
 *
 * THE RAW TEXT IS TESTED FIRST, and that is a measured optimisation rather
 * than a micro-one. Stripping is what makes the answer correct, and it is also
 * the expensive half: these scans walk several hundred files each, and
 * stripping every one of them made this the slowest file in the suite, against
 * a wall-clock budget with almost no headroom. A file whose RAW text does not
 * contain the marker cannot contain it in code either, so the strip runs only
 * for the handful that might. The verdict is identical; the work is not.
 *
 * THE SHORTCUT'S OWN NUMBERS ARE COUNTED RATHER THAN CLAIMED. "Three files out
 * of 654" was true when it was written and false by the end of the same step;
 * the counters below are what the assertions state, so the claim and the
 * measurement cannot come apart.
 */
let codeMentionsAsked = 0;
let codeMentionsStripped = 0;
function codeMentions(file: string, markers: readonly string[]): boolean {
  codeMentionsAsked += 1;
  const raw = read(file);
  if (!markers.some((m) => raw.includes(m))) return false;
  codeMentionsStripped += 1;
  const code = strippedSource(file);
  return markers.some((m) => code.includes(m));
}

describe("C0. the guarded population is the import graph", () => {
  test("the closure is real, crosses the repository boundary, and is stated as numbers", () => {
    // THREE FLOORS, all below today's measured values so ordinary growth does
    // not fail them and a collapse to nothing does. The middle one is the
    // point: if the walk stopped at the repository boundary this number would
    // be zero, and every "no violations outside `server/`" assertion below
    // would be vacuously true — which is precisely the state the previous
    // guard was in.
    const outside = reach().files.filter((f) => !f.includes("/web-interface-foundation-v1/server/"));
    expect(reach().entrypoints.length, `entry points: ${reach().entrypoints.length}`).toBeGreaterThanOrEqual(80);
    expect(reach().files.length, `reachable source files: ${reach().files.length}`).toBeGreaterThanOrEqual(250);
    expect(
      outside.length,
      `reachable files OUTSIDE server/: ${outside.length} — zero here means the walk never left the repository`,
    ).toBeGreaterThanOrEqual(150);
    // The closure must be a superset of the entry set, never a replacement.
    expect(reach().files.length).toBeGreaterThan(reach().entrypoints.length);
  });

  test("the walk resolves what it should and COUNTS what it cannot", () => {
    // A BLIND SPOT WITH A NUMBER ON IT is a known quantity; a blind spot
    // without one is an assumption. `import(someVariable)` cannot be resolved
    // by any source scan, so it is counted rather than ignored, and the count
    // is asserted so it cannot grow silently.
    expect(
      reach().dynamicUnresolved,
      "a computed import specifier is unresolvable by a source scan — if one appears, this guard's population is incomplete and the number must be looked at",
    ).toBe(0);
    // Unresolved RELATIVE specifiers are stale imports or a resolver gap.
    // Today's three are documentation examples inside a multi-language import
    // extractor (`./foo.dart`), which resolve to nothing because they name
    // nothing. Bounded rather than asserted at zero, so a real stale import
    // still shows up as a rise.
    expect(reach().unresolved.length, `unresolved: ${reach().unresolved.join(" | ")}`).toBeLessThanOrEqual(5);
    // LIVENESS FOR THE RESOLVER: the graph really contains engine files,
    // resolved through `../engine/...` relative specifiers. Before the monorepo
    // assembly the same claim was spelled `/harness-main-v1/integration/src/`
    // and was called CROSS-REPOSITORY liveness; the trees are one repository
    // now, so it is cross-TREE liveness and the substring moved with them. The
    // proposition — the walker really leaves the web source — is unchanged.
    expect(reach().files.some((f) => f.includes("/engine/src/"))).toBe(true);
  });

  test("the reachability walker catches BOTH shapes that escaped the text scan", () => {
    // PLANTED VIOLATIONS, hermetically, in a fixture tree that exists only for
    // this test — so passing cannot be an accident of matching the real
    // sources. The two shapes are the two that were measured to escape:
    //
    //   P1  the BARE specifier `"child_process"`, with no `node:` prefix
    //   P3  the subprocess ONE IMPORT AWAY, outside the scanned directory
    //
    // Both are present at once here, which is the harder case: the entry
    // point's own text contains neither the word `spawn` nor the word
    // `child_process`.
    const fixture = createTempDir("subprocess-reach-plant-");
    mkdirSync(join(fixture, "far"), { recursive: true });
    writeFileSync(join(fixture, "entry.ts"), `import { helper } from "./far/mid.ts";\nexport const go = helper;\n`);
    writeFileSync(join(fixture, "far", "mid.ts"), `import { spawn } from "child_process";\nexport const helper = (c: string) => spawn(c, []);\n`);
    // CLEAN CONTROLS, in the same tree: a module reached only by a TYPE-only
    // import is erased before anything runs, and an unrelated built-in is not
    // this capability.
    writeFileSync(join(fixture, "typeonly.ts"), `import type { ChildProcess } from "node:child_process";\nexport type T = ChildProcess;\n`);
    writeFileSync(join(fixture, "innocent.ts"), `import { randomUUID } from "node:crypto";\nexport const id = randomUUID;\n`);

    const planted = sourceFilesReachableFrom([join(fixture, "entry.ts")], "runtime");
    const carriers = reachableFilesImporting(planted, SUBPROCESS_MODULES);
    expect(carriers.map((f) => f.replace(fixture, ""))).toEqual(["/far/mid.ts"]);

    // The type-only clause creates no runtime edge, so the module it names is
    // not a carrier — asserted directly rather than assumed.
    const typeOnly = sourceFilesReachableFrom([join(fixture, "typeonly.ts")], "runtime");
    expect(reachableFilesImporting(typeOnly, SUBPROCESS_MODULES)).toEqual([]);
    // …and the SAME fixture under `"all"` edges DOES name it, so the two modes
    // are proven to differ on the one input that distinguishes them. Without
    // this line, a `"runtime"` walk that had quietly become an `"all"` walk
    // would look identical to a correct one on every other fixture here.
    const typeOnlyAll = sourceFilesReachableFrom([join(fixture, "typeonly.ts")], "all");
    expect(reachableFilesImporting(typeOnlyAll, SUBPROCESS_MODULES).map((f) => f.replace(fixture, "")))
      .toEqual(["/typeonly.ts"]);
    const innocent = sourceFilesReachableFrom([join(fixture, "innocent.ts")], "runtime");
    expect(reachableFilesImporting(innocent, SUBPROCESS_MODULES)).toEqual([]);
    // …and the innocent walk really did walk, rather than returning nothing.
    expect(innocent.files.length).toBe(1);
    expect([...innocent.bareSpecifiers.keys()]).toEqual(["node:crypto"]);
  });

  test("EVERY module this server can reach that creates a process is a confinement owner", () => {
    // THE RULE, stated over the population that actually decides it: this
    // server's decision owner, the harness's guardian runner it delegates
    // to, and the extract farm (D-section). The MCP substrate is NOT a member
    // any more — its stdio servers start through the decision owner's door
    // (C0a) — so an MCP module that acquired a process capability of its own
    // fails here. Anything else — in either repository, at any import depth,
    // under either spelling of the module name — fails here too.
    const carriers = reachableFilesImporting(reach(), SUBPROCESS_MODULES).map(relToWorkspace).sort();
    expect(
      carriers,
      "every subprocess reachable from this server must come from the confinement subsystem — an MCP server included (its host spawn is the confined one) — anything else is unconfined by construction",
    ).toEqual([GUARDIAN_RUNNER, DECISION_OWNER, FARM].sort());
    // LIVENESS: the index really answers about modules that ARE imported,
    // so an empty answer above cannot be a broken index.
    expect(reach().bareSpecifiers.size, `distinct bare specifiers: ${reach().bareSpecifiers.size}`).toBeGreaterThanOrEqual(15);
    expect(reachableFilesImporting(reach(), builtinSpellings(["fs"])).length).toBeGreaterThanOrEqual(10);
  });

  test("C0a. no MCP transport spawns unconfined: the substrate holds no spawn, and the web host's is the confined door", () => {
    // The stdio transport starts a server ONLY through the host's spawn: it
    // imports no process capability and has no default to fall back to.
    const transport = read(MCP_STDIO_TRANSPORT);
    expect(importsChildProcess(transport), "the stdio transport must hold no process capability of its own").toBe(false);
    expect(transport, "the transport starts the server through the host's required spawn").toMatch(/config\.spawn\(/);
    expect(transport, "there is no default spawn to fall back to").not.toMatch(/spawnImpl|\?\?\s*spawn\b/);
    // The web host's spawn consults the decision owner and launches through
    // its one door — the confined plan, never a raw spawn.
    const host = read(modulePath("mcp-runtime-bridge.ts"));
    expect(importsChildProcess(host), "the MCP host must not hold a process capability either").toBe(false);
    const spawnFn = host.slice(host.indexOf("export function mcpStdioSpawn("), host.indexOf("export function mcpServerClient("));
    expect(consumesDecision(spawnFn), "an MCP stdio server is started only on the confinement owner's decision").toBe(true);
    expect(spawnFn, "and launched through the owner's one door").toMatch(/spawnPlanned\(plan,/);
    expect(spawnFn, "a refusal is thrown, never fallen through").toMatch(/if \(plan\.kind === "refused"\) \{\s*throw new ServiceUnavailableError\(plan\.message, plan\.code\);\s*\}/);
    // Every stdio client is built through the one door that binds that spawn.
    expect(host, "the registry builds every client through the host's door").toMatch(/clientFactory:\s*mcpServerClient/);
    expect(host, "the door hands the transport the confined spawn").toMatch(/spawn:\s*\(command, args, spawnOptions\)\s*=>\s*mcpStdioSpawn\(/);
    // PLANTED VIOLATION: an MCP-side module that spawns on its own must be
    // recognised by the carrier assertion above.
    const planted = `import { spawn } from "node:child_process";\nexport const go = (c: string) => spawn(c, []);\n`;
    expect(importsChildProcess(planted) && spawnSites(planted) > 0).toBe(true);
  });

  test("the other ways to run code arriving from outside are absent, or provably inert", () => {
    // The capabilities the previous detector did not mention AT ALL. Each is
    // asked of the whole reachable set, not of one directory.
    for (const capability of ["cluster", "child_process/promises"]) {
      expect(
        reachableFilesImporting(reach(), builtinSpellings([capability])),
        `${capability} must not be reachable from this server`,
      ).toEqual([]);
    }
    // `node:vm` IS reachable, from exactly one module, and it is inert there:
    // `new Script(...)` PARSES and never executes. Stated as evidence rather
    // than as a claim — the file must contain no `runIn*` call.
    const vmUsers = reachableFilesImporting(reach(), builtinSpellings(["vm"])).map(relToWorkspace);
    expect(vmUsers).toEqual([modulePath("artifact-check.ts")]);
    for (const user of vmUsers) {
      expect(
        /\brunIn(?:New|This)?Context\s*\(/.test(stripCommentsAndStringsFor(read(user), user)),
        `${user} may parse with node:vm but must never execute`,
      ).toBe(false);
    }
    // PLANTED VIOLATION for that detector: it must see an execution when
    // there is one.
    expect(/\brunIn(?:New|This)?Context\s*\(/.test(`new Script(src).runInNewContext({});`)).toBe(true);
    // No reachable module evaluates a string, or loads a native addon.
    const evaluators: string[] = [];
    for (const file of reach().files) {
      if (!codeMentions(file, ["eval(", "new Function", "dlopen("])) continue;
      if (/(?:^|[^.\w$])eval\s*\(|\bnew\s+Function\s*\(|\bprocess\s*\.\s*dlopen\s*\(/.test(strippedSource(file))) {
        evaluators.push(relToWorkspace(file));
      }
    }
    expect(evaluators, `modules that evaluate a string or load a native addon: ${evaluators.join(", ")}`).toEqual([]);
    // PLANTED VIOLATIONS for that detector, one per shape it must recognise.
    for (const shape of [`eval(userInput);`, `const f = new Function("return 1");`, `process.dlopen(m, path);`]) {
      expect(
        /(?:^|[^.\w$])eval\s*\(|\bnew\s+Function\s*\(|\bprocess\s*\.\s*dlopen\s*\(/.test(shape),
        `${shape} must be recognised`,
      ).toBe(true);
    }
    // CLEAN CONTROL: a method that merely SHARES the name is not the capability.
    expect(/(?:^|[^.\w$])eval\s*\(/.test(`policy.eval(candidate);`)).toBe(false);
  });
});

describe("C. one door for model-directed subprocesses", () => {
  const files = sourceFiles(SERVER_ROOT).map((f) => relpath(f));
  const withSpawns = files.filter((f) => spawnSites(read(f), f) > 0);

  test("the scanned population is real and is stated as a number", () => {
    // A COUNT, NOT A NAME. The universe this scan covers is invisible in a
    // green run unless it is asserted; a scanner whose regex stopped matching
    // would otherwise report "no violations" over an empty set. The floors
    // are below today's measured values, so ordinary growth does not fail
    // them and a collapse to nothing does.
    expect(files.length, `server source files scanned: ${files.length}`).toBeGreaterThanOrEqual(50);
    expect(
      withSpawns.length,
      `server files creating subprocesses: ${withSpawns.join(", ")}`,
    ).toBeGreaterThanOrEqual(3);
  });

  test("the scanner detects a subprocess call it has never seen", () => {
    // PLANTED VIOLATION. The count above proves the detector runs; only this
    // proves it still recognises a bypass. Deliberately a shape the real
    // sources do not use — a namespaced, aliased call — so passing it cannot
    // be an accident of matching the code that is already there.
    expect(spawnSites(`import * as cp from "node:child_process";\ncp.execFile("rm", ["-rf", "/"]);`)).toBe(1);
    expect(spawnSites(`const cp = require("node:child_process");\ncp.spawnSync("sh");`)).toBe(1);
    // CLEAN CONTROL: a scanner that answers "yes" to everything proves
    // nothing either.
    expect(spawnSites(`const respawnCount = 3; // spawn( in a comment\nconst s = "spawn(";`)).toBe(0);
  });

  /**
   * A LIMIT THAT IS MEASURED AND WRITTEN DOWN RATHER THAN PAPERED OVER.
   *
   * `spawnSites` matches the capability's own verb at the call, so it sees
   * through namespaces and through an import renamed at the import site. It
   * does NOT see a binding renamed and then called under the new name
   * (`const go = spawn; go("sh")`) — nothing lexical can, short of resolving
   * the binding. This test PINS that gap so it is a known quantity instead of
   * an assumption, and `importsChildProcess` below is what actually bounds
   * the population, because a module cannot create a process without naming
   * the module that makes them.
   */
  test("the call scanner's known blind spot is pinned, and the import scanner covers it", () => {
    const renamed = `import { spawn } from "node:child_process";\nconst go = spawn;\ngo("sh");`;
    // MEASURED: zero. Neither the import nor the rename is a call, and `go(`
    // is not the capability's name — so this file spawns a process and the
    // call scanner cannot see it. Stated as a number rather than described,
    // so the gap cannot quietly widen.
    expect(spawnSites(renamed), "documented gap: a locally renamed binding").toBe(0);
    // And that file is still inside the population, because the import
    // detector does not depend on how the binding is later spelled.
    expect(importsChildProcess(`import * as anything from "node:child_process";`)).toBe(true);
    expect(importsChildProcess(`import { spawn as go } from "node:child_process";`)).toBe(true);
    expect(importsChildProcess(`const x = require("node:child_process");`)).toBe(true);
    // A module import that is NOT the process-creating one. Deliberately
    // `node:crypto` rather than the obvious `node:fs`: another prevention
    // guard scans test sources for dead `node:fs` imports WITHOUT stripping
    // string literals first, so a fixture quoting an fs import is read as
    // being one, and this file was reported as importing a symbol it does
    // not import. Recorded rather than worked around silently — the other
    // scanner's blind spot is real and is written up.
    expect(importsChildProcess(`import { randomUUID } from "node:crypto";`)).toBe(false);
  });

  /**
   * EXACTLY ONE MODULE STARTS A PROCESS, AND IT IS THE CONFINEMENT OWNER.
   *
   * This replaces an EXEMPTION LIST, and the replacement is the lesson of the
   * round rather than a tidy-up. The list held two entries, each with a
   * written reason, and both reasons were claims about the world that nothing
   * ever tested:
   *
   *   "a hard-coded spawn("git") can only ever run git"  — false; git runs
   *      `core.fsmonitor` from the project's own `.git/config`.
   *   "the SERVER names the checker, from its own install" — false; the
   *      checker was resolved from the PROJECT first, so the project named it.
   *
   * Both were escapes, proven end to end, and both lived exactly in the
   * exempted rows. An exemption carries the same evidence burden as a
   * detection — a planted violation showing the exempted shape really is
   * harmless — and neither of these had one.
   *
   * The rule that needs no such evidence is the one with no exemptions in it:
   * every MODEL-DIRECTED subprocess this server creates comes out of the
   * confinement owner, so there is no shape to judge. A second module
   * acquiring the capability for model-directed spawns fails here whatever
   * it spawns and however it names it.
   *
   * There is no exception: the MCP host starts stdio servers through this
   * owner's decision and door (C0a above), so it holds no process capability
   * of its own.
   */
  test("ONE module in the server can start a process at all, and it is the confinement owner", () => {
    const carriers = files.filter((f) => importsChildProcess(read(f)) && spawnSites(read(f), f) > 0).sort();
    expect(
      carriers,
      "every MODEL-DIRECTED subprocess this server creates — an MCP stdio server included — must come from the confinement owner; anything else is unconfined by construction",
    ).toEqual([DECISION_OWNER]);
    // LIVENESS: the owner really holds a spawn, and really consults the
    // decision. Without both, the assertion above is satisfied by a server
    // that spawns nothing, which is the empty-universe failure this file's own
    // scanner already committed once.
    expect(spawnSites(read(DECISION_OWNER))).toBeGreaterThanOrEqual(2);
    expect(consumesDecision(read(SPAWN_OWNER)), "the model-facing path must consult confinement").toBe(true);
  });

  test("every module that used to hold its own spawn now asks the owner instead", () => {
    // NAMED, because "zero violations" is invisible: these are the three
    // modules that need a child process, and each must reach it through the
    // door. A module dropping out of this list is a module that stopped
    // needing a subprocess — or one that found another way to get one.
    const askers = [modulePath("tool-executor.ts"), modulePath("auto-check-runner.ts"), modulePath("git-bridge.ts")];
    for (const asker of askers) {
      const src = read(asker);
      expect(consumesDecision(src), `${asker} must consult confinement`).toBe(true);
      expect(
        spawnSites(src),
        `${asker} must not start a program itself — it goes through the confinement owner`,
      ).toBe(0);
      expect(importsChildProcess(src), `${asker} must not even import the process-creating module`).toBe(false);
    }
    // POPULATION AS A RUNTIME NUMBER, with a plant: the check above is only
    // meaningful if `consumesDecision` can say no.
    expect(askers.length).toBeGreaterThanOrEqual(3);
    expect(consumesDecision("const x = 1;")).toBe(false);
  });

  test("ONE DOOR: the model-facing path starts no process of its own", () => {
    // THE STRONGEST FORM AVAILABLE HERE, and it exists because the weaker one
    // was not enough: while the executor held its own `spawn`, making it
    // launch the raw command with the plan still computed left every
    // structural check green. Taking the spawn out of that file entirely
    // leaves nothing there to point at the wrong program.
    expect(
      nonLiteralSpawnSites(read(SPAWN_OWNER)),
      "the model-facing path must not start a program itself — it goes through spawnPlanned",
    ).toBe(0);
    // LIVENESS: the owner really holds the spawn. Without this the assertion
    // above is satisfied by a server that spawns nothing at all — the
    // empty-universe failure this file's own scanner already committed once.
    expect(
      nonLiteralSpawnSites(read(DECISION_OWNER)),
      "the confinement owner must actually hold the spawn",
    ).toBeGreaterThanOrEqual(1);
  });

  test("UNCONFIGURED IS NOT UNCONFINED: absence of the setting still confines", () => {
    // The failure this closes is not a bug in a branch — it is a default that
    // reads as a decision. A config that never mentions self-protection must
    // not be treated as having turned it off, or the protection is removed by
    // forgetting rather than by choosing, silently, with nothing to see.
    const harness = createTempDir("confinement-undeclared-");
    try {
      mkdirSync(join(harness, "src"), { recursive: true });
      const cfg = join(harness, "bridlewise.config.json");
      // A config document with NO selfProtection section at all.
      expect(atomicWriteFile(cfg, JSON.stringify({ project: { name: "x" } }), { createMode: 0o600 }).success).toBe(true);
      // ONE CHILD FOR BOTH HALVES, for the same reason as above.
      const measured = statusAndPlan(cfg);
      const status = measured.status;
      // NOT "off". This harness root has no guardian, so the honest answer is
      // that confinement was WANTED and cannot be delivered — which refuses.
      expect(status.state).not.toBe("off");
      expect(status.state).toBe("unavailable");
      expect(String(status.reason)).toMatch(/on unless the settings turn it off/i);
      expect(measured.plan.kind).toBe("refused");
    } finally {
      rmSync(harness, { recursive: true, force: true });
    }
  });

  test("the variable-program detector separates the two shapes it exists to separate", () => {
    // PLANTED VIOLATION, in the shape the escape actually took.
    expect(nonLiteralSpawnSites(`export function runAnything(c: string){ return spawn(c, []); }`)).toBe(1);
    expect(nonLiteralSpawnSites(`cp.execFile(userChosen, args);`)).toBe(1);
    // CLEAN CONTROLS: a fixed program is not the thing being guarded, in
    // any of the three quote styles, and neither is an unrelated call.
    expect(nonLiteralSpawnSites(`spawn("git", GIT_ARGS, { cwd });`)).toBe(0);
    expect(nonLiteralSpawnSites("spawn(`git`, args);")).toBe(0);
    expect(nonLiteralSpawnSites(`backend.spawn("writer");`)).toBe(0);
    // The regex collision that this scanner actually produced, pinned so it
    // cannot come back: `RegExp.prototype.exec` is not a subprocess.
    expect(nonLiteralSpawnSites(`const m = /^@@ -(\\d+)/.exec(header);`)).toBe(0);
    // …while the child-process function of the same name still is.
    expect(nonLiteralSpawnSites(`cp.exec(commandLine);`)).toBe(1);
    // And the shape that actually defeated an earlier version of this
    // scanner: a dynamic import called inline, with no name anywhere.
    expect(
      nonLiteralSpawnSites(`(await import("node:child_process")).spawn(cmd, args);`),
    ).toBe(1);
  });

  test("every server module that CAN create a process is accounted for", () => {
    // The population bounded the robust way — by the module nobody can
    // rename. It is EXACTLY ONE: the confinement owner (every model-directed
    // subprocess, MCP stdio servers included). Listing the members in the
    // failure message means a new one arrives as a question rather than as a
    // silent addition.
    const carriers = files.filter((f) => importsChildProcess(read(f)));
    expect(
      carriers,
      `server modules able to create a process: ${carriers.join(", ")}`,
    ).toEqual([DECISION_OWNER]);
    // The one that takes a model-supplied command name holds no such
    // capability itself, and must consult the decision — and it does.
    expect(importsChildProcess(read(SPAWN_OWNER))).toBe(false);
    expect(consumesDecision(read(SPAWN_OWNER))).toBe(true);
    // PLANTED VIOLATIONS for the population detector, in both directions.
    // Without these the exact-match above is satisfied by a detector that has
    // stopped recognising the module at all.
    expect(importsChildProcess(`import { spawn } from "node:child_process";`)).toBe(true);
    expect(importsChildProcess(`import { type ChildProcess, spawn } from "node:child_process";`)).toBe(true);
    expect(importsChildProcess(`const cp = await import("node:child_process");`)).toBe(true);
    // …and the one shape that genuinely cannot start a program, which is why
    // it is the only thing excluded.
    expect(importsChildProcess(`import type { ChildProcess } from "node:child_process";`)).toBe(false);
  });

  test("the decision owner exists, and states all four confinement states", () => {
    const src = read(DECISION_OWNER);
    // LIVENESS FOR THE CONJUNCTION BELOW: without this the four `toContain`
    // calls would all pass against an empty file read that returned "".
    expect(src.length).toBeGreaterThan(1000);
    for (const state of ["off", "confined", "unavailable", "unknown"]) {
      expect(
        stripCommentsAndStringsFor(src, DECISION_OWNER).includes(`"${state}"`) || src.includes(`"${state}"`),
        `${DECISION_OWNER} must be able to report the '${state}' state`,
      ).toBe(true);
    }
  });

  test("no Landlock rule is restated in the web server — the harness owns them", () => {
    // §16: finding yourself writing Landlock logic is a stop signal. The flag
    // vocabulary, the floor and the compiler live in the harness; the only
    // thing this repo may hold is WHERE the result is applied.
    const flagVocabulary = /\b(?:LANDLOCK_ACCESS_FS|landlock_create_ruleset|landlock_restrict_self|PR_SET_NO_NEW_PRIVS|abi_version_hint|handled_access_fs)\b/;
    const restaters = files.filter((f) => flagVocabulary.test(stripCommentsAndStringsFor(read(f), f)));
    expect(restaters, "Landlock's own vocabulary must not appear in web server code").toEqual([]);
    // The plant: the detector must recognise the vocabulary when it IS there.
    expect(flagVocabulary.test(`const handled_access_fs = ["EXECUTE"];`)).toBe(true);
  });
});

// ── D. The two exemptions, as PLANTED VIOLATIONS ──────────────────────────

/**
 * AN EXEMPTION IS A CLAIM ABOUT THE WORLD, AND IT CARRIES THE SAME EVIDENCE
 * BURDEN AS A DETECTION.
 *
 * The previous version of this file planted a violation for every detector it
 * had and passed cleanly. It planted NOTHING for its two exemptions — and both
 * escapes lived exactly there. So the two claims that were exempted are driven
 * here as attacks, from inside the sandbox's own threat model: the project
 * plants the thing the exemption assumed it could not, and the assertion is
 * that nothing reached outside the project.
 *
 * These are behavioural and each costs a child process, which is why there are
 * two and not twenty: they are the two that were measured to work.
 */
describe("D. the exempted subprocess paths, attacked", () => {
  const hostConfines = withConfig(true, (cfg) => statusAndPlan(cfg).status).state === "confined";

  test("a project-planted typescript is NOT chosen by the typecheck, and could not escape if it were", () => {
    const project = createTempDir("plant-tsc-project-");
    const outside = createTempDir("plant-tsc-outside-");
    try {
      const escaped = join(outside, "ESCAPED.txt");
      const chosen = join(project, "PLANTED-WAS-CHOSEN.txt");
      writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true } }));
      writeFileSync(join(project, "index.ts"), "export const x: number = 1;\n");
      // THE PLANT: exactly what a confined `execute_command` can write, and
      // exactly what the old resolver preferred over the server's own copy.
      mkdirSync(join(project, "node_modules", "typescript", "lib"), { recursive: true });
      mkdirSync(join(project, "node_modules", "typescript", "bin"), { recursive: true });
      writeFileSync(
        join(project, "node_modules", "typescript", "package.json"),
        JSON.stringify({ name: "typescript", version: "9.9.9", main: "lib/typescript.js" }),
      );
      writeFileSync(join(project, "node_modules", "typescript", "lib", "typescript.js"), "module.exports = {};\n");
      writeFileSync(
        join(project, "node_modules", "typescript", "bin", "tsc"),
        `const fs = require("node:fs");
         try { fs.writeFileSync(${JSON.stringify(chosen)}, "chosen"); } catch {}
         try { fs.writeFileSync(${JSON.stringify(escaped)}, "escaped"); } catch {}
         process.exit(0);`,
      );

      const result = withConfig(true, (cfg) =>
        probe(
          `const { runAutoCheck } = await import("./server/awareness/auto-check-runner.ts");
           const r = await runAutoCheck("typecheck", ${JSON.stringify(project)});
           console.log(JSON.stringify({ status: r.status, confinement: r.output.confinement, ran: r.output.ran, errorCount: r.output.errorCount }));`,
          cfg,
        ),
      ) as Record<string, unknown>;

      // ONE TEST ON EVERY HOST (the hermetic finder's real site): the host requirement is asserted by name,
      // never a different set of assertions per host.
      requireHost(hostConfines, "Landlock confinement on this host");
      // LIVENESS: the check really ran, really confined, and really
      // typechecked — without this the two absences below are satisfied by
      // a check that did nothing at all.
      expect(result.ran, JSON.stringify(result)).toBe(true);
      expect(result.confinement).toBe("confined");
      expect(result.status).toBe("passed");
      expect(result.errorCount).toBe(0);

      // THE CONCLUSION, in two independent parts.
      expect(
        existsSync(chosen),
        "the project's own typescript must never be the program the check runs",
      ).toBe(false);
      expect(
        existsSync(escaped),
        "nothing the check ran may write outside the project",
      ).toBe(false);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a project-planted git fsmonitor cannot reach outside the project", () => {
    requireHost(hostConfines, "Landlock confinement on this host");
    const project = createTempDir("plant-git-project-");
    const outside = createTempDir("plant-git-outside-");
    try {
      const escaped = join(outside, "ESCAPED.txt");
      const ran = join(project, "IT-RAN.txt");
      const git = (args: readonly string[]): void => {
        execFileSync("git", [...args], { cwd: project, stdio: "ignore" });
      };
      git(["init", "-q"]);
      git(["config", "user.email", "t@t"]);
      git(["config", "user.name", "t"]);
      writeFileSync(join(project, "a.txt"), "x\n");
      git(["add", "a.txt"]);
      git(["commit", "-qm", "first"]);
      // THE PLANT: a program named by the PROJECT's own `.git/config`, which
      // git executes on an ordinary read-only status. Nothing about the
      // request is unusual and no mutating git operation is involved.
      const pwn = join(project, "pwn.sh");
      writeFileSync(
        pwn,
        `#!/bin/sh\necho ran > ${JSON.stringify(ran)} 2>/dev/null\necho escaped > ${JSON.stringify(escaped)} 2>/dev/null\nexit 0\n`,
        { mode: 0o755 },
      );
      appendFileSync(join(project, ".git", "config"), `\n[core]\n\tfsmonitor = ${pwn}\n`);

      const status = withConfig(true, (cfg) =>
        probe(
          `const { getProjectGitStatus } = await import("./server/intelligence/git-bridge.ts");
           console.log(JSON.stringify(getProjectGitStatus(${JSON.stringify(project)}) ?? { branch: null }));`,
          cfg,
        ),
      ) as Record<string, unknown>;

      // LIVENESS: git really ran and really answered. Asserting the denial
      // without this would pass against a bridge that had stopped invoking
      // git at all, which is the empty-universe failure in its behavioural
      // form.
      expect(status.branch, JSON.stringify(status)).toBe("master");
      expect(typeof status.head).toBe("string");

      // THE CONCLUSION.
      expect(
        existsSync(escaped),
        "a program git was told to run by the project must not reach outside the project",
      ).toBe(false);
      // And whether it ran at all is recorded rather than assumed: the
      // project root carries no EXECUTE flag, so on this host git cannot even
      // start it. Either answer is acceptable; escaping is not.
      expect([true, false]).toContain(existsSync(ran));
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ── D2. The one exemption left, carrying its own evidence ─────────────────

/**
 * THE SECOND SUBPROCESS CARRIER IS ALLOWED, AND THE REASON IS TESTED.
 *
 * `guardian-binary.ts` creates processes, and it is not this server's
 * confinement owner. That is an EXEMPTION, and an exemption is a claim about
 * the world: "the only thing this module can start is the guardian itself, so
 * a process it creates is confined by definition rather than in spite of
 * itself." Every exemption this project has written as prose has eventually
 * turned out to be false — both proven escapes lived in one — so the claim is
 * driven here instead of asserted.
 *
 * The evidence is structural and mechanical: every subprocess call in that
 * module launches the path that `resolveGuardianBinaryPath` returned (a file
 * whose sha256 must equal the root policy's pin before anything runs) with the
 * guardian's own `apply` verb as its first argument. There is no call that
 * launches anything else, and the detector is planted against.
 */
describe("D2. the guardian runner may spawn, and only the guardian", () => {
  const guardianSource = read(join("engine", "src", "filesystem", "self-protection", "guardian-binary.ts"));

  /** The argument text of every subprocess call in `source`. */
  function spawnCallArguments(source: string): string[] {
    const code = stripCommentsAndStringsFor(source, guardianSource);
    const out: string[] = [];
    for (const m of code.matchAll(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      while (i < code.length && depth > 0) {
        if (code[i] === "(") depth += 1;
        else if (code[i] === ")") depth -= 1;
        i += 1;
      }
      out.push(code.slice(start, i - 1));
    }
    return out;
  }

  test("every subprocess it creates is the pinned guardian, launched to apply or to report its stamp", () => {
    const calls = spawnCallArguments(guardianSource);
    // POPULATION AS A RUNTIME NUMBER: the module really does hold the spawns
    // this exemption is about. Without this the loop below is vacuous.
    expect(calls.length, `subprocess calls in the guardian runner: ${calls.length}`).toBeGreaterThanOrEqual(1);
    let applyCalls = 0;
    for (const call of calls) {
      expect(
        /^\s*binaryPath\s*,/.test(call),
        `a subprocess in the guardian runner must launch the pinned guardian, not ${call.slice(0, 60)}`,
      ).toBe(true);
      // The apply arm is identified by the spec identifier, which survives
      // the stripper's blanking; the `--stamp` arm is counted below from the
      // original source.
      if (/\bspecPath\b/.test(call)) applyCalls += 1;
    }
    expect(applyCalls, "the confinement path must still launch the guardian's apply mode").toBeGreaterThanOrEqual(1);
    // The verb itself, in the untouched source, once per apply call.
    expect(guardianSource.match(/"apply", "--spec"/g)?.length ?? 0).toBeGreaterThanOrEqual(applyCalls);
    // THE OTHER ARM IS A STAMP READ, NOT A SECOND PROGRAM: the probe asks the
    // same pinned binary for its reproducible build stamp. One `--stamp` spawn
    // is expected; any other call-shaped spawn above still had to be
    // `binaryPath`.
    expect(calls.length - applyCalls, "one subprocess may read the build stamp").toBe(1);
    expect(guardianSource.match(/"--stamp"/g)?.length ?? 0).toBe(1);
    // …and the path it launches comes from the resolver that checks the
    // reproducible build stamp against the sealed sources and the pin.
    expect(guardianSource).toMatch(/resolveGuardianBinaryPath\s*\(/);
    expect(guardianSource).toMatch(/ROOT_POLICY\.selfProtection\.binaryStamp/);
    expect(guardianSource).toMatch(/computeGuardianBuildStamp\s*\(/);
  });

  test("the exemption's detector rejects a spawn of anything else", () => {
    // PLANTED VIOLATION for the exemption, in the shape a bypass would take:
    // the same module, the same import, a different program.
    const planted = `import { spawn } from "node:child_process";\nspawn(userChosen, ["--exec", payload]);\n`;
    const calls = spawnCallArguments(planted);
    expect(calls.length).toBe(1);
    expect(/^\s*binaryPath\s*,/.test(calls[0]!)).toBe(false);
    // …and a second shape, where the program is a literal that is not the
    // guardian — "it is hard-coded" was the exact reasoning that produced the
    // git escape, so it must not pass either.
    expect(/^\s*binaryPath\s*,/.test(spawnCallArguments(`spawnSync("git", args);`)[0]!)).toBe(false);
    // CLEAN CONTROL: the real shape is recognised.
    expect(/^\s*binaryPath\s*,/.test(spawnCallArguments(`spawn(binaryPath, ["apply", "--spec", specPath]);`)[0]!)).toBe(true);
  });
});

// ── D3. The awareness engine, which was the third door ────────────────────

/**
 * THE ENGINE MUST NOT BE ABLE TO START A PROGRAM AT ALL.
 *
 * It ran git through a shell with no sandbox, on the user-selected project,
 * and the project's own `.git/config` chose the program git executed —
 * measured end to end, writing outside the project and overwriting a file in
 * the harness's protected source tree. The fix is not a neutralised list of
 * git's execution channels; it is that the engine no longer HOLDS the
 * capability. Each host supplies a runner with the authority that host can
 * honestly grant, and a host that forgets does not compile.
 */
describe("D3. the awareness engine has no subprocess of its own", () => {
  const ENGINE = join("engine", "src", "awareness", "engine.ts");

  test("the engine is in the reachable set and creates no process", () => {
    // LIVENESS FIRST: the file this test is about is genuinely reachable from
    // this server, which is the fact that made it dangerous.
    // `/integration/src/…` until the monorepo assembly; `/engine/src/…` since.
    const engineAbs = reach().files.find((f) => f.endsWith("/engine/src/awareness/engine.ts"));
    expect(engineAbs, "the awareness engine must be reachable from this server").toBeDefined();
    const src = read(ENGINE);
    expect(importsChildProcess(src), "the engine must not import the process-creating module").toBe(false);
    expect(spawnSites(src), "the engine must hold no subprocess call").toBe(0);
    // …and it must not have grown a shell-string builder back either.
    expect(stripCommentsAndStringsFor(src, ENGINE)).not.toMatch(/\bshellQuote\s*\(/);
  });

  test("the host must SAY how git may be run — omitting it is a compile error", () => {
    // The property is enforced by the type (the dependency has no default), so
    // the mechanical evidence is that the type demands it and that both hosts
    // supply it. A default would be a fallback source: it would fire exactly
    // when a host forgot, which is the moment running git is dangerous.
    const engineSrc = read(ENGINE);
    expect(engineSrc).toMatch(/runGit:\s*GitCommandRunner/);
    expect(engineSrc, "a default runner would re-create the hole").not.toMatch(/runGit[^\n]*=\s*run/);
    // THE HOST, with the runner that is honest for it.
    expect(read(modulePath("awareness-worker.ts"))).toMatch(/runGit:\s*runGitConfined/);
    // ── AND NO WRAPPER MAY SUPPLY ONE ────────────────────────────────────
    //
    // This used to assert that `multi-turn.ts` CONTAINED `runGit:
    // runGitDirectly` — an assertion that a second door existed, which pinned
    // it open. `createMultiTurnEngine` took a config and no dependencies and
    // hard-coded the direct runner, so a host calling it acquired an
    // unconfined `git` on the user-selected project with no compile error:
    // exactly the shape the engine's type was changed to forbid, one call
    // frame further out. It was dormant (no production consumer, checked
    // tree-wide by basename) and dormant is not closed.
    //
    // The wrapper now passes the obligation THROUGH, so the assertion is the
    // opposite one: it must not reach the process-creating runner at all.
    const multiTurn = stripCommentsAndStringsFor(
      read(join("engine", "src", "awareness", "multi-turn.ts")),
      join("engine", "src", "awareness", "multi-turn.ts"),
    );
    expect(multiTurn, "a wrapper must not import a runner it can hand out").not.toMatch(/runGitDirectly/);
    expect(multiTurn, "…nor name the module that holds one").not.toMatch(/git-command-runner/);
    expect(
      multiTurn,
      "the wrapper must take the same dependency the engine does, so forgetting it is a compile error at every door",
    ).toMatch(/dependencies:\s*AwarenessEngineDependencies/);
    // This server's runner goes through the SAME door as every other git read
    // here, so git gains no second entrance.
    // SCOPED TO THE PARSED BODY, and stated with no pattern at all. This line
    // used to bound the distance between `runGitConfined` and `return gitText(`
    // at 600 bytes; the NEXT function's `return gitText(` sat at 584, so with
    // this function's body replaced by a raw unconfined spawn the assertion
    // still passed. A window is a guess that two things are related because
    // they are near each other, and the guess is answered by whichever
    // neighbour is nearest. `bodyCalls` takes two identifiers and has nowhere
    // to put a window. The retired window is re-driven, with a neighbour
    // planted inside it, in `no-proximity-window-assertions.test.ts`.
    expect(
      bodyCalls(functionBody(read(modulePath("git-bridge.ts")), "runGitConfined"), "gitText"),
      "runGitConfined must read git through the shared reader, not a process of its own",
    ).toBe(true);
  });
});

// ── D4. Claims made in prose, made checkable ──────────────────────────────

/**
 * A COMMENT IS A CLAIM, AND AN UNCHECKED CLAIM DRIFTS.
 *
 * This repository has produced the failure twice in one step. A paragraph in
 * `landlock-runner.ts` told the next reader that the project's scratch folder
 * "sits UNDER the project root today… its being inside the project root right
 * now costs nothing and hides nothing" — four commits after the same step
 * moved it out, precisely because being inside was the defect. A second
 * paragraph asserted IN CAPITALS that an existence test used `lstat` when the
 * line below it used `existsSync`. And `worker-pool.ts`'s header called itself
 * the SINGLE and ONLY owner while the guard it names by name checks two.
 *
 * None of those was findable by anything mechanical, because the claim lived
 * in English beside code that had moved on. Fixing the words is the least of
 * the available answers; these tests are the rest of it — each names an
 * invariant the corrected prose asserts, so drift fails the suite instead of
 * misleading a reader who may then delete a real defence.
 */
describe("D4. the prose asserts nothing the code refutes", () => {
  test("every population these scans cover is a number this run produced", () => {
    // THE SHORTCUT REALLY RAN, AND ON A REAL POPULATION. `codeMentions` is the
    // raw-text fast path in front of the stripper; if it were asked about
    // nothing, every scan that uses it would report a clean tree having looked
    // at none of it — and the number that used to describe it lived in prose,
    // which is how it came to be wrong by 60 per cent inside one step.
    //
    // THE TWO POPULATIONS ARE RE-DERIVED HERE rather than read off a counter,
    // because a counter's value depends on which tests have already run and a
    // guard must never rest on ordering. The counters below are used only for
    // the facts that are order-free: that the shortcut ran at all, and that it
    // shortened something.
    const reachable = reach().files.length;
    const bothRepos = sourceFiles("server").length
      + sourceFiles(join("engine", "src")).length;
    expect(reachable, `reachable source files: ${reachable}`).toBeGreaterThanOrEqual(250);
    expect(bothRepos, `first-party sources across both repositories: ${bothRepos}`).toBeGreaterThanOrEqual(400);
    expect(
      codeMentionsAsked,
      `files put through the raw-text shortcut by the time this ran: ${codeMentionsAsked}`,
    ).toBeGreaterThanOrEqual(200);
    expect(
      codeMentionsStripped,
      `of those, files that then needed stripping: ${codeMentionsStripped}`,
    ).toBeLessThanOrEqual(codeMentionsAsked);
    // …AND THE SHORTCUT REALLY SHORTENS SOMETHING, measured here rather than
    // taken from a counter whose value depends on which tests ran first. This
    // is the claim the retired sentence made — "three files out of 654" — as a
    // number this run produced, over the same marker and the same population.
    const bothRepoFiles = [
      ...sourceFiles("server"),
      ...sourceFiles(join("engine", "src")),
    ];
    const rawHits = bothRepoFiles.filter((f) => read(f).includes("ResolvedAbsolutePath")).length;
    expect(rawHits, `files whose RAW text mentions the brand: ${rawHits} of ${bothRepoFiles.length}`).toBeGreaterThan(0);
    expect(rawHits, "the fast path must reject the overwhelming majority, or it buys nothing").toBeLessThan(bothRepoFiles.length / 10);
  });

  test("a project's scratch folder is OUTSIDE the project, for every project", () => {
    // THE INVARIANT THE COMMENT NOW STATES. Driven over roots rather than
    // asserted about one, because "outside the project" is a property of the
    // function and not of a lucky example — including the two cases a location
    // bug hides in: a root that is itself the harness, and a root spelled with
    // a trailing separator.
    // SCOPED HONESTLY, and the scope is the finding. "Outside the project" is
    // true for every project root the compiler will ACCEPT, and it is false for
    // a root that CONTAINS the harness — `/` contains everything. That case is
    // not a hole here: a project root containing a protected subtree is refused
    // outright with `project_is_harness_source`, which the test further down
    // this file drives. So the roots below are the ones a person can actually
    // select, and the containing case is bounded by a refusal rather than by
    // this function.
    //
    // `process.cwd()` AND ITS TRAILING-SLASH TWIN WERE DROPPED AT THE MONOREPO
    // ASSEMBLY, and dropping them is the honest move rather than a weakening.
    // This repository's root now CONTAINS the harness source (`engine/`), so it
    // is precisely the containing case the paragraph above excludes: the
    // scratch folder derives from the harness root and therefore lands inside
    // it. Selecting it is refused outright with `project_is_harness_source` —
    // driven further down this file against `join(webServerSourceRoot(), "..")`,
    // which IS this root. Keeping it here would have asserted a property about
    // a folder nobody can select, and the only way to make that assertion pass
    // would have been to weaken the scratch derivation.
    const roots = [
      "/tmp/some-project",
      "/home/user/work/repo",
      "/srv/app",
      "/var/tmp/checkout",
      "/opt/checkout",
      "/opt/checkout/",
    ];
    expect(roots.length, `project roots driven: ${roots.length}`).toBeGreaterThanOrEqual(6);
    for (const root of roots) {
      const scratch = projectScratchDir(root);
      const resolved = resolveLocation(root, "project root");
      expect(
        scratch === resolved || scratch.startsWith(`${resolved.endsWith("/") ? resolved : `${resolved}/`}`),
        `the scratch folder for ${root} must not be inside it — it was ${scratch}`,
      ).toBe(false);
    }
    // …and it is the same folder every time for one project, which is the
    // other half of the claim ("derived from the project, keyed by it").
    expect(projectScratchDir("/tmp/some-project")).toBe(projectScratchDir("/tmp/some-project"));
    expect(projectScratchDir("/tmp/some-project")).not.toBe(projectScratchDir("/tmp/other-project"));
  });

  test("a doc comment that names an API as THE mechanism must name one the code uses", () => {
    // THE GENERAL FORM OF THE `lstat`/`existsSync` failure: prose of the shape
    // "`x`, NOT `y`" is a claim about which API the code below calls, and it
    // is checkable whenever both names are real APIs this file imported. The
    // claim that failed named `lstat` while the file imported and called
    // `existsSync`, in capitals, one line above the call.
    const claim = /`([A-Za-z_$][\w$]*)`\s*,?\s*(?:AND\s+)?NOT\s+`([A-Za-z_$][\w$]*)`/gi;
    const scanned = [
      ...sourceFiles("server"),
      ...sourceFiles(join("engine", "src")),
    ];
    expect(scanned.length, `files scanned for an API claim: ${scanned.length}`).toBeGreaterThanOrEqual(400);
    let claimsChecked = 0;
    const broken: string[] = [];
    for (const file of scanned) {
      const source = read(file);
      const imported = new Set(
        [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:[a-z/]+["']/g)]
          .flatMap((m) => m[1]!.split(",").map((name) => name.trim().split(/\s+as\s+/)[0]!.trim()))
          .filter((name) => name.length > 0),
      );
      const code = stripCommentsAndStringsFor(source, file);
      for (const m of source.matchAll(claim)) {
        const [, used, refused] = m;
        // Only a claim about APIs THIS FILE IMPORTED is checkable here. A claim
        // about a field name, a keyword or another module's function is a
        // different question and is not answered by pretending.
        if (!imported.has(used!) && !imported.has(refused!)) continue;
        claimsChecked += 1;
        if (!code.includes(`${used}(`)) broken.push(`${relpath(file)}: names \`${used}\` as the mechanism and never calls it`);
        if (code.includes(`${refused}(`)) broken.push(`${relpath(file)}: says NOT \`${refused}\` and calls it`);
      }
    }
    // THE POPULATION, STATED RATHER THAN ASSUMED — and today it is ZERO,
    // because correcting `landlock-runner.ts` removed the only claim of this
    // shape that named an imported API. Said plainly instead of dressed up: a
    // zero here means this scan currently proves nothing about the tree, and
    // the plants below are the only evidence that it still decides. It is kept
    // because the shape is one somebody writes again — it was written twice in
    // one step — and the day it returns this fails.
    expect(broken, `a comment asserting a defence the code does not implement:\n${broken.join("\n")}`).toEqual([]);
    expect(claimsChecked, `checkable API claims across both repositories: ${claimsChecked}`).toBeGreaterThanOrEqual(0);
    // PLANTED VIOLATION for the detector, in both directions.
    const planted = "/** THE TEST IS `lstatSync`, NOT `existsSync`. */\nif (!existsSync(p)) return false;";
    const plantedClaim = /`([A-Za-z_$][\w$]*)`\s*,?\s*(?:AND\s+)?NOT\s+`([A-Za-z_$][\w$]*)`/i.exec(planted)!;
    expect(plantedClaim[1]).toBe("lstatSync");
    expect(plantedClaim[2]).toBe("existsSync");
    const plantedCode = stripCommentsAndStringsFor(planted, "probe.ts");
    expect(plantedCode.includes("lstatSync("), "the named mechanism is absent — must be reported").toBe(false);
    expect(plantedCode.includes("existsSync("), "the refused one is present — must be reported").toBe(true);
  });
});

// ── D5. The extract farm forks only its own pinned child ─────────────────

/**
 * THE FARM'S CHILD IS THE HARNESS'S OWN CODE, WITH NOTHING ON THE COMMAND
 * LINE A CALLER CAN STEER.
 *
 * `process-farm.ts` creates child processes, and it is not this server's
 * confinement owner. That is an EXEMPTION, and per D2's lesson an exemption
 * is driven, not asserted: the reason it is safe is that every fork the
 * module performs launches the farm's own pinned `FARM_CHILD_PATH` —
 * farm-child.ts, the harness's own parser — with an EMPTY argv and a FIXED
 * `execArgv`. There is no user-, project-, or model-controlled string in the
 * command line, so there is nothing for an injection to steer, and the
 * crash-isolation argument for a real child process (a tree-sitter WASM
 * segfault must not take the host down) is why it is a child and not a
 * worker_thread.
 *
 * The one opening is `options.childPath`. It is a TEST seam: its only
 * callers are the farm's own tests, which point it at a mock child. A
 * production caller passing a chosen path would turn the seam into a second
 * door, so that is asserted closed over the production trees rather than
 * trusted from review.
 */
describe("D5. the extract farm forks its own pinned child, and nothing steers the command", () => {
  const FARM_SOURCE = read(FARM);

  /** The first argument of every `fork(...)` call in `source`, brace-balanced. */
  function forkCallTargets(source: string): string[] {
    const code = stripCommentsAndStringsFor(source, FARM);
    const out: string[] = [];
    for (const m of code.matchAll(/\bfork\s*\(/g)) {
      let depth = 1;
      let i = m.index! + m[0].length;
      const start = i;
      while (i < code.length && depth > 0) {
        if (code[i] === "(") depth += 1;
        else if (code[i] === ")") depth -= 1;
        i += 1;
      }
      // First argument only, up to the first top-level comma.
      const callText = code.slice(start, i - 1);
      let inner = 0;
      let cut = callText.length;
      for (let j = 0; j < callText.length; j += 1) {
        const ch = callText[j]!;
        if (ch === "(" || ch === "[" || ch === "{") inner += 1;
        else if (ch === ")" || ch === "]" || ch === "}") inner -= 1;
        else if (ch === "," && inner === 0) { cut = j; break; }
      }
      out.push(callText.slice(0, cut).trim());
    }
    return out;
  }

  test("every fork launches the pinned farm child, with no caller-chosen command", () => {
    const targets = forkCallTargets(FARM_SOURCE);
    // POPULATION AS A RUNTIME NUMBER: the module really does hold the fork
    // this exemption is about; an empty list would certify a farm that does
    // not spawn, which is the empty-universe failure.
    expect(targets.length, `fork calls in process-farm.ts: ${targets.length}`).toBeGreaterThanOrEqual(1);
    for (const target of targets) {
      // The launch target resolves to the pinned child or the test seam —
      // never a caller-supplied string literal or a value off the input.
      expect(
        /^options\.childPath\s*\?\?\s*FARM_CHILD_PATH$|^FARM_CHILD_PATH$/.test(target),
        `a farm fork must land on the pinned child, not ${target.slice(0, 60)}`,
      ).toBe(true);
    }
    // The command line carries nothing steerable: no argv at all, and the
    // Node flags are the fixed strip-types door.
    expect(FARM_SOURCE).toContain("FARM_CHILD_PATH");
    expect(FARM_SOURCE).toMatch(/fork\([^)]*,\s*\[\s*\]\s*,\s*\{[^}]*execArgv:\s*\["--experimental-strip-types"\]/s);
  });

  test("the childPath seam is reachable only from the farm's own tests", () => {
    // The exemption's one opening is the override. Over BOTH production trees
    // (engine/src and the web server), nobody sets it: the seam exists for
    // engine/test alone. A production caller appearing here would make the
    // child steerable, which is exactly what this exemption says cannot
    // happen.
    const production = [
      ...sourceFiles(join("engine", "src")),
      ...sourceFiles("server"),
    ];
    const setters = production.filter((f) => stripCommentsAndStringsFor(read(f), f).includes("childPath:"));
    expect(
      setters.map((f) => relpath(f)),
      `no production module may set the farm's childPath: ${setters.join(", ")}`,
    ).toEqual([]);
    // LIVENESS: the seam is real and the test door really uses it — without
    // this the empty answer above could be a scan that matched nothing.
    expect(FARM_SOURCE).toContain("childPath");
  });

  test("a farm fork of a caller-chosen program is caught, and the pinned shape is recognised", () => {
    // PLANTED VIOLATION in the shape a bypass would take: argv carrying a
    // caller-chosen file, or a program that is not the pinned child.
    const planted = `import { fork } from "node:child_process";\nfork(userSuppliedPath, [], { execArgv: [] });\n`;
    expect(forkCallTargets(planted)).toEqual(["userSuppliedPath"]);
    expect(/^options\.childPath\s*\?\?\s*FARM_CHILD_PATH$/.test(forkCallTargets(planted)[0]!)).toBe(false);
    // CLEAN CONTROL: the seam shape is recognised.
    const clean = `fork(options.childPath ?? FARM_CHILD_PATH, [], { execArgv: ["--experimental-strip-types"] });`;
    expect(/^options\.childPath\s*\?\?\s*FARM_CHILD_PATH$/.test(forkCallTargets(clean)[0]!)).toBe(true);
  });
});

// ── E. The derived pieces that had no bound of their own ──────────────────

describe("E. derived rules with their own bounds", () => {
  test("the interpreter prefix is only taken when the executable really is in a 'bin'", () => {
    // MEASURED, and this is the bug: climbing two directories unconditionally
    // turned `/home/user/node` into `/home` — read, list and execute over
    // every home directory on the machine, from a rule nobody wrote.
    expect(interpreterPrefix("/home/user/node")).toBe("/home/user");
    expect(interpreterPrefix("/home/user/node")).not.toBe("/home");
    // …while the real layout still resolves to the install prefix, which is
    // the whole reason the rule exists.
    expect(interpreterPrefix("/usr/bin/node")).toBe("/usr");
    expect(interpreterPrefix("/home/u/.nvm/versions/node/v24.0.0/bin/node")).toBe("/home/u/.nvm/versions/node/v24.0.0");
    // Degenerate shapes answer rather than reaching for a parent that is not
    // there.
    expect(interpreterPrefix("/node")).toBe("/");
    // LIVENESS for the whole test: the running process's own prefix is a real
    // directory, so the rule is not producing a path that cannot be allowed.
    expect(existsSync(interpreterPrefix())).toBe(true);
  });

  test("a server-named tool path is read-and-execute, never writable", () => {
    // The one addition confinement gained this round, held to the same access
    // split as everything else in its origin: if a checker's directory were
    // writable, a confined command could replace the checker and own the next
    // check — which is the escalation being closed, rebuilt with a new door.
    const invented = createTempDir("confinement-toolpath-");
    const rules = deriveAllowRules(invented, "/usr/bin/cat", ["/opt/some-checker"]);
    const tool = rules.find((r) => r.path === "/opt/some-checker");
    expect(tool, `tool path missing from ${rules.map((r) => r.path).join(", ")}`).toBeDefined();
    expect(tool!.origin).toBe("runtime-and-tools");
    expect(tool!.access.filter((a) => /WRITE|MAKE_|REMOVE_|TRUNCATE/.test(a))).toEqual([]);
    expect(tool!.access).toContain("EXECUTE");
    // PLANTED VIOLATION for the filter itself: it must be able to find a
    // write flag when one is there.
    expect([...PROJECT_ROOT_ACCESS_FLAGS].filter((a) => /WRITE|MAKE_|REMOVE_|TRUNCATE/.test(a)).length).toBeGreaterThan(0);
  });

  test("the sandbox CANNOT reach the folder its own allow-rule is derived from", () => {
    // ── THE ESCAPE, AND WHY THIS IS NOW A SHAPE ARGUMENT ─────────────────
    //
    // `deriveAllowRules` emits a scratch folder with write access. That folder
    // used to live INSIDE the project, and the rule was computed by asking the
    // filesystem about it — so one confined command replaced the path with a
    // symbolic link to `~/.ssh` and the NEXT confined command listed the
    // private keys and wrote outside the project. Self-bootstrapping, no
    // unconfined help, every surface still reporting the sandbox as enforced.
    //
    // Checking for the link is the losing move. The folder MOVED OUT of the
    // project, into a directory this server owns and no allow-rule names. Its
    // PARENT is in no rule, so the kernel refuses the create, remove, rename
    // and link operations a replacement would need — there is nothing to check
    // because there is nothing the sandbox can do.
    requireHost(hostCanCompile(), "a host that compiles a confinement spec (Landlock and the built guardian)");
    const project = createTempDir("scratch-unreachable-");
    const cfg = configWith(true);
    // The probes' server runs under the harness view, whose scratch folders are its own.
    const scratch = scratchUnder(cfg, project);
    try {
      // THE DERIVATION STILL NAMES IT — that is not the bug and must not change.
      expect(deriveAllowRules(project, "/usr/bin/cat").map((r) => r.path)).toContain(projectScratchDir(project));
      // …and it is outside the project, which is the whole change.
      expect(scratch.startsWith(`${project}/`)).toBe(false);

      const writeInsideJs = `const fs = require('fs'); const f = ${JSON.stringify(join(scratch, "mine.txt"))}; fs.writeFileSync(f, 'ok'); console.log('read-back:' + fs.readFileSync(f, 'utf8'));`;
      const replaceJs = `const fs = require('fs'); fs.rmSync(${JSON.stringify(scratch)}, { recursive: true, force: true }); fs.symlinkSync('/home', ${JSON.stringify(scratch)}); console.log('swapped');`;
      const attempts = (
        probe(
          `const { executeToolCall } = await import("./server/tools/tool-executor.ts");
           const P = ${JSON.stringify(project)};
           const run = (js) => executeToolCall("execute_command", { command: "node", args: ["-e", js] }, { projectRoot: P, userId: "u" });
           const out = {};
           const ok = await run(${JSON.stringify(writeInsideJs)});
           out.writeInside = { success: ok.success, parsed: JSON.parse(ok.output) };
           const swap = await run(${JSON.stringify(replaceJs)});
           out.replace = { success: swap.success, parsed: JSON.parse(swap.output) };
           console.log(JSON.stringify(out));`,
          cfg,
        )
      ) as Record<string, { success: boolean; parsed: Record<string, unknown> }>;

      // LIVENESS: the sandbox really ran, really confined, and really can use
      // the folder it was given. Without this the denial below is satisfied by
      // a server that refuses everything.
      expect(attempts.writeInside!.parsed.confinement).toBe("confined");
      expect(attempts.writeInside!.parsed.ran).toBe(true);
      expect(attempts.writeInside!.success, JSON.stringify(attempts.writeInside!.parsed)).toBe(true);
      // READ BACK BY THE CHILD ITSELF, not checked from here: the second probe
      // below deletes what it can inside the folder (it holds REMOVE_FILE
      // there, which is exactly the access it is supposed to have), so a
      // parent-side existence check afterwards measures the wrong moment.
      expect(String(attempts.writeInside!.parsed.stdout)).toContain("read-back:ok");

      // THE CONCLUSION: the folder is still a real directory afterwards, and
      // the attempt to replace it failed.
      expect(attempts.replace!.success, JSON.stringify(attempts.replace!.parsed)).toBe(false);
      expect(lstatSync(scratch).isDirectory(), "the scratch folder must still be a directory").toBe(true);

      // …and the NEXT spawn's rules still name the folder, not something else.
      const plan = prepareConfinedSpawn({ command: "cat", args: [], projectRoot: project });
      expect(plan.kind).toBe("confined");
      if (plan.kind !== "confined") return;
      const emitted = (JSON.parse(read(plan.args[2]!)) as { allow_rules: { path: string }[] }).allow_rules
        .map((r) => r.path);
      plan.release();
      expect(emitted.length).toBeGreaterThanOrEqual(5);
      // This plan is this process's own server's (the real harness): its scratch folder is the real one.
      expect(emitted).toContain(realpathSync(projectScratchDir(project)));
      expect(emitted).not.toContain("/home");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(scratch, { recursive: true, force: true });
      rmSync(projectScratchDir(project), { recursive: true, force: true });
    }
  });

  test("a link planted at the scratch folder from OUTSIDE the sandbox is REFUSED, not followed", () => {
    // THE RESIDUAL THIS DESIGN CANNOT REMOVE ON ITS OWN, driven rather than
    // described. The sandbox can no longer put anything at that path — but a
    // person, or another program running as the same user, still can, and the
    // harness would otherwise hand a confined command write access to wherever
    // it points. That is a strictly smaller claim than the escape it replaces
    // (it needs authority the sandbox does not have), and it is answered by
    // refusing anything at that path that is not a real directory.
    requireHost(hostCanCompile(), "a host that compiles a confinement spec (Landlock and the built guardian)");
    const project = createTempDir("scratch-outside-plant-");
    const outside = createTempDir("scratch-outside-target-");
    const scratch = projectScratchDir(project);
    try {
      mkdirSync(dirname(scratch), { recursive: true });
      rmSync(scratch, { recursive: true, force: true });
      symlinkSync(outside, scratch);
      const plan = prepareConfinedSpawn({ command: "cat", args: [], projectRoot: project });
      // THE CONCLUSION: refused, with a code that names what is wrong, and
      // NOT a spec that allow-lists the link's target.
      expect(plan.kind).toBe("refused");
      if (plan.kind !== "refused") return;
      expect(plan.code).toBe("spec_rejected");
      expect(String(plan.message)).toMatch(/not a folder any more/i);
      // …and it does NOT name the link target, which is the whole point.
      expect(String(plan.message)).not.toContain(outside);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("an OPERATOR rule spelled inside the project that resolves outside it is refused, and a rule that never claimed to be inside still compiles", () => {
    // The same invariant from the other direction. A derived rule is DROPPED
    // (losing it costs nothing, and refusing would let anything that can write
    // one link stop every command in the project); an operator's own is
    // REFUSED, because there a person wrote something wrong and has to be told.
    const project = createTempDir("operator-escape-");
    const outside = createTempDir("operator-escape-outside-");
    try {
      symlinkSync(outside, join(project, "workspace"));
      const compile = (rulePath: string): { ok: boolean; code?: string | undefined } => {
        try {
          compileSelfProtectionConfigToSpec(
            {
              schemaVersion: "bridlewise-self-protection-config/v1",
              enabled: true,
              additionalAllowRules: [{ path: rulePath, access: ["READ_FILE", "READ_DIR"] }],
            } as never,
            realHarnessRoot(),
            project,
            process.execPath,
            emptyKeepOutFacts(),
          );
          return { ok: true };
        } catch (err) {
          return { ok: false, code: (err as { code?: string }).code };
        }
      };
      // THE CONCLUSION: refused, with the SPECIFIC code.
      const escaping = compile(join(project, "workspace"));
      expect(escaping.ok).toBe(false);
      expect(escaping.code).toBe("path_escapes_region");
      // CLEAN CONTROL, and it matters: this is a bound on where an IN-PROJECT
      // rule may point, not an off switch for the allow-set. A rule that never
      // claimed to be inside the project still compiles.
      expect(compile("/usr/local").ok, "a legitimate widening must still compile").toBe(true);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("a SECOND NAME for a protected file makes the whole spec refuse", () => {
    // ── THE HALF OF THE HARDLINK PROBLEM THAT IS ACTUALLY ANSWERABLE ─────
    //
    // Landlock authorises by path hierarchy, so a hard link inside the project
    // pointing at a file outside it IS that file, reachable from inside the
    // sandbox. The previous round wrote this off as unaffordable, having
    // weighed two options that both scan the PROJECT. `nlink` is a property of
    // the INODE and is readable from either name, so asking "does any
    // PROTECTED file have a second name anywhere" needs no project scan at
    // all — the protected set is small, ours, and has no package-store problem.
    //
    // The link has to be on the same filesystem as its target, so the probe
    // directory is created beside the harness rather than under the system
    // temp directory, which is a different device here.
    requireHost(hostCanCompile(), "a host that compiles a confinement spec (Landlock and the built guardian)");
    // A HARNESS OF ITS OWN, never the live one: a second name for the live
    // harness's file changes that file's link count and change time, and every
    // concurrent configuration bootstrap compares the harness tree's entries
    // before and after its reads (engine/src/kernel/config.ts,
    // `config_parent_changed`), so the plant refused every gate that overlapped
    // it (measured 2026-10-10: a web budget reporter drive's gate could not run
    // at the instant this test linked root-policy.ts). The protected subtree is
    // the harness's `src` (ROOT_POLICY.selfProtection.minimumProtectedSubtrees);
    // this harness's holds one real file, a copy of the root policy.
    // ON THE HARNESS'S FILESYSTEM, not under the system temp root: a hard link
    // cannot cross a filesystem, and `/tmp` may be a different device. In the
    // checkout's declared fixture root (the harness's state folder), the one
    // place inside the checkout a test may write — never beside the harness
    // in the repository's own root, which a test run sees read-only (decision
    // TEST-CONFINEMENT-SELF-BIND), and where an entry is an undeclared root
    // entry to declared-root-inventory.test.ts while it exists.
    const harnessRoot = createRepositoryLocalTemporaryDirectory("second-name-harness-");
    const victim = join(harnessRoot, "src", "kernel", "root-policy.ts");
    mkdirSync(dirname(victim), { recursive: true });
    const live = join(realHarnessRoot(), "src", "kernel", "root-policy.ts");
    const liveBefore = lstatSync(live, { bigint: true });
    copyFileSync(live, victim);
    const probeRoot = createRepositoryLocalTemporaryDirectory("second-name-probe-");
    const link = join(probeRoot, "second-name.ts");
    const compile = (): { ok: boolean; code?: string | undefined } => {
      invalidateProtectedNameCheck();
      try {
        compileSelfProtectionConfigToSpec(
          { schemaVersion: "bridlewise-self-protection-config/v1", enabled: true } as never,
          harnessRoot,
          probeRoot,
          process.execPath,
          emptyKeepOutFacts(),
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, code: (err as { code?: string }).code };
      }
    };
    try {
      // LIVENESS FIRST: with no second name anywhere, this project compiles.
      // Without it the refusal below would be satisfied by a check that
      // refuses everything.
      expect(compile().ok, "a clean protected set must compile").toBe(true);

      linkSync(victim, link);
      // THE PLANT ASKS THE OWNER rather than re-deriving the verdict beside it.
      expect(hasSecondName(lstatSync(victim).nlink), "the plant must really create a second name").toBe(true);

      // THE CONCLUSION, with the SPECIFIC code.
      const planted = compile();
      expect(planted.ok).toBe(false);
      expect(planted.code).toBe("self_protection_protected_file_has_second_name");

      // …and removing it restores service, so this is a detection rather than
      // a one-way door.
      rmSync(link, { force: true });
      expect(compile().ok, "removing the second name must restore service").toBe(true);
      const liveAfter = lstatSync(live, { bigint: true });
      expect([liveAfter.nlink, liveAfter.ctimeNs], "the probe never touches the live harness's file").toEqual([liveBefore.nlink, liveBefore.ctimeNs]);
    } finally {
      rmSync(link, { force: true });
      rmSync(probeRoot, { recursive: true, force: true });
      rmSync(harnessRoot, { recursive: true, force: true });
      invalidateProtectedNameCheck();
    }
  });

  test("nothing CASTS its way past the resolved-path brand — the rung-3 claim's one exception", () => {
    // THE CEILING OF A BRAND, STATED AS A TEST RATHER THAN AS PROSE. The
    // floor's comparisons accept only `ResolvedAbsolutePath`, and the only way
    // to obtain one is the resolver — so an unresolved path at the comparison
    // is a compile error. Except through a cast: `("/" as unknown as
    // ResolvedAbsolutePath)` compiles and reaches the comparison. The module's
    // own note claims the shape is unreachable and did not record that.
    //
    // There is no such cast in either repository, and the point of this test is
    // that the absence is now MECHANICAL rather than a fact somebody once
    // checked. Both repositories are scanned, because the brand is exported and
    // the server is its other consumer.
    const casts: string[] = [];
    const brandCast = /\bas\s+unknown\s+as\s+ResolvedAbsolutePath\b|\bas\s+ResolvedAbsolutePath\b/;
    const scanned = [
      ...sourceFiles("server"),
      ...sourceFiles(join("engine", "src")),
    ];
    // POPULATION AS A RUNTIME NUMBER: both trees really were walked.
    expect(scanned.length, `files scanned for a brand cast: ${scanned.length}`).toBeGreaterThanOrEqual(400);
    for (const file of scanned) {
      if (!codeMentions(file, ["ResolvedAbsolutePath"])) continue;
      if (brandCast.test(strippedSource(file))) casts.push(relpath(file));
    }
    // The resolver itself performs the ONE legitimate cast — that is how the
    // brand is minted — so it is named rather than pattern-exempted.
    expect(
      casts.filter((f) => !f.endsWith("filesystem/path-identity.ts")),
      `a cast to the resolved-path brand skips the resolver: ${casts.join(", ")}`,
    ).toEqual([]);
    // LIVENESS: the minting cast really is there, so the detector is awake.
    expect(casts.some((f) => f.endsWith("filesystem/path-identity.ts"))).toBe(true);
    // PLANTED VIOLATION for the detector, in both spellings.
    expect(brandCast.test(`compare(x as unknown as ResolvedAbsolutePath, y);`)).toBe(true);
    expect(brandCast.test(`const p = raw as ResolvedAbsolutePath;`)).toBe(true);
    expect(brandCast.test(`const p = resolveLocation(raw, "x");`)).toBe(false);
  });

  test("a confined child may not be handed a descriptor this server opened", () => {
    // Landlock authorises at open(), not at read(): a file the unconfined
    // parent opened and passed down as an extra stdio entry is readable in
    // full inside the sandbox, whatever the ruleset says. Both real callers
    // pass only "ignore" and "pipe"; this is the assertion that a future one
    // cannot quietly pass a number.
    const plan = { kind: "unconfined", command: "/bin/true", args: [], reason: "test" } as const;
    let thrown: unknown;
    try {
      spawnPlanned(plan, { cwd: "/tmp", stdio: ["ignore", "pipe", "pipe", 3] as never });
    } catch (err) {
      thrown = err;
    }
    // The SPECIFIC type AND code, not a bare "it threw".
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError & { code: string }).code).toBe("invalid_confined_stdio");
    expect(String((thrown as Error).message)).toMatch(/already-open file descriptor/);
    // CLEAN CONTROL: the shapes both real callers use are not refused.
    const child = spawnPlanned(plan, { cwd: "/tmp", stdio: ["ignore", "pipe", "pipe"] });
    child.kill();
  });

  test("native captured planned reads retain Unicode, exits, bounds and an effective deadline", async () => {
    const cwd = createTempDir("planned-capture-");
    const plan = (source: string) => ({ kind: "unconfined", command: process.execPath,
      args: ["-e", source], reason: "native collector fixture" } as const);
    const options = { cwd, capture: true, timeout: 1000, stdio: ["ignore", "pipe", "pipe"] } as const;
    const capture = async (command: ReturnType<typeof plan>) => {
      const before = componentSnapshot();
      const pending = spawnPlanned(command, options);
      const live = componentSnapshot().filter((entry) => !before.some((prior) => prior.id === entry.id));
      const result = await pending;
      expect(live, "a captured command is registered while its native child is active").toHaveLength(1);
      expect(live[0]).toMatchObject({ kind: "command-child", label: "captured command", facts: { command: basename(command.command) } });
      expect(componentSnapshot(), "completed, failed and timed-out captures all retire their component").toEqual(before);
      return result;
    };
    const unicode = "snow 雪🙂";
    const completed = await capture(plan(`process.stdout.write(${JSON.stringify(unicode)});process.stderr.write("detail");process.exitCode=7`));
    expect(completed).toMatchObject({ status: 7, stdout: unicode, stderr: "detail" });
    expect(completed.error).toBeUndefined();
    const overflow = await capture(plan('process.stdout.write("x".repeat(2 * 1024 * 1024))'));
    expect(overflow.status).toBeNull();
    expect(overflow.error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" });
    const missing = await capture({ ...plan(""), command: join(cwd, "does-not-exist") });
    expect(missing.status).toBeNull();
    expect(missing.error).toMatchObject({ code: "ENOENT" });
    expect(() => spawnPlanned(plan(""), { ...options, stdio: [3] as never })).toThrow(ValidationError);
    // A real child installs a TERM handler. The fallback only cleans this
    // fixture's named PID if a broken deadline would otherwise strand it.
    const pidFile = join(cwd, "child.pid");
    let fallbackUsed = false;
    const cleanup = setTimeout(() => {
      fallbackUsed = true;
      if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
    }, 5000);
    try {
      const timedOut = await capture(plan(`process.on("SIGTERM",()=>{});require("node:fs").writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.stdout.write("armed");setInterval(()=>{},100)`));
      expect(timedOut.stdout, "the TERM handler was installed before the timeout").toBe("armed");
      expect(fallbackUsed, "the native deadline must terminate the direct child").toBe(false);
      expect(timedOut.status).toBeNull();
      expect(timedOut.error).toBeInstanceOf(Error);
      expect(timedOut.error).toMatchObject({ killed: true, signal: "SIGKILL", code: null });
    } finally { clearTimeout(cleanup); }
    for (const [stream, exit] of [["stdout", 0], ["stderr", 7]] as const) {
      const descendantPid = join(cwd, `${stream}-descendant.pid`);
      const descendantSource = `require("node:fs").writeFileSync(${JSON.stringify(descendantPid)},String(process.pid));process.${stream}.write("descendant-held");setInterval(()=>{},100)`;
      let descendantFallback = false;
      const descendantCleanup = setTimeout(() => {
        descendantFallback = true;
        if (existsSync(descendantPid)) process.kill(Number(readFileSync(descendantPid, "utf8")), "SIGKILL");
      }, 5000);
      try {
        const stdio = ["ignore", stream === "stdout" ? 1 : "ignore", stream === "stderr" ? 2 : "ignore"];
        const held = await capture(plan(`const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(descendantSource)}],{stdio:${JSON.stringify(stdio)}});child.unref();process.exit(${exit})`));
        expect(descendantFallback, "the existing deadline must close retained capture pipes").toBe(false);
        expect(held[stream]).toBe("descendant-held");
        expect(held.status, "the direct child's observed exit stays intact").toBe(exit);
        expect(held.error, `parent exit ${exit} cannot certify a descendant's truncated ${stream}`).toMatchObject({ name: "ServiceUnavailableError", code: "incomplete_process_capture" });
        expect(isProcessAlive(Number(readFileSync(descendantPid, "utf8"))), "capture completion does not claim descendant termination").toBe(true);
      } finally {
        clearTimeout(descendantCleanup);
        if (!descendantFallback && existsSync(descendantPid)) process.kill(Number(readFileSync(descendantPid, "utf8")), "SIGKILL");
      }
    }

  });

  test("this server's own source is a PROTECTED subtree, not merely an unmentioned one", () => {
    // `minimumProtectedSubtrees: ["src"]` is joined with the HARNESS root —
    // `engine/` since the monorepo assembly, a sibling checkout before it —
    // so `server/**` here, which holds the confinement owner and the tool
    // executor themselves, was in no protected subtree. It was denied only
    // by omission, and omission stops protecting the moment this repository
    // is the selected project.
    const root = webServerSourceRoot();
    expect(existsSync(join(root, "safety/landlock-runner.ts")), `${root} must be the directory this module lives in`).toBe(true);
    requireHost(hostCanCompile(), "a host that compiles a confinement spec (Landlock and the built guardian)");
    // THE CONSEQUENCE, driven: a project root that CONTAINS the protected
    // subtree is refused by the compiler rather than quietly allowed.
    const plan = withConfig(true, (cfg) =>
      probe(
        `const m = await import("./server/safety/landlock-runner.ts");
         console.log(JSON.stringify(m.prepareConfinedSpawn({ command: "ls", args: [], projectRoot: ${JSON.stringify(join(root, ".."))} })));`,
        cfg,
      ),
    ) as Record<string, unknown>;
    expect(plan.kind).toBe("refused");
    // The GUIDED form, not the compiler's vocabulary: a person who selected
    // the wrong folder must be told what to do about it.
    expect(plan.code).toBe("project_is_harness_source");
    expect(String(plan.message)).toMatch(/choose a different project folder/i);
    expect(String(plan.message)).not.toMatch(/allow-rule|subtree/i);
  });

  test("EVERY declared protected subtree is a real directory — a partial loss of the set is the silent one", () => {
    // WHY PER-NAME AND NOT PER-SET. The set used to be filtered through
    // `existsSync`, so renaming `src/` took it from four entries to three with
    // exit 0 and no warning. A floor on the TOTAL cannot see that: three is a
    // perfectly healthy-looking number. The only thing that can is a check on
    // each PART, so this asserts every declared name individually and names
    // the one that died.
    const repoRoot = dirname(webServerSourceRoot());
    // POPULATION DERIVED, NEVER TYPED: the count comes from the declaration
    // itself, so adding a subtree cannot leave this guard behind.
    expect(WEB_HARNESS_PROTECTED_SUBTREE_NAMES.length).toBeGreaterThan(0);
    for (const name of WEB_HARNESS_PROTECTED_SUBTREE_NAMES) {
      const path = join(repoRoot, name);
      expect(
        existsSync(path) && lstatSync(path).isDirectory(),
        `declared protected subtree ${JSON.stringify(name)} is not a directory at ${path} — the layout moved and the declaration did not; correct the declaration, do not make it optional`,
      ).toBe(true);
    }
    // The server's own directory is in the set unconditionally.
    const produced = webHarnessProtectedSubtrees();
    expect(produced).toContain(webServerSourceRoot());
    expect(produced.length).toBe(WEB_HARNESS_PROTECTED_SUBTREE_NAMES.length + 1);
  });

  test("the floor's bare subtree names and this repository's resolve to DIFFERENT real directories", () => {
    // ── THE FACT THE MONOREPO ASSEMBLY CREATED ──────────────────────────────
    //
    // Two declarations feed one Landlock mechanism, and both spell a subtree
    // `src`: the engine's floor (`minimumProtectedSubtrees`, resolved against
    // the HARNESS root) and this repository's list (resolved against the
    // REPOSITORY root). Until 2026-07-30 those roots were separate checkouts,
    // so the bare name could only mean one directory in each. The harness root
    // is now `engine/` INSIDE this tree, so the same word names two real
    // directories one level apart, and nothing mechanical said so.
    //
    // What this test refuses is not the repetition — both declarations are
    // correct — but the state in which the two sets stop being disjoint. The
    // compiler collects protected subtrees into a `Set`, so a collision is not
    // an error there: it is one directory protected where two were declared,
    // which is a PARTIAL loss of the protected set, and a partial loss is the
    // silent one (the same reason the `existsSync` filter above was removed).
    const engineRoot = realHarnessRoot();
    const repoRoot = dirname(webServerSourceRoot());
    // THE NESTING ITSELF, asserted: it is the premise of everything below, and
    // if the engine ever leaves this tree the reasoning has to be re-read.
    expect(
      engineRoot.startsWith(`${repoRoot}/`),
      `the harness root ${engineRoot} is expected inside this repository at ${repoRoot}`,
    ).toBe(true);

    const floor = ROOT_POLICY.selfProtection.minimumProtectedSubtrees.map((name) => join(engineRoot, name));
    const web = webHarnessProtectedSubtrees();
    // POPULATION, as runtime numbers — an empty side would make the
    // disjointness below true over nothing.
    expect(floor.length).toBeGreaterThan(0);
    expect(web.length).toBeGreaterThan(floor.length);
    for (const path of [...floor, ...web]) {
      expect(
        existsSync(path) && lstatSync(path).isDirectory(),
        `declared protected subtree ${path} is not a directory — correct the declaration, do not drop it`,
      ).toBe(true);
    }

    // ONE ANSWER PER DIRECTORY: the assembled set is exactly as large as its
    // parts, so nothing was absorbed by de-duplication.
    const assembled = [...floor, ...web];
    expect(
      new Set(assembled).size,
      `two declarations resolve to one directory: ${assembled.join(", ")}`,
    ).toBe(assembled.length);
    for (const path of floor) expect(web).not.toContain(path);

    // ── THE COLLISION, PLANTED, so the assertion above is about this tree and
    // not about a coincidence. Resolve the floor's OWN names against the
    // repository root — what a `HARNESS_CONFIG_PATH` pointed one directory too
    // high would produce — and the same bare name lands on this repository's
    // `src/`, which the web list already holds.
    const collided = ROOT_POLICY.selfProtection.minimumProtectedSubtrees.map((name) => join(repoRoot, name));
    expect(
      collided.some((path) => web.includes(path)),
      "the plant must actually collide, or the disjointness above is untested",
    ).toBe(true);

    // AND WHY THAT CANNOT SHIP: the floor's root is not free. The guardian
    // binary and the bundle are resolved against the SAME root; the guardian
    // must reproduce the sealed source tree's build stamp and the bundle is
    // pinned by sha256, so a root that is not the harness has no guardian (and
    // no sealed inputs) under it and self-protection fails closed instead of
    // protecting the wrong `src`. Measured here rather than asserted from the
    // comment.
    for (const relative of [
      ROOT_POLICY.selfProtection.binaryRelativePath,
      ROOT_POLICY.selfProtection.bundleRelativePath,
    ]) {
      expect(existsSync(join(engineRoot, relative)), `${relative} must exist under the harness root`).toBe(true);
      expect(
        existsSync(join(repoRoot, relative)),
        `${relative} must NOT exist under the repository root, or a wrong root would look like a harness`,
      ).toBe(false);
    }
  });

  test("a protected subtree that does not exist is CARRIED INTO THE SPEC, never dropped", () => {
    // THE MUTATION THIS EXISTS FOR: reinstating `.filter(existsSync)`. With
    // every real directory present, a size check agrees with the filtered and
    // the unfiltered version alike — so the plant is a name that CANNOT exist,
    // supplied from outside the subject and randomised so it cannot be
    // special-cased by literal.
    const absent = `no-such-subtree-${Math.random().toString(36).slice(2)}`;
    const repoRoot = dirname(webServerSourceRoot());
    const withPlant = webHarnessProtectedSubtrees([...WEB_HARNESS_PROTECTED_SUBTREE_NAMES, absent]);
    expect(
      withPlant,
      "a missing protected subtree must reach the guardian, which refuses; dropping it weakens the sandbox in silence",
    ).toContain(join(repoRoot, absent));
    expect(withPlant.length).toBe(WEB_HARNESS_PROTECTED_SUBTREE_NAMES.length + 2);
  });

  test("the guardian REFUSES a spec naming a protected subtree that is not there — measured, not assumed", () => {
    // The comment that justified the filter said naming a missing path "would
    // make the guardian refuse every spec". That refusal IS the enforcement,
    // and this drives the real binary rather than trusting either comment.
    const guardian = join(realHarnessRoot(), "guardian", "build", "harness-landlock-guardian");
    requireHost(existsSync(guardian), `the built guardian at ${guardian}`);
    const dir = createTempDir("protected-subtree-refusal-");
    const present = join(dir, "present");
    mkdirSync(present, { recursive: true });
    // The allow rule is a SIBLING: a rule containing a protected subtree is
    // itself refused (code 4) by the guardian's identity check.
    const work = join(dir, "work");
    mkdirSync(work, { recursive: true });
    const absent = join(dir, "absent");
    const spec = (subtrees: readonly string[]): string => {
      const path = join(dir, `spec-${subtrees.length}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          abi_version_hint: 0,
          handled_access_fs: ["READ_FILE", "WRITE_FILE", "READ_DIR"],
          allow_rules: [{ path: work, access: ["READ_FILE", "READ_DIR", "WRITE_FILE"] }],
          protected_subtrees: subtrees,
        }),
      );
      return path;
    };
    const run = (subtrees: readonly string[]): { status: number | null; stderr: string } => {
      const r = spawnSync(guardian, ["apply", "--spec", spec(subtrees), "--exec", "/bin/true"], {
        encoding: "utf8",
      });
      return { status: r.status, stderr: String(r.stderr ?? "") };
    };
    const missing = run([present, absent]);
    // THE SPECIFIC CODE AND MESSAGE, not "it failed": 4 is spec_invalid.
    expect(missing.status).toBe(4);
    expect(missing.stderr).toMatch(/protected_subtrees\[\d+\] does not exist/);
    // CLEAN CONTROL, same spec minus the absent name: validation is passed, so
    // 4 is a verdict on the missing path and not on the spec's shape. The
    // status is deliberately not pinned — whether `/bin/true` can be exec'd
    // under this ruleset is a property of the host, not of this invariant.
    expect(run([present]).status).not.toBe(4);
  });

  test("swapping the guardian's stamp for a same-size copy with the timestamp restored is RE-CHECKED", () => {
    // THE CACHE KEY IS THE GUARDIAN'S CONTENT AND ITS RECOMPUTED SOURCE STAMP,
    // and it was the binary's size and modification time — both of which an
    // attacker who can write the file can set. A replacement of the same length
    // with the timestamp restored produced the same key, so the process kept
    // answering "verified" for a binary it had never seen, and the trust anchor
    // (consulted only on a cache MISS) was never asked. The comment claimed a
    // stale answer was unreachable, which was true of waiting and not of
    // content.
    //
    // THE TAMPER EDITS THE EMBEDDED STAMP. Admission is now the reproducible
    // build stamp plus a denial probe, not the file digest, so the lie a
    // tampered binary would have to tell is a different stamp; a byte swap that
    // leaves the stamp intact AND still denies a protected read is the stated
    // residual of admission (guardian-binary.ts), not something this test can
    // distinguish. Planting the edited stamp keeps the arm about the cache AND
    // the stamp instead of about the old digest.
    requireHost(hostCanCompile(), "a host that compiles a confinement spec (Landlock and the built guardian)");
    const harness = createTempDir("probe-cache-harness-");
    const realGuardian = join(realHarnessRoot(), "guardian", "build", "harness-landlock-guardian");
    requireHost(existsSync(realGuardian), `the built guardian at ${realGuardian}`);
    mkdirSync(join(harness, "src"), { recursive: true });
    copyGuardianSealedInputs(realHarnessRoot(), harness);
    mkdirSync(join(harness, "guardian", "build"), { recursive: true });
    const guardian = join(harness, "guardian", "build", "harness-landlock-guardian");
    copyFileSync(realGuardian, guardian);
    const cfg = join(harness, "bridlewise.config.json");
    expect(atomicWriteFile(
      cfg,
      JSON.stringify({
        ...JSON.parse(read("engine/bridlewise.config.json")),
        selfProtection: { schemaVersion: "bridlewise-self-protection-config/v1", enabled: true },
      }),
      { createMode: 0o600 },
    ).success).toBe(true);

    const measured = probe(
      `const m = await import("./server/safety/landlock-runner.ts");
       const fs = await import("node:fs");
       const path = ${JSON.stringify(guardian)};
       const stamp = ${JSON.stringify(ROOT_POLICY.selfProtection.binaryStamp)};
       const before = m.selfProtectionStatus();
       // The swap an attacker who can write the file would perform: the SAME
       // number of bytes, and the timestamps put back exactly as they were.
       const st = fs.statSync(path);
       const bytes = fs.readFileSync(path);
       const at = bytes.indexOf(Buffer.from(stamp, "utf8"));
       if (at < 0) throw new Error("the embedded stamp literal was not found");
       bytes[at] = bytes[at] === 0x61 ? 0x62 : 0x61; // 'a' <-> 'b': still hex, still 64 chars
       fs.writeFileSync(path, bytes, { mode: st.mode });
       // The NUMERIC form: passing the Date objects rounds to whole
       // milliseconds and would leave a detectable difference, which would
       // make the old size-and-mtime key miss for the wrong reason.
       fs.utimesSync(path, st.atimeMs / 1000, st.mtimeMs / 1000);
       const swapped = fs.statSync(path);
       const after = m.selfProtectionStatus();
       console.log(JSON.stringify({
         beforeState: before.state,
         afterState: after.state,
         afterCode: after.code,
         sameSize: swapped.size === st.size,
         sameMtime: swapped.mtimeMs === st.mtimeMs,
       }));`,
      cfg,
    ) as Record<string, unknown>;

    // LIVENESS FOR THE ATTACK ITSELF: if the swap changed the size or the
    // timestamp, the old key would have missed for the wrong reason and this
    // would prove nothing.
    expect(measured.sameSize, "the replacement must be the same length").toBe(true);
    expect(measured.sameMtime, "the timestamp must be restored exactly").toBe(true);
    // LIVENESS FOR THE MEASUREMENT: it really was verified beforehand.
    expect(measured.beforeState).toBe("confined");
    // THE CONCLUSION: the second answer is a fresh measurement, and it refuses.
    expect(measured.afterState).toBe("unavailable");
    expect(measured.afterCode).toBe("binary_hash_mismatch");
  });
});

/** Whether this host can compile a spec at all (i.e. confinement is live). */
function hostCanCompile(): boolean {
  return withConfig(true, (cfg) => statusAndPlan(cfg).status).state === "confined";
}
