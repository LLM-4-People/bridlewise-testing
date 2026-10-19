// @vitest-environment node
/**
 * SD STALE-PROCESS RECONCILIATION — the owner test for the lifecycle
 * script's second sight.
 *
 * ── THE DEFECT THIS GUARDS ────────────────────────────────────────────────
 *
 * Measured on this machine: an orphaned `server/index.ts` with PPID 1
 * survived EVERY `node scripts/sd.mjs restart` for ~2.5h. The lifecycle
 * script killed by service port (5173/5174 via `ss`) and by pidfile
 * (`.dev/*.pid`) — and the orphan held NEITHER: it had been started as a
 * test child with `HARNESS_WEB_PORT=0`, so the kernel had assigned it an
 * ephemeral loopback port no source names, and the pidfiles of the current
 * tree never listed it. Ports and pidfiles both answer "what does the
 * CURRENT tree own"; neither answers "what did PREVIOUS trees leak".
 *
 * The fix is the reconciliation in `scripts/sd.mjs`: enumerate candidate
 * processes through /proc whose CWD IS THIS REPOSITORY and whose argv
 * matches the server-tree shapes the script itself starts, then classify
 * each candidate STALE when it is none of: a live pidfile pid, a descendant
 * of one, or the current owner of a service port. `status` reports stale
 * processes; `stop`/`start` terminate them after the normal shutdown.
 *
 * ── WHY THE CWD GATE IS THE SAFETY FLOOR ───────────────────────────────────
 *
 * This machine hosts other node work (editors, language servers, other
 * repositories). A pattern match on cmdline alone is a footgun pointed at
 * all of it; the reconciliation signals a process ONLY after its
 * /proc/<pid>/cwd has been read to BE this repository. That gate must run
 * BEFORE the pattern check (an unreachable gate is not a gate), and this
 * guard pins both the ordering and the wiring of the reconciliation into
 * every lifecycle command.
 *
 * ── WHAT IS DRIVEN, AND DELIBERATELY NOT DRIVEN ────────────────────────────
 *
 * The classifier and the argv matcher are PURE and driven here against
 * synthetic candidates (no real stale process is ever spawned by a test —
 * a test that leaks the leak class to prove the leak class would be its
 * own defect). The /proc enumeration itself is proven on the live machine
 * by the workflow (the `sd.mjs status` receipt), not re-proven here.
 */
import { describe, expect, test, afterAll, vi } from "vitest";
import { processIdentity, processIdentityRecord } from "../../engine/src/process/process-facts.ts";
import { execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";
import { readSourceView } from "../../engine/scripts/verification/source-view.ts";
import {
  SERVER_TREE_ARGV_SPECS,
  HARNESS_TOOL_ARGV_SPECS,
  argvMatchesServerTree,
  classifyArgv,
  classifyStaleProcess,
  livePidfilePids,
  censusProcesses,
  censusChainOf,
  censusProvenanceOf,
  servingTreeLine,
  bootBindingLine,
  bootServingVerdict,
  bootStderrTailMessage,
  posixShellQuoted,
  systemdRunLaunchCommand,
  serverLaunchEnvironment,
} from "../../scripts/sd-stale-classifier.ts";
// The census owner — the /proc enumeration + the pattern tables live there
// now (one census primitive consumed by sd.mjs AND the anatomy view); the
// re-exports above resolve to the same single owner.
import {
  classifyArgv as classifyArgvFromCensusOwner,
} from "../../server/observability/process-census.ts";

const REPO_ROOT = process.cwd();
// Repository source is read through the source-view door and matched in the
// codeWithStrings view: the arms below ask about REAL CODE (call ordering,
// call presence) whose subjects can sit inside quoted strings
// (a call's quoted arguments), and the view blanks comments while
// preserving offsets, so position/ordering assertions stay exact.
const SD_SOURCE = readSourceView(join(REPO_ROOT, "scripts/sd.mjs")).codeWithStrings();
// The wrong-tree arms below ask about call sites that live INSIDE template
// literals (the status print wraps the serving line in a template; the cwd
// read is one readlink of `/proc/${pid}/cwd`), so they read the view that
// keeps template interiors — the same precedent the engine runner's wiring
// guard uses for its template-literal subjects.
const SD_SOURCE_WITH_TEMPLATES = readSourceView(join(REPO_ROOT, "scripts/sd.mjs")).codeWithStringsAndTemplates();
const CENSUS_SOURCE = readSourceView(
  modulePathMatching("observability/process-census.ts"),
).codeWithStrings();

describe("sd.mjs stale-process reconciliation — the argv shapes of this repo's server tree", () => {
  test("every spec matches the real process shape it was derived from", () => {
    // The argv shapes are what sd.mjs's own tree starts, measured live:
    // dev-all + api + vite (npm-title wrapper, sh -c child, .bin, repo
    // modules) + the stdio MCP children the api server starts per the
    // harness config (the fixture + the npx filesystem chain) + the farm
    // children the map workers fork. The npm/sh wrapper shapes are the
    // MEASURED argv-title rewrites, not guesses: npm rewrites its wrapper
    // argv[0] to a display title, and the sh -c command string arrives as
    // one element with the quotes (and trailing args) baked in.
    const apiEntry = modulePathMatching("server/index.ts");
    const cases: ReadonlyArray<readonly string[]> = [
      ["node", "--experimental-strip-types", "scripts/dev-all.ts"],
      ["/usr/bin/node", "--experimental-strip-types", "scripts/dev-all.ts"],
      ["node", "--experimental-strip-types", apiEntry],
      ["node", "--experimental-strip-types", `${REPO_ROOT}/${apiEntry}`],
      ["npm exec vite"],
      ["sh", "-c", "\"vite\""],
      ["vite"],
      ["node", `${REPO_ROOT}/node_modules/.bin/vite`],
      ["node", `${REPO_ROOT}/node_modules/vite/bin/vite.js`],
      ["node", `${REPO_ROOT}/node_modules/@esbuild/linux-x64/bin/esbuild`, "--service"],
      ["node", "engine/test/mcp/fixtures/fake-mcp-server.mjs"],
      ["npm exec @modelcontextprotocol/server-filesystem ."],
      ["sh", "-c", "\"mcp-server-filesystem\" ."],
      ["mcp-server-filesystem"],
      ["node", "/home/example/.npm/_npx/a3241bba59c344f5/node_modules/.bin/mcp-server-filesystem", "."],
      ["node", "--experimental-strip-types", modulePathMatching("intelligence/farm-child.ts")],
    ];
    for (const argv of cases) {
      expect(
        argvMatchesServerTree(argv, REPO_ROOT),
        `a real server-tree process shape went undetected: ${argv.join(" ")}`,
      ).not.toBeNull();
    }
  });

  test("the matcher never claims a process this tree did not start", () => {
    // THE SAFETY FLOOR'S other half: a pattern that over-matches would make
    // the cwd gate the only protection and kill repo-cwd bystanders. The
    // bystanders below are the MEASURED neighbours on this machine — other
    // agents' MCP servers out of the shared npx cache, uv-spawned python
    // tools, editors' language servers, and another repo's same-named
    // files.
    const bystanders: ReadonlyArray<readonly string[]> = [
      ["node", `${REPO_ROOT}/node_modules/typescript/lib/tsserver.js`],
      ["node", `${REPO_ROOT}/node_modules/.bin/prettier`],
      ["node", "/other/repo/node_modules/.bin/vite"],
      ["node", "/other/repo/scripts/dev-all.ts"],
      ["node", "--experimental-strip-types", "/elsewhere/server/index.ts"],
      ["node", "playwright.config.ts"],
      ["node", "-e", "unrelated"],
      // The other agent's npx-cached MCP server family (measured live):
      // the title-rewritten npm wrapper, the sh child, and the watchdog
      // node child out of the SAME ~/.npm/_npx cache the harness uses —
      // the npx-suffix kind is value-scoped, so these must never match.
      ["npm exec chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222"],
      ["sh", "-c", "\"chrome-devtools-mcp\" --browser-url=http://127.0.0.1:9222"],
      ["node", "/home/example/.npm/_npx/15c61037b1978c83/node_modules/chrome-devtools-mcp/build/src/telemetry/watchdog/main.js", "--parent-pid=1"],
      // A forged title prefix ("npm exec @modelcontextprotocol/…-extra")
      // must not match the harness's package spec.
      ["npm exec @modelcontextprotocol/server-filesystem-extra"],
    ];
    for (const argv of bystanders) {
      expect(
        argvMatchesServerTree(argv, REPO_ROOT),
        `a bystander process shape was claimed for the server tree: ${argv.join(" ")}`,
      ).toBeNull();
    }
  });

  test("the spec list covers the shapes the tree starts — derived, not invented", () => {
    const values = SERVER_TREE_ARGV_SPECS.map((spec) => spec.value);
    const apiEntry = modulePathMatching("server/index.ts");
    expect(values, "the api server entry must be a spec").toContain(apiEntry);
    expect(values, "the dev-all orchestrator must be a spec").toContain("scripts/dev-all.ts");
    expect(values, "the stdio MCP fixture the api server starts must be a spec").toContain(
      "engine/test/mcp/fixtures/fake-mcp-server.mjs",
    );
    // vite appears four ways (the npm-title wrapper, the quoted sh -c
    // command string, the bare argv of a direct invocation, the .bin path)
    // plus its repo-modules self and esbuild service — all must stay specs
    // or a restart leaks the vite half of a previous tree.
    expect(values.filter((v) => v === "vite").length, "the bare vite argv must be a spec").toBe(1);
    expect(values, "the npm-title vite wrapper must be a spec").toContain("npm exec vite");
    expect(values, "the quoted sh -c vite command string must be a spec").toContain("\"vite\"");
    expect(values.some((v) => v.endsWith("/node_modules/.bin/vite")), "the vite bin path must be a spec").toBe(true);
    expect(values.filter((v) => v === "vite/" || v === "@esbuild/").length, "vite and esbuild under this repo's node_modules must be specs").toBe(2);
    // The tree's OTHER children, measured live — the farm child the map
    // workers fork, and the npx filesystem MCP chain (title wrapper,
    // quoted sh command string, bare argv, npx cache child).
    expect(values, "the intelligence farm child must be a spec").toContain(
      modulePathMatching("intelligence/farm-child.ts"),
    );
    expect(values, "the npm-title mcp filesystem wrapper must be a spec").toContain("npm exec @modelcontextprotocol/server-filesystem .");
    expect(values, "the quoted sh mcp filesystem command string must be a spec").toContain("\"mcp-server-filesystem\"");
    expect(values, "the bare mcp filesystem argv must be a spec").toContain("mcp-server-filesystem");
    expect(
      SERVER_TREE_ARGV_SPECS.filter((s) => s.kind === "npx-suffix" && s.value === "mcp-server-filesystem").length,
      "the npx-cache child spec is the one npx-suffix shape for this package",
    ).toBe(1);
  });

  test("the display-only harness-tool specs are never kill candidates", () => {
    // THE KILL/DISPLAY SPLIT. The trace CLI is an OPERATOR tool: the census
    // labels it (so the anatomy view is honest about what it sees) but
    // `argvMatchesServerTree` — the matcher the stale kill path consumes —
    // must return null for it, so an operator's live `node scripts/trace.ts
    // …` command can never be signalled by the lifecycle script, however
    // long it runs with this repo as its cwd.
    const traceArgv = ["node", "--experimental-strip-types", "scripts/trace.ts", "anatomy"];
    expect(argvMatchesServerTree(traceArgv, REPO_ROOT), "an operator tool must never be a kill candidate").toBeNull();
    const classification = classifyArgv(traceArgv, REPO_ROOT);
    expect(classification, "the census still labels the operator tool").not.toBeNull();
    expect(classification!.label).toBe("trace CLI");
    expect(classification!.scope).toBe("harness-tool");
    // The re-exported names and the census owner's own export are the SAME
    // function — the classifier file re-exports the single owner, it does
    // not carry a copy.
    expect(classifyArgv).toBe(classifyArgvFromCensusOwner);
    expect(HARNESS_TOOL_ARGV_SPECS.length, "the display-only table stays a declared, visible list").toBeGreaterThan(0);
  });
});

describe("sd.mjs stale-process reconciliation — the stale classifier", () => {
  const pidfilePids = [100, 200];
  const portPids = [300];

  test("a pidfile pid, a port owner, and their descendants are NOT stale", () => {
    const tree = new Map<number, number>([
      [110, 100], // child of a pidfile pid
      [111, 110], // grandchild of a pidfile pid
      [310, 300], // child of the port owner
    ]);
    const ppidOf = (pid: number): number | undefined => tree.get(pid);
    for (const pid of [100, 200, 300, 110, 111, 310]) {
      const verdict = classifyStaleProcess({ pid, pidfilePids, portPids, ppidOf });
      expect(verdict.stale, `pid ${pid} belongs to the live tree and must not be stale`).toBe(false);
    }
  });

  test("an orphan (PPID 1) and an unrelated tree's member ARE stale", () => {
    const tree = new Map<number, number>([
      [400, 1], // the orphan class this whole section exists for
      [410, 400], // its surviving child, still no live ancestor
      [500, 499], // a member of some unrelated process tree
    ]);
    const ppidOf = (pid: number): number | undefined => tree.get(pid);
    for (const pid of [400, 410, 500]) {
      const verdict = classifyStaleProcess({ pid, pidfilePids, portPids, ppidOf });
      expect(verdict.stale, `pid ${pid} is a leak from a previous tree and must be stale`).toBe(true);
    }
  });

  test("an unreadable ancestor chain is stale, not silently live", () => {
    // ppidOf returning undefined means /proc could not be read (the process
    // died mid-walk). The classifier must not treat a broken walk as proof
    // of ownership — deny by default.
    const verdict = classifyStaleProcess({
      pid: 600,
      pidfilePids,
      portPids,
      ppidOf: () => undefined,
    });
    expect(verdict.stale, "an unreadable ancestry must not be treated as live ownership").toBe(true);
  });

  test("the ancestor walk is bounded — a long chain to nowhere still settles", () => {
    // A cycle-free chain that never reaches an owned pid must terminate at
    // the hop bound, not walk forever (the classifier runs inline in the
    // lifecycle script; a walk that hangs would wedge `status` itself).
    let calls = 0;
    const ppidOf = (pid: number): number | undefined => {
      calls += 1;
      return pid + 1; // an endless chain
    };
    const verdict = classifyStaleProcess({ pid: 700, pidfilePids, portPids, ppidOf });
    expect(verdict.stale).toBe(true);
    expect(calls, "the walk must be bounded").toBeLessThanOrEqual(64);
  });
});

describe("sd.mjs stale-process reconciliation — the pidfile read", () => {
  test("live pidfile entries are returned and dead or malformed ones are dropped", () => {
    const dir = createTempDir("ch-sd-pidfiles-");
    try {
      // process.pid is live by construction; a huge pid is not.
      writeFileSync(join(dir, "parent.pid"), processIdentityRecord());
      writeFileSync(join(dir, "dead.pid"), processIdentityRecord({ pid: 99999999, startTime: null }));
      writeFileSync(join(dir, "junk.pid"), "not-a-pid");
      writeFileSync(join(dir, "notpid.txt"), processIdentityRecord());
      expect(livePidfilePids(dir)).toEqual([process.pid]);
      // Neither a RECYCLED pid (this pid with another start time names
      // another process) nor a bare pid (no identity at all) names this one.
      const others = join(dir, "others");
      mkdirSync(others);
      writeFileSync(join(others, "recycled.pid"), processIdentityRecord({ pid: process.pid, startTime: (processIdentity().startTime ?? 0) + 1 }));
      writeFileSync(join(others, "bare.pid"), String(process.pid));
      expect(livePidfilePids(others)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing pidfile directory is an empty list, not a crash", () => {
    const missing = join(createTempDir("ch-sd-pidfiles-"), "does-not-exist");
    expect(livePidfilePids(missing)).toEqual([]);
  });
});

describe("sd.mjs stale-process reconciliation — the safety gate and the wiring", () => {
  test("the cwd gate runs BEFORE the pattern check in the census enumeration, and sd.mjs re-applies it on the kill path", () => {
    // THE SAFETY FLOOR. The machine hosts other node work; a candidate is
    // only ever signalled after its cwd was read to BE this repository, and
    // the gate must be checked before any pattern is consulted (a gate that
    // runs after the pattern can be reordered away "for performance" and
    // nothing would red). The /proc walk lives in the census owner (one
    // enumeration, consumed by sd.mjs AND the anatomy view), so
    // the gate is pinned in BOTH layers: inside the census enumeration it
    // must still read cwd first, and sd.mjs's candidate filter must
    // re-apply `cwd === repoRoot` + the server-tree scope — the census may
    // LOOK at bystanders and operator tools; the kill path may not.
    const enumStart = CENSUS_SOURCE.indexOf("export async function censusProcesses");
    expect(enumStart, "censusProcesses must exist in the census owner").toBeGreaterThan(-1);
    const enumEnd = CENSUS_SOURCE.indexOf("export function censusRepoRoot");
    const body = CENSUS_SOURCE.slice(enumStart, enumEnd);
    const cwdRead = body.indexOf("workingDirectoryOf(pid)");
    const pattern = body.indexOf("classifyArgv(argv ?? [], repoRoot)");
    expect(cwdRead, "the census must read each process's cwd").toBeGreaterThan(-1);
    expect(pattern, "the census must consult the pattern owner").toBeGreaterThan(-1);
    expect(
      cwdRead < pattern,
      "the cwd read must come BEFORE the pattern check — a pattern match without the cwd gate " +
        "would signal processes this repository does not own",
    ).toBe(true);

    const filterStart = SD_SOURCE.indexOf("export async function repoServerTreeProcesses");
    expect(filterStart, "repoServerTreeProcesses must exist in scripts/sd.mjs").toBeGreaterThan(-1);
    const filterEnd = SD_SOURCE.indexOf("export async function staleServerProcesses");
    expect(filterEnd, "staleServerProcesses must exist in scripts/sd.mjs").toBeGreaterThan(filterStart);
    const filterBody = SD_SOURCE.slice(filterStart, filterEnd);
    expect(
      filterBody.includes('p.cwd === repoRoot && p.classification.scope === "server-tree"'),
      "the report's candidate filter must re-apply the cwd gate AND restrict to server-tree scope — " +
        "the census's bystander and harness-tool labels must never be named as this repo's stale servers",
    ).toBe(true);
  });

  test("every lifecycle command consults the reconciliation", () => {
    // Every command NAMES the orphans (KILL-OWNED-ONLY: none is stopped — no
    // record says this lifecycle started them). A command that forgets the
    // reconciliation is the 2.5h orphan again, invisible, in that door.
    for (const [command, call] of [
      ["status", "staleServerProcesses(REPO_ROOT)"],
      ["stop", "reportStaleProcesses(REPO_ROOT)"],
      ["start", "reportStaleProcesses(REPO_ROOT)"],
    ] as const) {
      const fnStart = SD_SOURCE.indexOf(`async function cmd${command[0]!.toUpperCase()}${command.slice(1)}(`);
      expect(fnStart, `cmd${command} must exist in scripts/sd.mjs`).toBeGreaterThan(-1);
      const nextFn = SD_SOURCE.indexOf("\nasync function cmd", fnStart + 1);
      const body = SD_SOURCE.slice(fnStart, nextFn === -1 ? undefined : nextFn);
      expect(
        body.includes(call),
        `cmd${command} must call ${call} — a lifecycle command without the reconciliation ` +
          `re-opens the orphan window it exists to close`,
      ).toBe(true);
    }
  });

  test("KILL-OWNED-ONLY: the script stops only what its own spawn records name (the orchestrator, then the recorded groups) — never a port holder or a scanned process (WF-1b3b design H1)", () => {
    // Stale processes are NAMED, never signalled: no terminate call anywhere
    // in the script but through the recorded-servers stop (dev-processes.ts).
    const start = SD_SOURCE.indexOf("export async function reportStaleProcesses");
    expect(start, "reportStaleProcesses must exist in scripts/sd.mjs").toBeGreaterThan(-1);
    expect(SD_SOURCE).not.toMatch(/\bterminate\(|killSystemdUnits|stopPortListeners|systemctl --user stop/u);
    const recorded = SD_SOURCE.slice(SD_SOURCE.indexOf("async function stopRecordedServers("), SD_SOURCE.indexOf("\n}\n", SD_SOURCE.indexOf("async function stopRecordedServers(")));
    expect(recorded).toContain("stopDevOrchestrator(REPO_ROOT)");
    expect(recorded).toContain("readDevPidfile(path)");
    expect(recorded).toContain("stopDevGroup(owned)");
    // No private signal, poll or process-list scrape anywhere in the script:
    // the `ps -ef | grep dev-all.ts` SIGKILL matched every checkout's
    // orchestrator on the machine (master's included).
    expect(SD_SOURCE).not.toMatch(/process\.kill\(|"SIGKILL"|\bps -ef\b|\bss -\w*p|\bpgrep\b|\blsof\b/u);
    const stop = SD_SOURCE.slice(SD_SOURCE.indexOf("async function cmdStop("), SD_SOURCE.indexOf("\nasync function cmd", SD_SOURCE.indexOf("async function cmdStop(") + 1));
    expect(stop).toContain("stopRecordedServers()");
    // A start with the ports still held by another run REFUSES (names them, exits), never takes them down.
    const startBody = SD_SOURCE.slice(SD_SOURCE.indexOf("async function cmdStart("), SD_SOURCE.indexOf("\nasync function cmd", SD_SOURCE.indexOf("async function cmdStart(") + 1));
    expect(startBody.indexOf("process.exit(1)")).toBeGreaterThan(startBody.indexOf("allServerPids().length > 0"));
  });
});

describe("sd.mjs status — the wrong-tree hazard is VISIBLE, not forensic", () => {
  // THE MEASURED INCIDENT: a drive/fix round restarted and got the PRODUCT
  // tree's server; every fix read as missing live until /proc spelunking
  // found the wrong cwd. `status` named pids and ports but never the TREE,
  // so the one discriminating fact was printed nowhere. The fix is a
  // per-pid serving line (the pure verdict lives in the classifier; the
  // live /proc read in sd.mjs), and these arms hold both halves.
  const THIS_TREE = "/home/example/bridlewise-testing";
  const OTHER_TREE = "/home/example/bridlewise";

  test("the serving line NAMES the tree explicitly — this tree, another tree, and the unreadable case each say what they are", () => {
    // THIS tree: the hazard's quiet shape — the line must carry the
    // "serving: <tree>" verdict the incident lacked.
    const own = servingTreeLine(1348005, THIS_TREE, THIS_TREE);
    expect(own, "the status line must name the tree it serves explicitly").toContain(`serving: ${THIS_TREE}`);
    expect(own).not.toContain("NOT THIS TREE");
    // ANOTHER tree: the incident's exact shape — both trees named, the
    // hazard stated, and the remedy in the line (a driver reading this in a
    // testing-worktree terminal must be told what to do, not left to
    // wonder why every fix reads as missing).
    const wrong = servingTreeLine(1348005, OTHER_TREE, THIS_TREE);
    expect(wrong).toContain(`serving: ${OTHER_TREE}`);
    expect(wrong).toContain("NOT THIS TREE");
    expect(wrong).toContain(THIS_TREE);
    expect(wrong).toContain("start from the tree you are working in");
    // UNREADABLE: absence is said, never guessed and never silently blank —
    // a dead pid between the port scan and the read must not print a
    // fabricated tree.
    const unreadable = servingTreeLine(1348005, null, THIS_TREE);
    expect(unreadable).toContain("serving:");
    expect(unreadable).toContain("unreadable");
    expect(unreadable).not.toContain(THIS_TREE);
    expect(unreadable).not.toContain(OTHER_TREE);
  });

  test("cmdStatus prints each running server pid's serving line from the /proc cwd read — the wiring, at the door that prints", () => {
    // The status command must DERIVE the tree from the process's cwd link
    // (the procfs owner's one readlink, never a process scrape) and hand it to the pure verdict —
    // a status that prints pids without their trees is the incident again.
    // readPidCwd is the one reader: the read must be in its body, and the
    // status call must pass its answer through to servingTreeLine.
    const readerStart = SD_SOURCE_WITH_TEMPLATES.indexOf("function readPidCwd(");
    expect(readerStart, "readPidCwd must exist in scripts/sd.mjs").toBeGreaterThan(-1);
    const readerEnd = SD_SOURCE_WITH_TEMPLATES.indexOf("\nfunction ", readerStart + 1);
    const readerBody = SD_SOURCE_WITH_TEMPLATES.slice(readerStart, readerEnd === -1 ? undefined : readerEnd);
    expect(
      readerBody.includes("workingDirectoryOf(pid)"),
      "readPidCwd must read the cwd through the one procfs owner (engine process-facts workingDirectoryOf) — a helper that scrapes ps or re-derives the cwd any other way is a second, drift-prone reader",
    ).toBe(true);
    const statusStart = SD_SOURCE_WITH_TEMPLATES.indexOf("async function cmdStatus(");
    expect(statusStart, "cmdStatus must exist in scripts/sd.mjs").toBeGreaterThan(-1);
    const statusEnd = SD_SOURCE_WITH_TEMPLATES.indexOf("\nasync function cmd", statusStart + 1);
    const statusBody = SD_SOURCE_WITH_TEMPLATES.slice(statusStart, statusEnd === -1 ? undefined : statusEnd);
    expect(
      statusBody.includes("servingTreeLine(pid, readPidCwd(pid), REPO_ROOT)"),
      "cmdStatus must print each running pid's serving line from the live /proc cwd read — a status that names pids but not their trees is the wrong-tree hazard hiding in plain sight",
    ).toBe(true);
  });
});

describe("sd.mjs start — the boot's operator-visible verdicts (the boot-refusal stderr tail, the tree binding)", () => {
  // THE MEASURED DEFECTS, both silent operator outcomes of a launch:
  // (1) a boot refused by a typed startup pin (a hand-edited weakening
  // section) failed the health check with "Server did NOT respond" and no
  // pointer to the quotable InputError sitting in the child's journal-bound
  // stderr — the operator staring at the terminal never saw the sentence
  // naming the refused value and the remedy; (2) the launch output named
  // no tree — an operator who started from the wrong tree served the other
  // tree's app while every gate judged theirs, and the one discriminating
  // fact was printed nowhere. The fix is three pure verdicts (the tail
  // message, the binding line, the post-launch serving verification) plus
  // the wiring at the doors that print; these arms hold both halves.
  const LOG = "/home/example/bridlewise-testing/.dev/boot.stderr.log";
  const THIS_TREE = "/home/example/bridlewise-testing";
  const OTHER_TREE = "/home/example/bridlewise";

  test("the boot-refusal stderr tail is bounded, sourced, and honest about absence", () => {
    // A boot log deeper than the bound keeps the LAST lines — a refusal
    // sentence and its stack sit at the tail of a boot log, never the head.
    const lines = Array.from({ length: 60 }, (_, i) => `noise ${i}`);
    lines.push("InputError: debug_redaction_required — the typed, quotable sentence");
    const msg = bootStderrTailMessage(lines.join("\n"), 30, LOG);
    expect(msg).toContain("last 30 of 61 lines");
    expect(msg).toContain(`full log: ${LOG}`);
    expect(msg.split("\n")[1], "the head was dropped; the oldest kept line is the first content line").toBe("  noise 31");
    // The dropped head stays dropped: "noise 30" survives only inside the
    // dropped prefix (no kept line contains it as a whole line).
    expect(msg).not.toContain("\nnoise 30\n");
    expect(msg).toContain("InputError: debug_redaction_required — the typed, quotable sentence");
    // A short refusal shows in full, counted honestly.
    const short = bootStderrTailMessage("InputError: a one-line refusal", 30, LOG);
    expect(short).toContain("last 1 of 1 lines");
    expect(short).toContain("InputError: a one-line refusal");
    // Absence is said, never guessed: an unreadable log is "not captured",
    // an empty one says the child wrote nothing — neither invents a
    // refusal, and both name the log path.
    expect(bootStderrTailMessage(null, 30, LOG)).toContain("not captured");
    expect(bootStderrTailMessage(null, 30, LOG)).toContain(LOG);
    for (const emptyText of ["", "\n", "  \n\n"]) {
      const empty = bootStderrTailMessage(emptyText, 30, LOG);
      expect(empty).toContain("empty");
      expect(empty).toContain(LOG);
      expect(empty).not.toContain("InputError");
    }
  });

  test("the boot binding line names the tree it will serve and the config that tree's server will load", () => {
    const line = bootBindingLine(THIS_TREE, `${THIS_TREE}/engine/bridlewise.config.json`);
    expect(line).toContain(`Boot binding: serving tree ${THIS_TREE}`);
    expect(line).toContain(`config: ${THIS_TREE}/engine/bridlewise.config.json`);
  });

  test("the post-launch serving verdict — verified on the invoked tree, refused on another, never guessed on an unreadable read", () => {
    const ok = bootServingVerdict(1348005, THIS_TREE, THIS_TREE);
    expect(ok.refused).toBe(false);
    expect(ok.line).toContain(`serving: ${THIS_TREE}`);
    expect(ok.line).toContain("verified");
    // The wrong-tree worst case: health answered from another tree's
    // process — the verdict REFUSES, and the line carries the serving
    // line's own vocabulary (both trees + the remedy).
    const wrong = bootServingVerdict(1348005, OTHER_TREE, THIS_TREE);
    expect(wrong.refused).toBe(true);
    expect(wrong.line).toContain(`serving: ${OTHER_TREE}`);
    expect(wrong.line).toContain("NOT THIS TREE");
    expect(wrong.line).toContain(THIS_TREE);
    expect(wrong.line).toContain("start from the tree you are working in");
    // An unreadable cwd is printed honestly and judged not a refusal —
    // absence is never a guessed tree and never a false all-clear; the
    // health check stays the liveness gate.
    const unreadable = bootServingVerdict(1348005, null, THIS_TREE);
    expect(unreadable.refused).toBe(false);
    expect(unreadable.line).toContain("unreadable");
  });

  test("cmdStart's wiring — the binding before the launch, the stderr capture, the tail on failure, the verification after health", () => {
    // The launch's subjects sit inside template literals (the per-line
    // prints), so the wiring reads the template-preserving view — the same
    // precedent the status arms above use.
    const fnStart = SD_SOURCE_WITH_TEMPLATES.indexOf("async function cmdStart(");
    expect(fnStart, "cmdStart must exist in scripts/sd.mjs").toBeGreaterThan(-1);
    const fnEnd = SD_SOURCE_WITH_TEMPLATES.indexOf("\nasync function cmd", fnStart + 1);
    const body = SD_SOURCE_WITH_TEMPLATES.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    // THE BINDING: printed from the boot's own cwd fact, BEFORE the launch.
    expect(body).toContain("bootBindingLine(BOOT_CWD, configPath)");
    expect(
      body.indexOf("bootBindingLine(BOOT_CWD, configPath)"),
      "the binding must print before the launch — an operator who started from the wrong tree reads it before a single gate runs",
    ).toBeLessThan(body.indexOf("systemd-run"));
    // THE STDERR CAPTURE: the boot log is truncated per launch and the
    // unit's stderr is redirected to it, so a health failure always has
    // THIS boot's stderr to point at.
    expect(body).toContain('writeFileSync(BOOT_STDERR_LOG, "")');
    expect(body).toContain("--property=StandardError=append:${BOOT_STDERR_LOG}");
    // THE TAIL ON FAILURE: the health-failure branch prints the bounded
    // tail before exiting non-zero — an exit that outruns the pointer
    // hides the refusal again.
    const failBranch = body.indexOf("Server did NOT respond to health check");
    expect(failBranch).toBeGreaterThan(-1);
    const tailCall = body.indexOf("bootStderrTailMessage(readBootStderr(), BOOT_STDERR_TAIL_LINES, BOOT_STDERR_LOG)");
    expect(tailCall, "the health failure must print the captured stderr tail").toBeGreaterThan(failBranch);
    expect(body.indexOf("process.exit(1)", tailCall)).toBeGreaterThan(tailCall);
    // THE VERIFICATION: after health, every running pid's tree is read
    // from /proc and verified against the boot's tree; a refusal exits.
    const healthCall = body.indexOf("if (checkHealth())");
    expect(
      body.indexOf("bootServingVerdict(pid, readPidCwd(pid), BOOT_CWD)"),
      "cmdStart must verify each running pid's serving tree after health — a launch that reports UP while serving another tree is the hazard at its worst",
    ).toBeGreaterThan(healthCall);
    expect(body).toContain("SERVING-TREE VERIFICATION REFUSED the boot");
  });

  test("a port holder is named with its serving tree, never stopped (KILL-OWNED-ONLY)", () => {
    // The ports are global: a server another tree started holds them for
    // that tree's run. The script names each holder's tree and stops none.
    const fnStart = SD_SOURCE_WITH_TEMPLATES.indexOf("function reportPortListeners()");
    expect(fnStart, "reportPortListeners must exist in scripts/sd.mjs").toBeGreaterThan(-1);
    const fnEnd = SD_SOURCE_WITH_TEMPLATES.indexOf("\n}\n", fnStart + 1);
    const body = SD_SOURCE_WITH_TEMPLATES.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(body).toContain("servingTreeLine(pid, readPidCwd(pid), BOOT_CWD)");
    expect(body).not.toMatch(/terminate|kill/u);
  });
});

describe("sd.mjs start — the launch command's shell quoting (the words systemd-run receives)", () => {
  // THE MEASURED DEFECT, latent only because this box's paths carry no
  // spaces: the launch hands execSync a command string, and execSync
  // executes that string through /bin/sh — so the string is re-parsed by
  // a shell before systemd-run ever sees the words. The unquoted join let
  // a space in the working directory, the stderr log, or a setenv value
  // (the API key, the auth password) split one intended argument into two
  // systemd-run arguments, or be shell-interpreted outright. The fix is
  // the pure command owner: every argument single-quoted before the join,
  // uniformly — the flags as deliberately as the paths.
  //
  // The drive below runs the EXACT command string through a real /bin/sh
  // (the same parser execSync uses) with systemd-run resolved to a probe
  // script that prints its own argv, so the argument list systemd-run
  // would receive is OBSERVED, not assumed. The probe lives in its own
  // temp dir, first on the child's PATH — the outer shell still performs
  // the whole parse under test.
  const probeDir = createTempDir("ch-sd-argv-probe-");
  const probePath = join(probeDir, "systemd-run");
  writeFileSync(probePath, "#!/bin/sh\nprintf '%s\\0' \"$@\"\n");
  chmodSync(probePath, 0o755);
  afterAll(() => { rmSync(probeDir, { recursive: true, force: true }); });

  const argvOf = (command: string): string[] => {
    const out = execSync(command, {
      encoding: "utf8",
      env: { ...process.env, PATH: `${probeDir}:${process.env.PATH ?? ""}` },
    });
    return out.split("\0").slice(0, -1);
  };

  test("every launch argument survives /bin/sh as ONE word — a space-carrying tree path, a setenv secret, an embedded single-quote", () => {
    const SPACE_TREE = "/scratch/my tree with spaces";
    const SECRET = "sk-with space and $dollar";
    const PASSWORD = "a value with 'single quotes' inside";
    // The quote-free base: driven through the parser BOTH quoted (the fix)
    // and bare (the witness below) — an unbalanced quote in the bare join
    // would kill the shell parse before the split could be observed, so the
    // embedded-quote value rides only the quoted drive.
    const baseArgs = [
      "--same-dir", "--collect", "--no-block",
      `--working-directory=${SPACE_TREE}`,
      `--setenv=HARNESS_API_KEY=${SECRET}`,
      `--property=StandardError=append:${SPACE_TREE}/.dev/boot.stderr.log`,
    ];
    const args = [
      ...baseArgs,
      `--setenv=HARNESS_WEB_AUTH_PASSWORD=${PASSWORD}`,
      "node", "--experimental-strip-types", "scripts/dev-all.ts",
    ];
    const observed = argvOf(systemdRunLaunchCommand(args));
    expect(observed).toEqual(["--user", ...args]);
    // The quoted spelling is the POSIX single-quote form: nothing inside
    // is left interpretable, and the embedded quote is the close-escape-
    // reopen splice. An empty argument is two adjacent quotes, never a
    // silently dropped word.
    expect(posixShellQuoted("plain")).toBe("'plain'");
    expect(posixShellQuoted("it's")).toBe("'it'\\''s'");
    expect(posixShellQuoted("")).toBe("''");
    // THE WITNESS — the defect this fix exists for, made visible in the
    // same parser: the UNQUOTED join splits the space-carrying working
    // directory into fragments and drops the unsplit form entirely, so a
    // green drive above is a real observation, never a vacuous pass.
    const bare = `systemd-run --user ${baseArgs.join(" ")}`;
    const bareObserved = argvOf(bare);
    expect(bareObserved).toContain("--working-directory=/scratch/my");
    expect(bareObserved).not.toContain(`--working-directory=${SPACE_TREE}`);
  });

  test("configured web paths survive the real launch parser and unrelated environment stays out", () => {
    const marker = join(probeDir, "unwanted-expansion");
    const database = `${probeDir}/data 'quoted' $HOME $(touch ${posixShellQuoted(marker)}) \`touch ${posixShellQuoted(marker)}\`.db`;
    const key = `${probeDir}/key home with spaces\nand a newline`;
    const configured = {
      HARNESS_WEB_DB_PATH: database,
      HARNESS_KEY_HOME: key,
      HARNESS_WEB_TIMELINE_DB_PATH: `${probeDir}/timeline.db`,
      HARNESS_CONFIG_PATH: `${probeDir}/config.json`,
      HARNESS_WEB_HOST: "",
      HARNESS_WEB_PORT: undefined,
      HARNESS_API_KEY: "a credential $with 'quotes'",
      PATH: "/bin:/usr/bin",
      HOME: "/home/example",
      UNRELATED_TOKEN: "unrelated secret",
      NODE_OPTIONS: "--require=unrelated",
      HARNESS_REJECT_HARDLINKS: "0",
      HARNESS_EVIDENCE_HOME: `${probeDir}/evidence`,
      XDG_DATA_HOME: `${probeDir}/data-home`,
      XDG_CACHE_HOME: `${probeDir}/cache-home`,
    };
    const selected = serverLaunchEnvironment(configured);
    // The private homes' boot settings reach the server from the ONE list (a relocated store stays the one kept out; design M5).
    for (const name of ["HARNESS_EVIDENCE_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const) expect(selected[name], `${name} reaches the server`).toBe(configured[name]);
    expect(selected.HARNESS_WEB_DB_PATH, "the configured projection database must reach the server").toBe(database);
    expect(selected.HARNESS_KEY_HOME, "the key home must reach the server unchanged").toBe(key);
    expect(selected.HARNESS_WEB_HOST).toBe("");
    expect(Object.hasOwn(selected, "HARNESS_WEB_PORT")).toBe(false);
    expect(selected.HARNESS_CONFIG_PATH).toBe(configured.HARNESS_CONFIG_PATH);
    expect(selected.HARNESS_WEB_TIMELINE_DB_PATH).toBe(configured.HARNESS_WEB_TIMELINE_DB_PATH);
    expect(selected.HOME).toBe(configured.HOME);
    for (const name of ["UNRELATED_TOKEN", "NODE_OPTIONS", "HARNESS_REJECT_HARDLINKS", "HARNESS_API_KEY"]) {
      expect(Object.hasOwn(selected, name), `${name} is unrelated to web configuration`).toBe(false);
    }
    const args = Object.keys(selected).map((name) => `--setenv=${name}`);
    expect(argvOf(systemdRunLaunchCommand(args))).toEqual(["--user", ...args]);
    expect(existsSync(marker), "shell metacharacters remain data").toBe(false);
    expect(SD_SOURCE_WITH_TEMPLATES).toContain("const ENV = serverLaunchEnvironment(process.env);");
    expect(SD_SOURCE_WITH_TEMPLATES, "names only: no value on a command line").toContain("Object.keys(ENV).map((name) => `--setenv=${name}`)");
    expect(SD_SOURCE_WITH_TEMPLATES, "no built-in credential").not.toMatch(/sk-[0-9a-f]{20,}|harness-test-2026/u);
    expect(SD_SOURCE_WITH_TEMPLATES).toContain("env: ENV");
    expect(SD_SOURCE_WITH_TEMPLATES).not.toContain("env: { ...process.env, ...ENV }");
    expect(SD_SOURCE_WITH_TEMPLATES).not.toContain('console.error("[sd] systemd-run failed:", err.message)');
  });

  test.each([
    ["systemd", undefined], ["systemd", ""], ["systemd", "custom"],
    ["fallback", undefined], ["fallback", ""], ["fallback", "custom"],
  ] as const)("actual cmdStart wiring: %s with credential %s", async (branch, credential) => {
    // Execute the actual CLI module with external effects intercepted. This
    // proves dispatch/ENV wiring; the workflow separately proves real serving.
    const argv = process.argv;
    const database = `${probeDir}/actual 'quoted' $literal.db`;
    const key = `${probeDir}/actual key home\nline`;
    const messages: unknown[][] = [];
    const launches: string[][] = [];
    const children: Array<{ env: Record<string, string> }> = [];
    const unref = vi.fn();
    const close = vi.fn();
    vi.resetModules();
    vi.stubEnv("HARNESS_API_KEY", credential);
    vi.stubEnv("HARNESS_WEB_AUTH_PASSWORD", credential);
    vi.stubEnv("HARNESS_WEB_DB_PATH", database);
    vi.stubEnv("HARNESS_KEY_HOME", key);
    vi.stubEnv("HARNESS_WEB_HOST", "");
    vi.stubEnv("UNRELATED_TOKEN", "caller-only-credential");
    vi.spyOn(console, "log").mockImplementation((...args) => { messages.push(args); });
    vi.spyOn(console, "error").mockImplementation((...args) => { messages.push(args); });
    vi.spyOn(process, "kill").mockImplementation(() => { throw new Error("wiring guard must never signal a process"); });
    vi.doMock("node:child_process", () => ({
      execSync: (command: string) => {
        if (command.startsWith("systemd-run ")) {
          launches.push(argvOf(command));
          if (branch === "fallback") throw Object.assign(new Error(`secret command: ${command}`), { status: 71 });
          return "";
        }
        if (command.startsWith("curl ")) return "200";
        throw new Error(`Unexpected external command: ${command}`);
      },
      spawn: (_command: string, _args: string[], options: { env: Record<string, string> }) => {
        children.push(options);
        return { unref };
      },
    }));
    vi.doMock("node:fs", async () => ({
      ...await vi.importActual<typeof import("node:fs")>("node:fs"),
      mkdirSync: vi.fn(), writeFileSync: vi.fn(), openSync: () => 73, closeSync: close,
      rmSync: () => { throw new Error("wiring guard must never remove a file"); },
    }));
    vi.doMock("../../scripts/vite-dep-cache.ts", () => ({ DEP_CACHE_DIR: "node_modules/.vite", staleDepCacheVerdict: () => null }));
    vi.doMock("../../scripts/served-module-probe.ts", () => ({ pollServedModule: () => ({ kind: "not-judged" }) }));
    vi.doMock("../../server/observability/process-census.ts", () => ({ censusProcesses: async () => [] }));
    // No listener on the service ports: the wiring drive never signals (the
    // listener answer is the process-facts owner's; the machine's real
    // listeners are not this test's).
    vi.doMock("../../engine/src/process/process-facts.ts", async () => ({
      ...await vi.importActual<typeof import("../../engine/src/process/process-facts.ts")>("../../engine/src/process/process-facts.ts"),
      processesListeningOn: () => [],
    }));
    vi.doMock("../../scripts/sd-stale-classifier.ts", () => ({
      classifyStaleProcess, livePidfilePids: () => [], servingTreeLine, bootBindingLine,
      bootServingVerdict, bootStderrTailMessage, systemdRunLaunchCommand, serverLaunchEnvironment,
    }));
    try {
      const entry = join(REPO_ROOT, "scripts/sd.mjs");
      process.argv = [process.execPath, entry, "start"];
      // Execute the selected JavaScript CLI entry for its side effects.
      // It has no typed exports for this TypeScript guard to consume.
      await import(entry);
      expect(launches, "the actual cmdStart must reach the launch boundary").toHaveLength(1);
      const setenv = launches[0]!.filter((word) => word.startsWith("--setenv="));
      // NAMES ONLY on the command line: systemd-run reads the values from its
      // own (inherited) environment, so no path or password is in /proc.
      expect(setenv.every((word) => !word.slice("--setenv=".length).includes("=")), `no value on the command line: ${setenv.join(" ")}`).toBe(true);
      const forwarded = new Set(setenv.map((word) => word.slice("--setenv=".length)));
      for (const name of ["HARNESS_WEB_DB_PATH", "HARNESS_KEY_HOME", "HARNESS_WEB_HOST"]) expect(forwarded.has(name), name).toBe(true);
      expect(forwarded.has("HARNESS_WEB_AUTH_PASSWORD"), "a set password is forwarded, an unset one is not invented").toBe(credential !== undefined);
      expect(forwarded.has("HARNESS_API_KEY"), "the dead provider-key variable is never forwarded").toBe(false);
      expect(forwarded.has("UNRELATED_TOKEN")).toBe(false);
      expect(launches[0]!.join(" "), "no built-in credential").not.toMatch(/sk-[0-9a-f]{20,}|harness-test-2026/u);
      if (branch === "fallback") {
        expect(children, "the failed systemd launch must actually dispatch the fallback").toHaveLength(1);
        expect(new Set(Object.keys(children[0]!.env)), "both branches receive the same selected caller environment").toEqual(forwarded);
        expect(children[0]!.env.HARNESS_WEB_DB_PATH).toBe(database);
        expect(unref).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledExactlyOnceWith(73);
        expect(messages.flat().join(" "), "raw command errors must not expose credentials").not.toContain("secret command:");
      } else {
        expect(children).toHaveLength(0);
        expect(close).not.toHaveBeenCalled();
      }
    } finally {
      process.argv = argv;
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
      for (const module of ["node:child_process", "node:fs", "../../scripts/vite-dep-cache.ts", "../../scripts/served-module-probe.ts", "../../server/observability/process-census.ts", "../../scripts/sd-stale-classifier.ts"]) vi.doUnmock(module);
      vi.resetModules();
    }
  });

  test("cmdStart's launch wires the pure command owner — no unquoted join remains at the launch site", () => {
    const fnStart = SD_SOURCE_WITH_TEMPLATES.indexOf("async function cmdStart(");
    expect(fnStart, "cmdStart must exist in scripts/sd.mjs").toBeGreaterThan(-1);
    const fnEnd = SD_SOURCE_WITH_TEMPLATES.indexOf("\nasync function cmd", fnStart + 1);
    const body = SD_SOURCE_WITH_TEMPLATES.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(body).toContain("execSync(systemdRunLaunchCommand(args)");
    expect(
      body.indexOf("args.join"),
      "a bare args.join at the launch site is the unquoted split this arm exists to refuse",
    ).toBe(-1);
  });
});

describe("the process census — the anatomy view's /proc walk (one enumeration, consumed by sd.mjs AND the view)", () => {
  test("the census shape: every entry carries pid, chain, start, classification, provenance, cpu and rss", async () => {
    // Live /proc, no CPU sampling (the shape is the arm, not the timing).
    const census = await censusProcesses(REPO_ROOT, { cpuSampleMs: 0 });
    expect(census.length, "this test process itself has the repo as cwd and must be in the census").toBeGreaterThan(0);
    for (const entry of census) {
      expect(entry.pid, "every census pid is a positive integer").toBeGreaterThan(0);
      expect(Array.isArray(entry.chain), "every entry carries a chain array").toBe(true);
      expect(entry.chain.length, "the chain walk is bounded").toBeLessThanOrEqual(64);
      expect(["server-tree", "harness-tool", "bystander"]).toContain(entry.classification.scope);
      expect(typeof entry.classification.label, "the classification label is a string").toBe("string");
      expect(["pidfile-owned", "descendant-of-server", "orphaned", "outside-tree"]).toContain(entry.provenance.kind);
      expect(typeof entry.provenance.detail, "the provenance says HOW it was classified").toBe("string");
      expect(entry.cpu, "with cpuSampleMs 0 no cpu sample is fabricated (null, never an invented zero)").toBeNull();
    }
    // THIS test process: repo cwd, vitest's argv — a bystander by every
    // pattern, and honest about it.
    const self = census.find((p) => p.pid === process.pid);
    expect(self, "the census must include the very process asking (no self-blindfold)").not.toBeUndefined();
    expect(self!.cwd).toBe(REPO_ROOT);
    expect(self!.classification.scope).toBe("bystander");
    expect(self!.classification.label).toBe("unrelated-bystander");
    expect(self!.provenance.kind).toBe("outside-tree");
    expect(self!.chain.length, "the self entry has a real ancestor chain").toBeGreaterThan(0);
  });

  test("the census includes known harness children even when their cwd differs", async () => {
    // A harness child whose cwd is NOT the repo must still appear (the
    // npx-cached MCP servers run out of ~/.npm/_npx); a bystander whose
    // cwd is not the repo must not. Pure classification over synthetic
    // shapes — no process is spawned to prove the leak class (the same
    // discipline as the rest of this file).
    const label = classifyArgv(
      ["node", "/home/example/.npm/_npx/a3241bba59c344f5/node_modules/.bin/mcp-server-filesystem", "."],
      REPO_ROOT,
    );
    expect(label, "an npx-cached harness child is classified by its argv, whatever its cwd").not.toBeNull();
    expect(label!.scope).toBe("server-tree");
    const stranger = classifyArgv(
      ["node", "/home/example/.cache/uv/archive-v0/aTrPU6sE1vJhUuu3/bin/kagimcp"],
      REPO_ROOT,
    );
    expect(stranger, "a bystander tool outside the repo's cwd is not a census candidate by argv").toBeNull();
  });

  test("censusChainOf walks to init, bounded, and stops at an unreadable hop", () => {
    // A synthetic facts map: 10 → 20 → 1(init). The chain names the
    // ancestors nearest-first and stops at init.
    const facts = new Map([
      [10, { ppid: 20, name: "child", starttimeTicks: 1, utimeTicks: 0, stimeTicks: 0 }],
      [20, { ppid: 1, name: "parent", starttimeTicks: 1, utimeTicks: 0, stimeTicks: 0 }],
    ]);
    const chain = censusChainOf(10, (pid) => facts.get(pid));
    expect(chain).toEqual([{ pid: 20, name: "parent" }]);
    // An endless chain settles at the bound, never hangs (the walk runs
    // inside sd.mjs status and the anatomy route). Two facts reads per hop
    // (cursor + parent), so the bound is 2×64 + 1.
    let calls = 0;
    const endless = censusChainOf(10, (pid) => {
      calls += 1;
      return { ppid: pid + 1, name: `p${pid}`, starttimeTicks: 1, utimeTicks: 0, stimeTicks: 0 };
    });
    expect(endless.length, "the chain walk must be bounded").toBeLessThanOrEqual(64);
    expect(calls).toBeLessThanOrEqual(129);
  });

  test("censusProvenanceOf derives how each process relates to the live tree", () => {
    const pidfiles = [100, 200];
    // The ancestor ppid tree + facts for EVERY hop the chain may touch —
    // the real census reads facts for all visible pids in pass 1, so the
    // pidfile-owned roots are facts-readable here too.
    const ppidTree = new Map<number, number>([
      [100, 1],   // pidfile-owned root (its parent is init)
      [110, 100], // child of a pidfile pid
      [111, 110], // grandchild
      [400, 1],   // the orphan class
    ]);
    type Facts = { ppid: number; name: string; starttimeTicks: number; utimeTicks: number; stimeTicks: number };
    const factsOf = (pid: number): Facts | undefined =>
      ppidTree.has(pid)
        ? { ppid: ppidTree.get(pid)!, name: `p${pid}`, starttimeTicks: 1, utimeTicks: 0, stimeTicks: 0 }
        : undefined;
    const serverTree = { label: "api server", scope: "server-tree" } as const;
    expect(censusProvenanceOf(100, censusChainOf(100, factsOf), serverTree, pidfiles).kind).toBe("pidfile-owned");
    expect(censusProvenanceOf(111, censusChainOf(111, factsOf), serverTree, pidfiles).kind)
      .toBe("descendant-of-server");
    // The orphan: a server-tree shape with no pidfile ancestor — the exact
    // leak class the stale reconciliation exists for, described in the view.
    const orphanVerdict = censusProvenanceOf(400, censusChainOf(400, factsOf), serverTree, pidfiles);
    expect(orphanVerdict.kind).toBe("orphaned");
    expect(orphanVerdict.detail).toContain("leak");
    // An operator tool and a bystander are outside the tree, not orphans.
    expect(censusProvenanceOf(500, [], { label: "trace CLI", scope: "harness-tool" }, pidfiles).kind).toBe("outside-tree");
    expect(censusProvenanceOf(600, [], { label: "unrelated-bystander", scope: "bystander" }, pidfiles).kind).toBe("outside-tree");
  });
});
