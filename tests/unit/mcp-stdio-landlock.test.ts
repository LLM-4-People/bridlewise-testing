// @vitest-environment node
/**
 * A stdio MCP server runs CONFINED — measured under the real guardian, from
 * inside the server process, against EVERY root the spec could grant.
 *
 * The test-drive finding this closes (B04): the shipped filesystem MCP server
 * ran unconfined, from the harness's working directory, with the harness's
 * whole environment, so `write_file` wrote into the harness's own tree. The
 * fix is structural — the MCP host starts every stdio server through the
 * confinement owner (`prepareConfinedSpawn`, purpose `mcp-server` →
 * `spawnPlanned`) with a harness-owned home as its ONLY writable root — and
 * this file measures the result rather than the wiring: the authority probe
 * fixture (`fs-probe-mcp-server.mjs`) tries each write and read itself and
 * reports the errno it got.
 *
 * THE ROOTS PROBED (sec-design C-1: "only writable root" was false while a
 * server also got its home's project-scratch folder, the per-spawn guardian
 * folder under the system temp directory and the operator's command
 * allow-rules):
 *   - its home, and its TMPDIR inside it — writable (liveness);
 *   - the project-scratch folder the owner derives for the home, the system
 *     temp directory, every live per-spawn guardian folder, an operator
 *     `additionalAllowRules` write rule, a project, the harness, the user's
 *     home — all EACCES;
 *   - `/dev` stays writable (the safety floor, not asserted here).
 * The environment is the MCP list (`tools.mcp.stdioInheritedEnv`) plus HOME
 * and TMPDIR — never `execute_command`'s allowlist, even when the operator
 * widened that list with a credential. Read paths are refused when they
 * overlap a write root (W^X, `tool_path_overlaps_writable`, for both
 * consumers) or a refused path (`read_path_refused`) — the compiler floor's
 * ONE policy, compared by IDENTITY: on WSL the distro root is also mounted at
 * `/mnt/wslg/distro`, and a read path spelled through that bind-mount alias
 * (`~/.ssh`, the harness state, the server's own writable home) is refused
 * like the direct spelling (secb-security SECB-V-1 reproduced this bypass).
 * A fake second checkout's `.bridlewise` holding a REGISTERED harness database
 * is refused too (the key home's registry, by identity — no name rule).
 *
 * HOST CREDENTIAL STORES (`~/.git-credentials`, `~/.config/gh`) are measured
 * unreachable from inside BOTH consumers — the server and a confined command
 * — with a content-free probe (`reach`: ok or the errno; no bytes returned).
 *
 * NETWORK EGRESS IS NOT RESTRICTED (Landlock is filesystem-only); it is not
 * probed here, and the security model says so.
 *
 * A CHILD PROCESS, like the confinement owner's own suite: `serverConfig`
 * resolves the harness config path once at import, and the harness root the
 * guardian lives in is derived from it — so the probe runs with a config that
 * sits BESIDE the real harness. When this host cannot confine (no guardian
 * build, a kernel without Landlock) the probe says so and the arm is skipped
 * with that reason; it never passes vacuously.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createTempDir } from "../helpers/temp-dir.ts";
import { harnessView, harnessViewConfig } from "../helpers/isolated-config.ts";
import { admitKeyHome, keyHomeLocation, registerHarnessStore } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { requireHost } from "../../engine/test/support/host-requirement.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HARNESS_ROOT = join(REPO_ROOT, "engine");
const FIXTURE = join(HARNESS_ROOT, "test", "mcp", "fixtures", "fs-probe-mcp-server.mjs");
const HARNESS_CHECKOUT = join(import.meta.dirname, "..", "..");
/** The server's own state folder (its database's, which the test setup puts in this worker's store): MCP homes live there. */
const SERVER_STATE = dirname(resolve(process.env.HARNESS_WEB_DB_PATH ?? ".bridlewise/web.db"));
const SERVER_ID = `landlock-probe-${process.pid}`;
const SECRET_READER_ID = `landlock-secret-${process.pid}`;
const WX_READER_ID = `landlock-wx-${process.pid}`;
const OTHER_CHECKOUT_ID = `landlock-checkout-${process.pid}`;
/** WSL's second mount of the distro root; the alias probes run where it exists. */
const WSL_ALIAS = "/mnt/wslg/distro";
const ALIAS_AVAILABLE = existsSync(join(WSL_ALIAS, homedir()));
const ALIAS_IDS = {
  ssh: `landlock-alias-ssh-${process.pid}`,
  state: `landlock-alias-state-${process.pid}`,
  wx: `landlock-alias-wx-${process.pid}`,
} as const;
/** Host credential stores no confined process may open (probed without reading a byte). */
const HOST_CREDENTIAL_PATHS = [join(homedir(), ".git-credentials"), join(homedir(), ".config", "gh")] as const;
/** Credentials planted in the harness's own environment; no MCP server may see them. */
const PLANTED_ENV = { GITHUB_TOKEN: "planted-github-token", OPENAI_API_KEY: "planted-openai-key" } as const;

type ProbeResult = Readonly<{
  skipped?: string;
  status?: string;
  lastError?: string | null;
  home?: string;
  cwd?: string;
  homeVar?: string;
  cwdIsHome?: boolean;
  homeVarIsHome?: boolean;
  env?: readonly string[];
  tmpdirVar?: string;
  writes?: Readonly<Record<string, string>>;
  readHome?: string;
  readOutside?: string;
  readResolver?: string;
  refusals?: Readonly<Record<string, Readonly<{ status: string; code: string | null; confinement: string | null; reason: string | null }>>>;
  commandToolPaths?: Readonly<Record<string, string>>;
  confinement?: string | null;
  hostCredentials?: Readonly<Record<string, Readonly<{ server: string; command: string }>>>;
  privateTemp?: Readonly<{ kind: string; stdout: string; stderr: string }>;
}>;

type Targets = Readonly<{ view: string; project: string; planted: string; operatorRule: string; harness: string; userHome: string; installDir: string; tempRoot: string; otherCheckout: string; aliasCheckout: string }>;

function runProbe(targets: Targets): ProbeResult {
  const config = JSON.parse(readFileSync(join(HARNESS_ROOT, "bridlewise.config.json"), "utf8")) as Record<string, Record<string, unknown>>;
  const server = (id: string, readPaths: readonly string[]) => ({
    id, transport: "stdio", command: process.execPath, args: [join(targets.installDir, "fs-probe-mcp-server.mjs")],
    readPaths, enabled: true, protocolVersion: "2025-11-25",
  });
  config["tools"]!["mcpServers"] = [
    server(SERVER_ID, [targets.installDir]),
    server(SECRET_READER_ID, [targets.installDir, join(homedir(), ".ssh")]),
    server(WX_READER_ID, [targets.installDir, join(SERVER_STATE, "mcp-home", WX_READER_ID)]),
    server(OTHER_CHECKOUT_ID, [targets.installDir, join(targets.otherCheckout, ".bridlewise")]),
    ...(ALIAS_AVAILABLE ? [
      server(ALIAS_IDS.ssh, [targets.installDir, join(WSL_ALIAS, homedir(), ".ssh")]),
      server(ALIAS_IDS.state, [targets.installDir, join(WSL_ALIAS, targets.aliasCheckout, ".bridlewise")]),
      server(ALIAS_IDS.wx, [targets.installDir, join(WSL_ALIAS, SERVER_STATE, "mcp-home", ALIAS_IDS.wx)]),
    ] : []),
  ];
  // An operator rule that widens what COMMANDS may write: it must not widen any MCP server.
  config["selfProtection"] = {
    schemaVersion: "bridlewise-self-protection-config/v1", enabled: true,
    additionalAllowRules: [{ path: targets.operatorRule, access: ["READ_FILE", "READ_DIR", "WRITE_FILE", "MAKE_REG"] }],
  };
  // Beside the harness it describes (the runner derives the harness root — and so the guardian — from the config
  // path), in a harness VIEW with a state folder of its own: never written into the live checkout, whose folder
  // identity every concurrent config reader verifies (tests/helpers/isolated-config.ts).
  const configPath = harnessViewConfig(targets.view, config);
  const script = `
    const { readdirSync, mkdirSync, rmSync, realpathSync } = await import("node:fs");
    const tempRoot = ${JSON.stringify(targets.tempRoot)};
    const { join } = await import("node:path");
    const bridge = await import("./server/integrations/mcp-runtime-bridge.ts");
    const runner = await import("./server/safety/landlock-runner.ts");
    const status = runner.selfProtectionStatus();
    if (status.state !== "confined") {
      console.log(JSON.stringify({ skipped: status.state + ": " + status.reason }));
    } else {
      const registry = await bridge.ensureMcpRuntimeStarted();
      const signals = registry.getServerSignals(${JSON.stringify(SERVER_ID)});
      const out = { status: signals.status, lastError: signals.lastError };
      if (signals.status === "connected") {
        const call = (tool, args) => bridge.callMcpTool(${JSON.stringify(`mcp__${SERVER_ID}__`)} + tool, args);
        out.home = runner.mcpServerHomeDir(${JSON.stringify(SERVER_ID)});
        out.cwd = await call("cwd", {});
        out.homeVar = await call("home", {});
        // Judged by identity while the home exists: it is spelled through the harness view (a link to the real
        // harness's folder), and the process's working directory is the kernel's canonical spelling of it.
        out.cwdIsHome = realpathSync(out.cwd) === realpathSync(out.home);
        out.homeVarIsHome = realpathSync(out.homeVar) === realpathSync(out.home);
        out.env = JSON.parse(await call("env", {}));
        out.tmpdirVar = out.home + "/.tmp";
        // The owner's project-scratch folder for this home, created from
        // OUTSIDE so a refusal is a permission answer, not ENOENT.
        const scratch = runner.projectScratchDir(out.home);
        mkdirSync(scratch, { recursive: true, mode: 0o700 });
        const spawnDirs = readdirSync(tempRoot).filter((name) => name.startsWith("harness-web-guardian-")).map((name) => join(tempRoot, name));
        // The listing also sees OTHER spawns' folders (every test file shares
        // the temp root), and one can be released between the listing and its
        // probe: ENOENT is a folder gone, not a folder written. Every folder
        // still there must refuse (EACCES), and at least one must be judged.
        const spawnCodes = await Promise.all(spawnDirs.map((dir) => call("write", { path: dir + "/escape.txt" })));
        const judgedSpawnCodes = spawnCodes.filter((code) => code !== "ENOENT");
        const writes = {
          home: await call("write", { path: out.home + "/probe.txt", content: "inside" }),
          tmpdir: await call("write", { path: out.tmpdirVar + "/probe.txt" }),
          projectScratch: await call("write", { path: scratch + "/escape.txt" }),
          systemTemp: await call("write", { path: join(tempRoot, "mcp-landlock-escape-${process.pid}.txt") }),
          spawnDirs: judgedSpawnCodes.every((code) => code === "EACCES") ? "EACCES" : "WRITABLE (" + spawnCodes.join(", ") + ")",
          spawnDirCount: String(judgedSpawnCodes.length),
          operatorRule: await call("write", { path: ${JSON.stringify(join(targets.operatorRule, "escape.txt"))} }),
          project: await call("write", { path: ${JSON.stringify(join(targets.project, "escape.txt"))} }),
          harness: await call("write", { path: ${JSON.stringify(targets.harness)} }),
          userHome: await call("write", { path: ${JSON.stringify(targets.userHome)} }),
        };
        out.writes = writes;
        rmSync(scratch, { recursive: true, force: true });
        out.readHome = await call("read", { path: out.home + "/probe.txt" });
        out.readOutside = await call("read", { path: ${JSON.stringify(targets.planted)} });
        // Host credential stores, from inside the server AND from a confined
        // command: "ok" or the errno only — no byte of a real store is read out.
        out.hostCredentials = {};
        for (const path of ${JSON.stringify(HOST_CREDENTIAL_PATHS)}) {
          const plan = runner.prepareConfinedSpawn({ command: "cat", args: [path], projectRoot: ${JSON.stringify(targets.project)} });
          let command = plan.kind;
          if (plan.kind === "confined") {
            const ran = await runner.spawnPlanned(plan, { cwd: ${JSON.stringify(targets.project)}, capture: true, timeout: 20_000 });
            plan.release();
            command = ran.status === 0 ? "READABLE" : /Permission denied/.test(ran.stderr) ? "EACCES" : /No such file/.test(ran.stderr) ? "ENOENT" : /Is a directory/.test(ran.stderr) ? "DIR" : "status:" + ran.status;
          }
          if (command === "DIR") {
            const listing = runner.prepareConfinedSpawn({ command: "ls", args: [path], projectRoot: ${JSON.stringify(targets.project)} });
            if (listing.kind === "confined") {
              const ran = await runner.spawnPlanned(listing, { cwd: ${JSON.stringify(targets.project)}, capture: true, timeout: 20_000 });
              listing.release();
              command = ran.status === 0 ? "READABLE" : /Permission denied/.test(ran.stderr) ? "EACCES" : "status:" + ran.status;
            }
          }
          out.hostCredentials[path] = { server: await call("reach", { path }), command };
        }
        out.readResolver = await call("read", { path: "/etc/resolv.conf" });
      }
      const live = await bridge.getLiveMcpServerSignals();
      const byId = new Map(live.map((s) => [s.id, s]));
      out.confinement = byId.get(${JSON.stringify(SERVER_ID)})?.confinement ?? null;
      out.refusals = Object.fromEntries(${JSON.stringify([SECRET_READER_ID, WX_READER_ID, OTHER_CHECKOUT_ID, ...Object.values(ALIAS_IDS)])}.map((id) => {
        const s = byId.get(id);
        return [id, { status: s?.status ?? "missing", code: s?.lastErrorCode ?? null, confinement: s?.confinement ?? null, reason: s?.confinementReason ?? null }];
      }));
      // W^X for the COMMAND consumer too: a tool path equal to the project,
      // or the system temp directory the per-spawn folder lives under.
      const refusedCode = (toolPaths) => {
        const plan = runner.prepareConfinedSpawn({ command: "ls", args: [], projectRoot: ${JSON.stringify(targets.project)}, toolPaths });
        if (plan.kind === "confined") plan.release();
        return plan.kind === "refused" ? plan.code : plan.kind;
      };
      out.commandToolPaths = { project: refusedCode([${JSON.stringify(targets.project)}]), systemTemp: refusedCode([tempRoot]) };
      // A PRIVATE TEMP FOLDER per confined command (secd-design M1): a harness
      // database registered under the system temp folder refuses nothing, the
      // child's TMPDIR/TMP/TEMP name its own per-spawn folder, a temp file
      // can be made there, and the system temp folder is not writable.
      {
        const plan = runner.prepareConfinedSpawn({ command: "sh", args: ["-c", 'f=$(mktemp) && echo "$TMPDIR|$TMP|$TEMP|$f"; touch "' + tempRoot + '/sece-private-temp-escape-$$" 2>/dev/null && echo ESCAPED || echo CONTAINED'], projectRoot: ${JSON.stringify(targets.project)} });
        if (plan.kind === "confined") {
          const ran = await runner.spawnPlanned(plan, { cwd: ${JSON.stringify(targets.project)}, capture: true, timeout: 20_000 });
          plan.release();
          out.privateTemp = { kind: plan.kind, stdout: ran.stdout.trim(), stderr: ran.stderr.trim() };
        } else {
          out.privateTemp = { kind: plan.kind, stdout: "", stderr: plan.kind === "refused" ? plan.code + ": " + plan.message : plan.reason };
        }
      }
      await bridge.stopAllMcpConnections({ final: true });
      console.log(JSON.stringify(out));
    }`;
  try {
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...PLANTED_ENV, HARNESS_CONFIG_PATH: configPath, HARNESS_WEB_SUBPROCESS_ENV_ALLOWLIST: "PATH,HOME,GITHUB_TOKEN" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 90_000,
    });
    const line = stdout.trim().split("\n").filter((l) => l.startsWith("{")).at(-1);
    if (line === undefined) throw new Error(`the probe printed no JSON:\n${stdout}`);
    return JSON.parse(line) as ProbeResult;
  } finally {
    rmSync(configPath, { force: true });
  }
}

describe("a stdio MCP server under the real guardian", () => {
  it("writes only its own home (and TMPDIR inside it): every other root the spec could grant is EACCES, and read paths are held to W^X and the refused roots", (context) => {
    const project = createTempDir("mcp-landlock-project-");
    const outside = createTempDir("mcp-landlock-outside-");
    const operatorRule = createTempDir("mcp-landlock-operator-rule-");
    // The server's install lives OUTSIDE the harness tree (a read path inside
    // it is refused), like a real pre-installed server.
    const installDir = createTempDir("mcp-landlock-install-");
    copyFileSync(FIXTURE, join(installDir, "fs-probe-mcp-server.mjs"));
    const planted = join(outside, "secret.txt");
    writeFileSync(planted, "must not be readable from inside the sandbox");
    // A second checkout nobody listed: its state folder holds a database key.
    const otherCheckout = createTempDir("mcp-landlock-other-checkout-");
    mkdirSync(join(otherCheckout, ".bridlewise"));
    writeFileSync(join(otherCheckout, ".bridlewise", "web.db"), "rows", { mode: 0o600 });
    const keyHome = admitKeyHome(keyHomeLocation(), []);
    registerHarnessStore(keyHome, join(otherCheckout, ".bridlewise", "web.db"));
    // The same, on the ROOT filesystem the WSL alias mirrors (the system temp
    // root is its own mount, invisible through the alias): a checkout-shaped
    // folder inside this checkout's own writable state folder.
    // A harness database registered UNDER THE SYSTEM TEMP FOLDER (a store opened there).
    const inTemp = createTempDir("mcp-landlock-store-in-temp-");
    writeFileSync(join(inTemp, "web.db"), "rows", { mode: 0o600 });
    registerHarnessStore(keyHome, join(inTemp, "web.db"));
    // The harness the server runs under: a view whose state folder is its own (the server's homes and scratch land there).
    const view = harnessView("mcp-landlock-harness-view-");
    const aliasCheckout = join(view, ".bridlewise", `landlock-alias-checkout-${process.pid}`);
    mkdirSync(join(aliasCheckout, ".bridlewise"), { recursive: true });
    writeFileSync(join(aliasCheckout, ".bridlewise", "web.db"), "rows", { mode: 0o600 });
    registerHarnessStore(keyHome, join(aliasCheckout, ".bridlewise", "web.db"));
    const escapes = {
      harness: join(view, `.mcp-landlock-escape-${process.pid}.txt`),
      userHome: join(homedir(), `.mcp-landlock-escape-${process.pid}.txt`),
    };
    let result: ProbeResult;
    try {
      // The system temp root, as the temp-dir owner places its folders there.
      result = runProbe({ view, project, planted, operatorRule, installDir, tempRoot: dirname(project), otherCheckout, aliasCheckout, ...escapes });
    } finally {
      rmSync(aliasCheckout, { recursive: true, force: true });
      // A write that got through must not be left behind — and it is
      // asserted below, so removing it here hides nothing.
      for (const path of Object.values(escapes)) rmSync(path, { force: true });
      rmSync(join(dirname(project), `mcp-landlock-escape-${process.pid}.txt`), { force: true });
    }
    requireHost(result.skipped === undefined, `a host that confines a stdio MCP server (it reported: ${String(result.skipped)})`);
    expect(result.status, `the confined server connected (last error: ${result.lastError})`).toBe("connected");
    // THE LIVE HARNESS IS UNTOUCHED: an MCP server's home lives in the SERVER's own state folder (its database's,
    // this test's own), never in a harness checkout's state root, so the live `engine/.bridlewise` gains none of it.
    expect(lstatSync(join(view, ".bridlewise")).isSymbolicLink(), "the view's state folder is its own").toBe(false);
    expect(existsSync(String(result.home)), "the server's home exists, in the server's own state folder").toBe(true);
    expect(String(result.home).startsWith(`${view}/`) || String(result.home).startsWith(`${HARNESS_CHECKOUT}/`), "the server's home is in no harness checkout").toBe(false);
    const liveHomes = [SERVER_ID, SECRET_READER_ID, WX_READER_ID, OTHER_CHECKOUT_ID, ...Object.values(ALIAS_IDS)]
      .filter((id) => existsSync(join(HARNESS_ROOT, ".bridlewise", "mcp-home", id)));
    expect(liveHomes, "no home of this run lands in the live harness's state folder").toEqual([]);
    expect(result.confinement, "the confinement state is a served signal").toBe("confined");
    // LIVENESS: the server really runs, in its home, and can use it.
    expect(result.cwdIsHome, `the server's working directory is its home (${String(result.cwd)} vs ${String(result.home)})`).toBe(true);
    expect(result.homeVarIsHome, `HOME is its home (${String(result.homeVar)} vs ${String(result.home)})`).toBe(true);
    expect(result.writes?.home).toBe("ok");
    expect(result.writes?.tmpdir, "TMPDIR is inside the home, so it adds no write root").toBe("ok");
    expect(result.readHome).toBe("ok:inside");
    // THE BOUNDARY, measured from inside — every root the spec could grant.
    expect(result.writes?.projectScratch, "no project-scratch folder for an MCP server").toBe("EACCES");
    expect(result.writes?.systemTemp, "the system temp directory is not writable").toBe("EACCES");
    expect(Number(result.writes?.spawnDirCount), "the server's own per-spawn guardian folder exists while it runs, so the probe is not vacuous").toBeGreaterThan(0);
    expect(result.writes?.spawnDirs, `no per-spawn guardian folder is writable (${result.writes?.spawnDirCount} probed)`).toBe("EACCES");
    expect(result.writes?.operatorRule, "an operator's command allow-rule does not widen an MCP server").toBe("EACCES");
    expect(result.writes?.project, "a project is not the server's to write").toBe("EACCES");
    expect(result.writes?.harness, "the harness's own tree is not writable").toBe("EACCES");
    // The test run's own confinement (decision TEST-CONFINEMENT-SELF-BIND) makes the user's home read-only to the
    // whole run, and the kernel answers EROFS before Landlock is asked: refused either way. Landlock's own refusal is
    // proven above on roots the run CAN write (the system temp, the project, the spawn folders).
    expect(["EACCES", "EROFS"], "the user's home is not writable").toContain(result.writes?.userHome);
    expect(result.readOutside, "a file outside every rule is not readable").toBe("EACCES");
    expect(existsSync(join(project, "escape.txt"))).toBe(false);
    expect(existsSync(join(operatorRule, "escape.txt"))).toBe(false);
    // Name resolution works from inside: the resolver file is readable even
    // where it is a link out of /etc (WSL: /mnt/wsl/resolv.conf), because the
    // floor grants its RESOLVED target. Without it a confined child has no DNS.
    if (existsSync("/etc/resolv.conf")) expect(result.readResolver?.startsWith("ok:"), `resolver read: ${result.readResolver}`).toBe(true);
    // The environment is the MCP list plus HOME and TMPDIR — never this
    // process's, and not execute_command's (which the operator widened with
    // GITHUB_TOKEN here). The guardian adds nothing: no "already confined"
    // sentinel (a sandbox decision is measured, never read from env).
    const allowed = new Set(["PATH", "LANG", "LC_ALL", "TZ", "TERM", "USER", "LOGNAME", "SHELL", "HOME", "TMPDIR", "TMP", "TEMP"]);
    expect((result.env ?? []).filter((name) => !allowed.has(name)), "only the MCP list reaches the server").toEqual([]);
    expect(result.env).toContain("TMPDIR");
    for (const planted of Object.keys(PLANTED_ENV)) expect(result.env).not.toContain(planted);
    // READ PATHS: a secret directory, and a path the server may write.
    expect(result.refusals?.[SECRET_READER_ID]).toEqual({ status: "error", code: "mcp_spawn_refused", confinement: "refused", reason: "read_path_refused" });
    expect(result.refusals?.[WX_READER_ID]).toEqual({ status: "error", code: "mcp_spawn_refused", confinement: "refused", reason: "tool_path_overlaps_writable" });
    // Any checkout's registered database: a state folder no config listed is refused.
    expect(result.refusals?.[OTHER_CHECKOUT_ID]).toEqual({ status: "error", code: "mcp_spawn_refused", confinement: "refused", reason: "read_path_refused" });
    // W^X for commands as well: one check at the owner.
    expect(result.commandToolPaths).toEqual({ project: "tool_path_overlaps_writable", systemTemp: "tool_path_overlaps_writable" });
    // THE BIND-MOUNT ALIAS (SECB-V-1): the same directories by another spelling.
    if (ALIAS_AVAILABLE) {
      expect(result.refusals?.[ALIAS_IDS.ssh], "~/.ssh through /mnt/wslg/distro").toEqual({ status: "error", code: "mcp_spawn_refused", confinement: "refused", reason: "read_path_refused" });
      expect(result.refusals?.[ALIAS_IDS.state], "a checkout's registered database through the alias").toEqual({ status: "error", code: "mcp_spawn_refused", confinement: "refused", reason: "read_path_refused" });
      expect(result.refusals?.[ALIAS_IDS.wx], "the writable home through the alias (W^X)").toEqual({ status: "error", code: "mcp_spawn_refused", confinement: "refused", reason: "tool_path_overlaps_writable" });
    }
    // A PRIVATE TEMP FOLDER per confined command, with a store kept under /tmp.
    expect(result.privateTemp?.kind, `the command ran confined (${result.privateTemp?.stderr})`).toBe("confined");
    const [tmpdirVar, tmpVar, tempVar, made] = (result.privateTemp?.stdout.split("\n")[0] ?? "").split("|");
    expect(tmpdirVar?.startsWith(join(dirname(project), "harness-web-guardian-")), `TMPDIR is the per-spawn folder: ${tmpdirVar}`).toBe(true);
    expect([tmpVar, tempVar]).toEqual([tmpdirVar, tmpdirVar]);
    expect(made?.startsWith(`${tmpdirVar}/`), `mktemp made its file in the private folder: ${made}`).toBe(true);
    expect(result.privateTemp?.stdout).toContain("CONTAINED");
    // HOST CREDENTIAL STORES: unreachable from inside both consumers (or absent on this host).
    for (const path of HOST_CREDENTIAL_PATHS) {
      const measured = result.hostCredentials?.[path];
      expect(measured, `${path} was probed`).toBeDefined();
      expect(["EACCES", "ENOENT"], `${path} from the confined server`).toContain(measured!.server);
      expect(["EACCES", "ENOENT"], `${path} from a confined command`).toContain(measured!.command);
    }
  });
});
