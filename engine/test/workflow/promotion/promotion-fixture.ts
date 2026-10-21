/**
 * THE PROMOTION FIXTURE — a real git repository per test (under the test
 * temp root: it honours TMPDIR), with a SOURCE branch `dev` and a TARGET
 * branch `prod`: never `testing`/`master`, so every test proves the primitive
 * names no branch of its own (merge-door-final §17.1, T-G4).
 *
 * `prod` starts as the product: `product/` (an entry with a relative import,
 * a glob import, a `new URL` worker, a stylesheet `@import` and a declared
 * spawn call), `product/lib/README.md`, a binary asset, a symlink and an
 * executable, `package.json` with a hand-written lockfile v3 (with `bin` maps,
 * one of them an `npm:` alias's), and a root README. `dev` branches from it
 * and adds what never ships: `dev/` (excluded), its README, a dev script and
 * devDependency, and the profile `promotion/dev-to-prod.json`.
 *
 * The command registry is the fixture's own: `lockfile` runs `lock.mjs` (a
 * deterministic lock from the manifest; a marker file makes it answer like an
 * npm cache miss, counting its attempts), `gate` runs `gate.mjs` (it passes
 * unless a marker names another mode). No npm, no network.
 *
 * A LANDING fixture (`{ landing: true }`, the build-and-commit stage) adds
 * what a candidate settles and commits: `setup` (`setup.mjs`: an ignored
 * build output, each run recorded; markers: a stray untracked file, a
 * failure), `gen` (`gen.mjs`: the generated output `gen/pin.txt`, the digest
 * of `product/`, and the pin of the hand-authored `tool/policy.ts` when it
 * exists; markers: oscillate, drift — a new value every pass, never
 * repeating —, write an undeclared path), the gate's modes (exit 1,
 * sleep past its ceiling with a child and a detached grandchild, report
 * ENOSPC, kill itself, write a tracked file, print its temp folder), a
 * config document `tool/bridlewise.config.json` (the candidate's engine
 * folder is `tool`), and the repository's own `pre-commit` hook
 * (`core.hooksPath` = `.githooks`), which records every checkout it ran in
 * and refuses while a marker exists.
 *
 * A PUBLICATION fixture adds the target's world: `{ remote: true }` a bare
 * remote `origin` (the profile's remote) holding both branches;
 * `{ targetCheckout: true }` a linked worktree W holding `prod` (the
 * repository's own checkout holds `dev`), where commits on `prod` are made.
 * {@link fixtureView} rebuilds the configuration and the plan of an existing
 * fixture (the crash test's child process runs a promotion over it).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { deepFreeze } from "../../../src/kernel/integrity.ts";
import type { WorkspaceIsolationConfig } from "../../../src/kernel/config-contracts.ts";
import { commitTreeReader, type GitRepository } from "../../../src/git/tree-reader.ts";
import { configuredGitRepository } from "../../../src/git/worktree-port.ts";
import type { PromotionDocument } from "../../../src/workflow/promotion/context.ts";
import { ensurePrivateStateDirectory } from "../../../src/filesystem/private-state.ts";
import { repositoryRegistry, repositoryRegistryArea } from "../../../src/workflow/repository-registry.ts";
import { loadPromotionProfiles, type LoadedPromotionProfile } from "../../../src/workflow/promotion/profile.ts";
import { planPromotion, type PromotionPlan } from "../../../src/workflow/promotion/projection.ts";
import { testProcessSupervisorBinary } from "../../../guardian/build.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";

export const SOURCE = "dev";
export const TARGET = "prod";
export const PROFILE_NAME = "dev-to-prod";
export const PROFILE_DIRECTORY = "promotion";
export const PROFILE_PATH = `${PROFILE_DIRECTORY}/${PROFILE_NAME}.json`;

/** A 1×1 PNG: bytes no UTF-8 round trip survives. */
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

/**
 * The deterministic lockfile the fixture's `lockfile` command writes: the
 * manifest's declared packages, each kept from the source lock. One function:
 * the command runs its source text, and the fixture computes the target's
 * initial lockfile with it.
 */
function lockOf(manifest: Readonly<Record<string, unknown>>, lock: Readonly<{ packages: Readonly<Record<string, unknown>> }>): string {
  const dependencies = (manifest["dependencies"] ?? {}) as Record<string, string>;
  const devDependencies = (manifest["devDependencies"] ?? {}) as Record<string, string>;
  const packages: Record<string, unknown> = { "": { name: manifest["name"], dependencies, devDependencies } };
  for (const name of Object.keys({ ...dependencies, ...devDependencies }).sort()) packages[`node_modules/${name}`] = lock.packages[`node_modules/${name}`] ?? { version: "0.0.0" };
  return `${JSON.stringify({ name: manifest["name"], lockfileVersion: 3, requires: true, packages }, null, 2)}\n`;
}

const LOCK_SCRIPT = `import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(new URL(import.meta.url).pathname);
const attempts = join(here, "attempts");
writeFileSync(attempts, String(Number(existsSync(attempts) ? readFileSync(attempts, "utf8") : "0") + 1));
if (existsSync(join(here, "enotcached"))) { console.error("npm error code ENOTCACHED"); process.exit(1); }
if (existsSync(join(here, "broken"))) { console.error("npm error code ERESOLVE: no matching version"); process.exit(1); }
const lockOf = ${lockOf.toString()};
writeFileSync("package-lock.json", lockOf(JSON.parse(readFileSync("package.json", "utf8")), JSON.parse(readFileSync("package-lock.json", "utf8"))));
`;

const GATE_SCRIPT = `import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(new URL(import.meta.url).pathname);
appendFileSync(join(here, "gate-runs"), "run\\n");
const mode = existsSync(join(here, "gate-mode")) ? readFileSync(join(here, "gate-mode"), "utf8").trim() : "pass";
if (mode === "exit1") { console.error("gate: a real defect in the tree"); process.exit(1); }
if (mode === "enospc") { console.error("Error: ENOSPC: no space left on device, write"); process.exit(1); }
if (mode === "kill") process.kill(process.pid, "SIGKILL");
if (mode === "write") writeFileSync(join("product", "lib", "helper.ts"), "export const helper = 2;\\n");
if (mode === "tmpdir") writeFileSync(join(here, "gate-tmpdir"), process.env.TMPDIR ?? "(unset)");
if (mode === "sleep") {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  const detached = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  writeFileSync(join(here, "gate-pids"), [child.pid, detached.pid].join(" "));
  setTimeout(() => {}, 60_000);
}
`;

const SETUP_SCRIPT = `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(new URL(import.meta.url).pathname);
appendFileSync(join(here, "setup-runs"), process.cwd() + "\\n");
if (existsSync(join(here, "setup-fail"))) { console.error("setup: the build tool is broken"); process.exit(1); }
mkdirSync("build", { recursive: true });
writeFileSync(join("build", "out.txt"), "built\\n");
if (existsSync(join(here, "setup-untracked"))) writeFileSync("stray.txt", "left behind\\n");
`;

const GEN_SCRIPT = `import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const here = dirname(new URL(import.meta.url).pathname);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]).sort();
const digest = createHash("sha256");
for (const file of walk("product")) { digest.update(file); digest.update(readFileSync(file)); }
let pin = digest.digest("hex");
if (existsSync(join(here, "gen-oscillate"))) {
  const counter = join(here, "gen-count");
  const count = Number(existsSync(counter) ? readFileSync(counter, "utf8") : "0") + 1;
  writeFileSync(counter, String(count));
  pin = pin + "-" + String(count % 2);
}
if (existsSync(join(here, "gen-drift"))) {
  const counter = join(here, "gen-count");
  const count = Number(existsSync(counter) ? readFileSync(counter, "utf8") : "0") + 1;
  writeFileSync(counter, String(count));
  pin = pin + "-" + String(count);
}
mkdirSync("gen", { recursive: true });
writeFileSync(join("gen", "pin.txt"), pin + "\\n");
const policy = join("tool", "policy.ts");
if (existsSync(policy)) writeFileSync(policy, readFileSync(policy, "utf8").replace(/PIN = "[^"]*"/u, 'PIN = "' + pin + '"'));
if (existsSync(join(here, "gen-undeclared"))) writeFileSync(join("product", "undeclared.txt"), "not declared\\n");
`;

/** The generated outputs of a landing fixture's tree (what `gen` may write): a wholly generated file, and a hand-authored module whose pin `gen` re-derives. */
export const FIXTURE_GENERATED: ReadonlySet<string> = deepFreeze(new Set(["gen/pin.txt", "tool/policy.ts"]));
/** The landing fixture's engine folder (its config document's place). */
export const FIXTURE_ENGINE = "tool";

export type FixtureProfileOverrides = Readonly<Record<string, unknown>>;

/** The profile the fixture declares (merged with `overrides` at the top level, `boundary` merged one level down). */
export function fixtureProfile(overrides: FixtureProfileOverrides = {}): Record<string, unknown> {
  const boundary = {
    entryPoints: ["product/main.ts"],
    include: [".gitignore", "assets/", "product/run.sh", "product/link.ts", "package.json", "package-lock.json"],
    exclude: ["dev/", "promotion/"],
    companions: ["README.md"],
    spawnCalls: [{ callee: "runScript", argument: 1, base: "product/" }],
    overlay: null,
    ...(overrides["boundary"] as object | undefined),
  };
  return {
    schema: "bridlewise-promotion-profile/v1",
    name: PROFILE_NAME,
    source: { ref: `refs/heads/${SOURCE}` },
    target: { ref: `refs/heads/${TARGET}` },
    remote: null,
    trigger: "manual",
    transforms: [
      { kind: "package-manifest", path: "package.json", scripts: ["build", "check"] },
      { kind: "lockfile", path: "package-lock.json", manifest: "package.json", command: "lockfile" },
    ],
    phases: { setup: [], converge: [], verify: ["gate"] },
    safety: { maxDeletedFraction: 0.5 },
    ...overrides,
    boundary,
  };
}

const PRODUCT_FILES: Readonly<Record<string, string>> = {
  "README.md": "# fixture product\n",
  ".gitignore": "node_modules/\n",
  "product/main.ts": [
    'import { helper } from "./lib/helper.ts";',
    'import "./styles.css";',
    'import { z } from "zod";',
    "// import { never } from \"./not-an-edge.ts\"; — a comment names no edge",
    'const prose = "import { never } from \'./not-an-edge-either.ts\'";',
    'const pages = import.meta.glob("./pages/*.ts");',
    'const worker = new URL("./worker.ts", import.meta.url);',
    'const home = new URL("../", import.meta.url);',
    "declare function runScript(root: string, script: string): void;",
    'runScript(home.pathname, "tools/gen.ts");',
    "export const value = [helper, pages, worker, z, prose];",
    "",
  ].join("\n"),
  "product/lib/helper.ts": "export const helper = 1;\n",
  "product/lib/README.md": "# lib\n\nRun `npm run build`.\n",
  "product/pages/a.ts": "export const a = 1;\n",
  "product/worker.ts": "export {};\n",
  "product/styles.css": "/* @import \"./not-imported.css\"; */\n@import \"./base.css\";\n",
  "product/base.css": "body { margin: 0; }\n",
  "product/tools/gen.ts": "export {};\n",
  "product/run.sh": "#!/bin/sh\necho run\n",
};

/** The SOURCE's manifest: a dev script and devDependency, an `npm:` alias providing `tsc` beside the real owner. */
export const SOURCE_MANIFEST = deepFreeze({
  name: "fixture",
  version: "1.0.0",
  scripts: { build: "vite build", check: "npm run build && tsc --noEmit", test: "node dev/tool.ts" },
  dependencies: { zod: "^1.0.0" },
  devDependencies: { vite: "^1.0.0", typescript: "^5.0.0", tscalias: "npm:typescript@^5.0.0", devtool: "^1.0.0" },
});

/** The SOURCE's lockfile (v3, hand-written: `bin` maps decide which devDependency a kept command needs). */
export const SOURCE_LOCK = deepFreeze({
  name: "fixture",
  lockfileVersion: 3,
  requires: true,
  packages: {
    "": { name: "fixture" },
    "node_modules/zod": { version: "1.0.0" },
    "node_modules/vite": { version: "1.0.0", bin: { vite: "bin/vite.js" } },
    "node_modules/typescript": { version: "5.0.0", bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" } },
    "node_modules/tscalias": { version: "5.0.0", bin: { tsc: "bin/tsc" } },
    "node_modules/devtool": { version: "1.0.0", bin: { devtool: "bin/devtool.js" } },
  },
});

/** The TARGET's manifest: exactly what the derivation makes of {@link SOURCE_MANIFEST}. */
export const TARGET_MANIFEST = deepFreeze({
  name: "fixture",
  version: "1.0.0",
  scripts: { build: "vite build", check: "npm run build && tsc --noEmit" },
  dependencies: { zod: "^1.0.0" },
  devDependencies: { vite: "^1.0.0", typescript: "^5.0.0" },
});

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export type PromotionFixture = Readonly<{
  root: string;
  /** The bare remote `origin` (`{ remote: true }`), else `null`. */
  remote: string | null;
  /** The linked worktree holding the target (`{ targetCheckout: true }`), else `null`. */
  targetCheckout: string | null;
  /** Pushes `branch` to the remote (a plain push: the fixture's own git, not the promoter's). */
  publish(branch: string): void;
  /** `git <args>` in the bare remote. */
  remoteGit(args: readonly string[]): string;
  /** Where candidates and the promoter home live (`workspaceIsolation.workspaceRoot`, absolute, beside the repository). */
  workRoot: string;
  /** The repository as the tree readers ask it (git from PATH, the default ceiling). */
  repository: GitRepository;
  /** The configuration a promotion context reads over this repository (its own command registry and profile directory). */
  document: PromotionDocument;
  /** Where the fixture's commands live (outside the repository). */
  commandsDirectory: string;
  commands: WorkspaceIsolationConfig["commands"];
  git(args: readonly string[], environment?: Readonly<Record<string, string>>): string;
  /** Writes `files` (a `null` content deletes) on `branch` and commits them; answers the new tip. */
  commit(branch: string, files: Readonly<Record<string, string | null>>, message?: string): string;
  tip(branch: string): string;
  /** The profile as the source commit holds it. */
  loaded(source?: string): LoadedPromotionProfile;
  /** The plan of `source` (default: dev's tip) against `target` (default: prod's tip). */
  plan(options?: FixturePlanOptions): Promise<PromotionPlan>;
  /** Makes the next lockfile runs fail like a cache miss (`enotcached`) or like a resolution error (`broken`). */
  markLockfile(marker: "enotcached" | "broken"): void;
  lockfileAttempts(): number;
  /** Writes (`content` a string) or removes (`null`) a marker file of the fixture's commands. */
  mark(name: string, content?: string | null): void;
  /** A file the fixture's commands wrote beside them (`null`: absent). */
  commandOutput(name: string): string | null;
}>;

/** A complete command registry around `commands` (every phase empty but `validate`), and the fixture's profile directory: the configuration a context reads. */
function fixtureDocument(commands: WorkspaceIsolationConfig["commands"], workRoot: string): PromotionDocument {
  const lock = { name: "fixture", timeoutMs: 60_000, staleMs: 60_000 };
  return deepFreeze({
    resourceLock: { timeoutMs: 2_000, pollIntervalMs: 50, staleMs: 60_000 },
    workspaceIsolation: {
      workspaceRoot: workRoot,
      branchNamespace: "agent/",
      baseStalenessCommits: 100,
      preserveOnFailure: false,
      quarantineTtlMs: 60_000,
      leaseTtlMs: 60_000,
      admissionLock: lock,
      mergeLock: lock,
      landTargets: [SOURCE],
      killGraceMs: 1_000,
      links: [],
      commands,
      phases: { setup: [], validate: ["gate"], regenerate: [], merge: [] },
    },
    promotion: { profileDirectory: PROFILE_DIRECTORY },
    harness: { typecheckTimeoutMs: 60_000, commandErroredRetries: 0, commandRetryBackoffMs: 1 },
  });
}

export type FixtureOptions = Readonly<{
  /** A landing fixture (see the header). */
  landing?: boolean;
  /** The gate's ceiling (ms). */
  gateTimeoutMs?: number;
  /** A bare remote `origin` (the profile's remote), holding both branches. */
  remote?: boolean;
  /** A linked worktree holding the target branch. */
  targetCheckout?: boolean;
  /** Declared inputs of the landing fixture's `setup` command (what makes a landed tree's setup stale). */
  setupInputs?: readonly string[];
}>;

/** The profile overrides of a landing fixture: its phases, and the generated, hook and engine folders projected. */
function landingProfile(overrides: FixtureProfileOverrides): FixtureProfileOverrides {
  const boundary = (overrides["boundary"] ?? {}) as Record<string, unknown>;
  return {
    phases: { setup: ["setup"], converge: ["gen"], verify: ["gate"] },
    ...overrides,
    boundary: { include: [".gitignore", "assets/", "product/run.sh", "product/link.ts", "package.json", "package-lock.json", "gen/", ".githooks/", `${FIXTURE_ENGINE}/`], ...boundary },
  };
}

/** The options of a fixture's plan (see {@link PromotionFixture}'s `plan`). */
export type FixturePlanOptions = Readonly<{ source?: string; target?: string | null; lockfiles?: boolean; sleep?: (ms: number) => Promise<void>; retries?: number; toolchain?: Readonly<Record<string, string | null>>; commands?: WorkspaceIsolationConfig["commands"] }>;

/** What a fixture's folders give without creating anything (see the header): its commands, its configuration, its repository, its profile at a source, and its plan. */
export type FixtureView = Readonly<{
  commands: WorkspaceIsolationConfig["commands"];
  document: PromotionDocument;
  repository: GitRepository;
  loaded(source: string): LoadedPromotionProfile;
  plan(options: FixturePlanOptions & Readonly<{ source: string; target: string | null }>): Promise<PromotionPlan>;
}>;

/** The view of an existing fixture's folders (see the header). */
export function fixtureView(folders: Readonly<{ root: string; commandsDirectory: string; workRoot: string }>, options: FixtureOptions = {}): FixtureView {
  const { root, commandsDirectory, workRoot } = folders;
  const node = (script: string, timeoutMs = 60_000) => ({ cwd: ".", argv: [process.execPath, join(commandsDirectory, script)], timeoutMs });
  const commands: WorkspaceIsolationConfig["commands"] = deepFreeze({
    lockfile: node("lock.mjs"),
    gate: node("gate.mjs", options.gateTimeoutMs ?? 60_000),
    ...(options.landing === true ? { setup: { ...node("setup.mjs"), ...(options.setupInputs === undefined ? {} : { inputs: [...options.setupInputs] }) }, gen: node("gen.mjs") } : {}),
  });
  const commandNames = new Set(Object.keys(commands));
  const repository = configuredGitRepository({}, root);
  const loaded = (source: string): LoadedPromotionProfile => {
    const profiles = loadPromotionProfiles(commitTreeReader(repository, source), PROFILE_DIRECTORY, commandNames);
    return profiles.find((entry) => entry.profile.name === PROFILE_NAME)!;
  };
  const workDirectory = ensurePrivateStateDirectory(join(repositoryRegistryArea(repositoryRegistry(join(root, ".git")), "promotion"), PROFILE_NAME));
  return deepFreeze({
    commands,
    document: fixtureDocument(commands, workRoot),
    repository,
    loaded,
    plan: (planOptions) => planPromotion({
      repository,
      loaded: loaded(planOptions.source),
      source: planOptions.source,
      target: planOptions.target,
      commands: planOptions.commands ?? commands,
      lockfiles: planOptions.lockfiles === false ? null : {
        runner: {
          supervisor: testProcessSupervisorBinary(),
          killGraceMs: 1_000,
          outputCharacters: 4_000,
          retries: { retries: planOptions.retries ?? 1, backoffMs: 1, ...(planOptions.sleep === undefined ? {} : { sleep: planOptions.sleep }) },
        },
        toolchain: planOptions.toolchain ?? { node: process.version },
        workDirectory,
      },
      workDirectory,
    }),
  });
}

export function promotionFixture(prefix: string, profileOverrides: FixtureProfileOverrides = {}, options: FixtureOptions = {}): PromotionFixture {
  const root = createTempDir(`${prefix}-repo-`);
  const commandsDirectory = createTempDir(`${prefix}-commands-`);
  const workRoot = createTempDir(`${prefix}-wt-`);
  writeFileSync(join(commandsDirectory, "lock.mjs"), LOCK_SCRIPT);
  writeFileSync(join(commandsDirectory, "gate.mjs"), GATE_SCRIPT);
  writeFileSync(join(commandsDirectory, "setup.mjs"), SETUP_SCRIPT);
  writeFileSync(join(commandsDirectory, "gen.mjs"), GEN_SCRIPT);
  const view = fixtureView({ root, commandsDirectory, workRoot }, options);
  const { commands, repository, loaded, plan: viewPlan } = view;
  const git = (args: readonly string[], environment: Readonly<Record<string, string>> = {}): string => execFileSync("git", ["-c", "gc.auto=0", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", ...testGitIdentityEnvironment(), ...environment },
  }).trim();
  let targetCheckout: string | null = null;
  const write = (path: string, content: string | null, top = root): void => {
    const absolute = join(top, path);
    if (content === null) {
      git(["-C", top, "rm", "-q", "--", path]);
      return;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  const commit = (branch: string, files: Readonly<Record<string, string | null>>, message = "change"): string => {
    // A branch the target checkout holds is committed there (git refuses to check it out twice).
    const top = branch === TARGET && targetCheckout !== null ? targetCheckout : root;
    if (top === root) git(["checkout", "-q", branch]);
    for (const [path, content] of Object.entries(files)) write(path, content, top);
    git(["-C", top, "add", "-A"]);
    git(["-C", top, "commit", "-q", "--allow-empty", "-m", message]);
    return git(["-C", top, "rev-parse", "HEAD"]);
  };
  git(["init", "-q", "-b", TARGET]);
  const landingFiles: Readonly<Record<string, string>> = options.landing === true ? {
    ".gitignore": "node_modules/\nbuild/\n",
    ".githooks/pre-commit": [
      "#!/bin/sh",
      `echo "$(git rev-parse --show-toplevel)" >> "${join(commandsDirectory, "hook-runs")}"`,
      `if [ -e "${join(commandsDirectory, "refuse-commit")}" ]; then echo "the fixture commit guard refuses this tree" >&2; exit 1; fi`,
      "echo \"the fixture commit guard certifies this tree\" >&2",
      "exit 0",
      "",
    ].join("\n"),
    [`${FIXTURE_ENGINE}/bridlewise.config.json`]: "{}\n",
  } : {};
  for (const [path, content] of Object.entries({ ...PRODUCT_FILES, ...landingFiles })) write(path, content);
  if (options.landing === true) {
    chmodSync(join(root, ".githooks/pre-commit"), 0o755);
    git(["config", "core.hooksPath", ".githooks"]);
  }
  write("package.json", json(TARGET_MANIFEST));
  write("package-lock.json", lockOf(TARGET_MANIFEST, SOURCE_LOCK));
  mkdirSync(join(root, "assets"), { recursive: true });
  writeFileSync(join(root, "assets/logo.png"), PNG);
  chmodSync(join(root, "product/run.sh"), 0o755);
  symlinkSync("lib/helper.ts", join(root, "product/link.ts"));
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "the product"]);
  git(["checkout", "-q", "-b", SOURCE]);
  commit(SOURCE, {
    "dev/tool.ts": 'import { helper } from "../product/lib/helper.ts";\nexport const tool = helper;\n',
    "dev/README.md": "# dev\n",
    [PROFILE_PATH]: json(fixtureProfile({ ...(options.remote === true ? { remote: "origin" } : {}), ...(options.landing === true ? landingProfile(profileOverrides) : profileOverrides) })),
    "package.json": json(SOURCE_MANIFEST),
    "package-lock.json": json(SOURCE_LOCK),
  }, "the development superset");
  const tip = (branch: string): string => git(["rev-parse", branch]);
  let remote: string | null = null;
  if (options.remote === true) {
    remote = createTempDir(`${prefix}-remote-`);
    git(["init", "-q", "--bare", remote]);
    git(["remote", "add", "origin", remote]);
    git(["push", "-q", "origin", TARGET, SOURCE]);
    git(["fetch", "-q", "origin"]);
  }
  if (options.targetCheckout === true) {
    targetCheckout = join(createTempDir(`${prefix}-target-`), "checkout");
    git(["worktree", "add", "-q", targetCheckout, TARGET]);
  }
  const remoteGit = (args: readonly string[]): string => {
    if (remote === null) throw new Error("the fixture has no remote");
    return execFileSync("git", ["-c", "gc.auto=0", "--git-dir", remote, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  };
  return deepFreeze({
    root,
    remote,
    targetCheckout,
    publish: (branch: string) => {
      git(["push", "-q", "origin", branch]);
    },
    remoteGit,
    workRoot,
    repository,
    document: view.document,
    commandsDirectory,
    commands,
    git,
    commit,
    tip,
    loaded: (source = tip(SOURCE)) => loaded(source),
    plan: (planOptions = {}) => viewPlan({ ...planOptions, source: planOptions.source ?? tip(SOURCE), target: planOptions.target === undefined ? tip(TARGET) : planOptions.target }),
    markLockfile: (marker) => writeFileSync(join(commandsDirectory, marker), ""),
    mark: (name, content = "") => {
      if (content === null) rmSync(join(commandsDirectory, name), { force: true });
      else writeFileSync(join(commandsDirectory, name), content);
    },
    commandOutput: (name) => (existsSync(join(commandsDirectory, name)) ? readFileSync(join(commandsDirectory, name), "utf8") : null),
    lockfileAttempts: () => (existsSync(join(commandsDirectory, "attempts")) ? Number(readFileSync(join(commandsDirectory, "attempts"), "utf8")) : 0),
  });
}
