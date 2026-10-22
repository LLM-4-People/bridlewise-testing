/**
 * THE GATE CATALOGUE — the ONE declaration of what "qualified" means
 * (github-only §5.1). Every workflow under `.github/workflows/`, the shard
 * plan, the seal's refusals and the door's judgement are derived from this
 * file; nothing else names a gate.
 *
 * A gate is:
 *   - an `id` and a human `title` (the step and check label);
 *   - its `class`: `light` gates run together in the one light job, `suite`
 *     gates split their test-file population into CPU-balanced shards, and
 *     `action` gates are a GitHub-owned action the generator wires in (the
 *     dependency review);
 *   - its `role`: `required` gates are judged by the door, `signal` gates are
 *     recorded and shown, never judging;
 *   - its `commands`: names in the ONE command registry
 *     (`workspaceIsolation.commands`, `engine/bridlewise.config.json`), run
 *     in order by the ONE command runner (`../checkout-setup.ts`: supervised,
 *     redacted full log, the errored-class retry) — never a shell string, and
 *     the same commands a workspace's validation runs. A command may take the
 *     full log of an earlier command of the gate as its last argument
 *     (`logOf`: the guardian's pass-log check reads the test run's log);
 *   - the registry SETUP commands it needs (`setup`: the bundle, the guardian
 *     binaries) and the system `toolchain` the generator installs (an apt
 *     package, the hooks, the corpus);
 *   - its `reuse` eligibility (§5.4: a gate whose outcome is a pure function
 *     of the key may be reused; one that reads the network may not);
 *   - for a suite gate, its `population` (the test files it splits).
 *
 * Local and CI differ only in where a gate runs, never in what it runs: the
 * generated workflow step is `harness gates run <id>`, the same command a
 * workspace validation calls.
 *
 * The catalogue is versioned (`GATE_CATALOGUE_VERSION`). The door's ratchet
 * (§3.1) compares a tree's catalogue with main's: a gate may be added, never
 * dropped or demoted to `signal` without a decision record.
 */
import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";

export const GATE_CATALOGUE_VERSION = schemaId("gate-catalogue", 1);

export type GateClass = "light" | "suite" | "action";
export type GateRole = "required" | "signal";
/** A runner class: a hosted label. `ubuntu-slim` (one CPU, a container) is for API-only jobs, never a gate. */
export type RunnerClass = "ubuntu-24.04" | "ubuntu-slim";
/**
 * What a gate needs on the runner that no registry command provides, in the
 * order the generator installs it. Every job that runs a command also gets
 * `gcc-14`: the one runner's native supervisor is built with it. `userns` is a
 * host capability, not a package: the hosted image's AppArmor refuses an
 * unprivileged process its user and mount namespaces (`unshare -rm`), which
 * the keep-out and hostile-runtime proofs require of their host (#149).
 */
export const TOOLCHAINS = deepFreeze(["gcc-14", "userns", "hooks", "corpus"] as const);
export type Toolchain = (typeof TOOLCHAINS)[number];

/** One command of a gate: a registry name, and optionally the earlier command whose full log it takes as its last argument. */
export type GateCommand = Readonly<{ command: string; logOf?: string }>;
/** A suite's population: the test files it splits into shards. */
export type Population = "web-tests" | "engine-tests";

export type Gate = Readonly<{
  id: string;
  title: string;
  class: GateClass;
  role: GateRole;
  /** A light gate's registry commands, in order (fail-fast). */
  commands: readonly GateCommand[];
  /** Registry setup commands the gate's job runs first (`harness gates setup`). */
  setup: readonly string[];
  toolchain: readonly Toolchain[];
  reuse: "eligible" | "never";
  population?: Population;
  /** For a suite gate: its population splits into CPU-balanced cells of files (each runner takes a file subset). */
  split?: "files";
  /**
   * For a suite gate: the registry command one cell runs, its cell appended:
   * the web cell appends the vitest JSON report path and its files; the
   * engine cell appends the file listing its sources (`--cell`, the engine
   * runner withholds the rest).
   */
  cellCommand?: string;
  /** For an `action` gate: the action (a key of {@link ACTION_PINS}) and its inputs. */
  action?: Readonly<{ uses: ActionName; with: Readonly<Record<string, string>>; events: readonly ("pull_request")[] }>;
}>;

/**
 * THE ACTIONS THE GENERATED PIPELINE USES, each pinned to a full commit SHA
 * (the org's `sha_pinning_required`), with the release it names. One table:
 * a pin changes here and every workflow follows.
 */
export const ACTION_PINS = deepFreeze({
  checkout: { repository: "actions/checkout", sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", version: "v7" },
  "setup-node": { repository: "actions/setup-node", sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", version: "v7" },
  "upload-artifact": { repository: "actions/upload-artifact", sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9", version: "v7" },
  "download-artifact": { repository: "actions/download-artifact", sha: "9000827ccba6bdab643e8b6fd33ac0654aef8333", version: "v8.0.2" },
  "codeql-init": { repository: "github/codeql-action/init", sha: "6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee", version: "v4.39.0" },
  "codeql-analyze": { repository: "github/codeql-action/analyze", sha: "6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee", version: "v4.39.0" },
  "codeql-upload-sarif": { repository: "github/codeql-action/upload-sarif", sha: "6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee", version: "v4.39.0" },
  "dependency-review": { repository: "actions/dependency-review-action", sha: "a1d282b36b6f3519aa1f3fc636f609c47dddb294", version: "v5.0.0" },
  "configure-pages": { repository: "actions/configure-pages", sha: "45bfe0192ca1faeb007ade9deae92b16b8254a0d", version: "v6" },
  "jekyll-build-pages": { repository: "actions/jekyll-build-pages", sha: "44a6e6beabd48582f863aeeb6cb2151cc1716697", version: "v1" },
  "upload-pages-artifact": { repository: "actions/upload-pages-artifact", sha: "fc324d3547104276b827a68afc52ff2a11cc49c9", version: "v5" },
  "deploy-pages": { repository: "actions/deploy-pages", sha: "368f82528645a54fb793d4d04e342629a3f51346", version: "v5" },
  scorecard: { repository: "ossf/scorecard-action", sha: "fa7117db83c52d787ae5a89f350999701505d78e", version: "v2.5.0" },
  attest: { repository: "actions/attest", sha: "1e69f48acb82d1966a394da916b4c1698aa569d6", version: "v4.2.2" },
  "create-github-app-token": { repository: "actions/create-github-app-token", sha: "64ab729a6294000f5aa4a4bc0b73d1f32bc45510", version: "v3.3.0" },
} as const);

export type ActionName = keyof typeof ACTION_PINS;

/** The runner every gate job uses (four vCPU; free and unlimited on a public repository). */
export const GATE_RUNNER: RunnerClass = "ubuntu-24.04";
/**
 * The runner of an API-only job that runs NO harness command (the Pages
 * deploy): one CPU, a container. A job that runs the harness (plan, seal, the
 * door) uses {@link GATE_RUNNER}: the harness's S1 refuses a repository whose
 * tree spans devices (`repository_mountpoint_denied`, src/kernel/config.ts),
 * and the slim container's checkout does (measured on the first generated
 * run, 2026-10-21).
 */
export const API_RUNNER: RunnerClass = "ubuntu-slim";

/**
 * THE SHARD BUDGET: the org's hosted-job cap (Free: 20 concurrent, github-only
 * §5.6) less the jobs a cold run needs beside the shards (plan, light, seal,
 * the dependency review, CodeQL's languages, the door). The generator never
 * plans more shards than this.
 */
export const MAX_SHARDS = 12;

/** The engine's folder in the repository: the engine runner's sources and state are named relative to it. */
export const ENGINE_FOLDER = "engine";

/**
 * Test files a suite's population deliberately leaves out, each with its
 * reason and the record that decided it. A file listed here is NOT run; the
 * seal names every one in the receipt, so the exclusion is visible on every
 * verdict, and a listed file that no longer exists is a refusal (a stale
 * entry is a lie about the population).
 */
export const POPULATION_EXCLUSIONS = deepFreeze({
  "web-tests": [
    {
      path: "tests/prevention/cutover-graph-receipt-owner.test.ts",
      reason: "private-only cutover graph generator and consumers are not published in the public snapshot",
      evidence: "docs/floor/roadmap.md#snapshot · public baseline audit",
    },
    {
      path: "tests/prevention/frozen-record-not-a-second-owner.test.ts",
      reason: "the private frozen archives are not published; the public snapshot has no frozen record population to judge",
      evidence: "docs/floor/roadmap.md#snapshot · public baseline audit",
    },
    {
      path: "tests/performance/regression.test.ts",
      reason: "requires the generated tests/performance report from an idle-host profile; the report is not published and cannot be produced on every shard",
      evidence: "docs/floor/roadmap.md#snapshot · public baseline audit",
    },
    {
      path: "tests/unit/landlock-wsl-host.test.ts",
      reason: "requires a WSL host with a mounted Windows profile, including a credential store with its 8.3 short name; the standard Ubuntu shard runner does not provide that host",
      evidence: "docs/floor/roadmap.md#snapshot · public baseline audit",
    },
  ],
  "engine-tests": [],
} as const satisfies Readonly<Record<Population, readonly Readonly<{ path: string; reason: string; evidence: string }>[]>>);

const GATES: readonly Gate[] = [
  { id: "typecheck-web", title: "Typecheck web, server, templates and tests", class: "light", role: "required", commands: [{ command: "web-typecheck" }], setup: [], toolchain: [], reuse: "eligible" },
  { id: "typecheck-engine", title: "Typecheck engine and engine tests", class: "light", role: "required", commands: [{ command: "engine-typecheck" }], setup: [], toolchain: [], reuse: "eligible" },
  { id: "harness-check", title: "Generated values and harness check", class: "light", role: "required", commands: [{ command: "harness-sync" }, { command: "tree-unchanged" }, { command: "engine-format" }], setup: [], toolchain: [], reuse: "eligible" },
  { id: "secret-tree-scan", title: "Secret and privacy scan", class: "light", role: "required", commands: [{ command: "secret-scan" }], setup: [], toolchain: [], reuse: "eligible" },
  { id: "docs-links", title: "Relative Markdown links", class: "light", role: "required", commands: [{ command: "docs-links" }], setup: [], toolchain: [], reuse: "eligible" },
  { id: "public-tests", title: "Public smoke tests", class: "light", role: "required", commands: [{ command: "public-tests" }], setup: [], toolchain: [], reuse: "eligible" },
  { id: "build-web", title: "Build the cockpit", class: "light", role: "required", commands: [{ command: "web-build" }], setup: [], toolchain: [], reuse: "eligible" },
  {
    id: "guardian",
    title: "Build and test the guardian",
    class: "light",
    role: "required",
    commands: [{ command: "guardian" }, { command: "guardian-tests" }, { command: "guardian-pass-log", logOf: "guardian-tests" }],
    setup: [],
    toolchain: [],
    reuse: "eligible",
  },
  {
    id: "web-suite",
    title: "Web suite",
    class: "suite",
    role: "required",
    commands: [],
    setup: ["bundle", "guardian"],
    toolchain: ["hooks"],
    reuse: "eligible",
    population: "web-tests",
    split: "files",
    cellCommand: "web-shard",
  },
  {
    // A SIGNAL until it is green on hosted runners (runbook P0.9: every red it
    // shows is fixed or filed as an owned record first); flipping it to
    // `required` is this one line. Its cells run, are recorded and shown on
    // every run meanwhile — never skipped.
    id: "engine-suite",
    title: "Engine suite",
    class: "suite",
    role: "signal",
    commands: [],
    setup: ["bundle", "guardian"],
    toolchain: ["userns", "hooks", "corpus"],
    reuse: "eligible",
    population: "engine-tests",
    split: "files",
    cellCommand: "engine-cell",
  },
  {
    id: "dependency-review",
    title: "Review dependency changes",
    class: "action",
    role: "required",
    commands: [],
    setup: [],
    toolchain: [],
    reuse: "never",
    action: { uses: "dependency-review", with: { "fail-on-severity": "high", "comment-summary-in-pr": "never" }, events: ["pull_request"] },
  },
];

const GATE_ID = /^[a-z][a-z0-9-]{1,39}$/u;

/** Refuses a catalogue that breaks its own schema: every consumer reads a validated catalogue. */
function validateCatalogue(gates: readonly Gate[]): readonly Gate[] {
  const seen = new Set<string>();
  for (const gate of gates) {
    if (!GATE_ID.test(gate.id)) throw new InputError(`gate id ${JSON.stringify(gate.id)} is not a lower-case slug`, "gate_catalogue_invalid");
    if (seen.has(gate.id)) throw new InputError(`gate id ${gate.id} is declared twice`, "gate_catalogue_invalid");
    seen.add(gate.id);
    if (gate.title.trim() === "" || gate.title.includes("\n")) throw new InputError(`gate ${gate.id} has no one-line title`, "gate_catalogue_invalid");
    const isSuite = gate.class === "suite";
    if (isSuite !== (gate.population !== undefined) || isSuite !== (gate.split !== undefined)) throw new InputError(`gate ${gate.id}: a population and its split belong to exactly the suite gates`, "gate_catalogue_invalid");
    if ((gate.class === "action") !== (gate.action !== undefined)) throw new InputError(`gate ${gate.id}: an action belongs to exactly the action gates`, "gate_catalogue_invalid");
    if (gate.class === "light" && gate.commands.length === 0) throw new InputError(`gate ${gate.id}: a light gate runs at least one command`, "gate_catalogue_invalid");
    if (gate.class !== "light" && gate.commands.length > 0) throw new InputError(`gate ${gate.id}: only a light gate declares commands (a suite runs its cell command; an action is wired by the generator)`, "gate_catalogue_invalid");
    if (isSuite !== (gate.cellCommand !== undefined)) throw new InputError(`gate ${gate.id}: a cell command belongs to exactly the suite gates`, "gate_catalogue_invalid");
    gate.commands.forEach((entry, index) => {
      if (entry.logOf !== undefined && !gate.commands.slice(0, index).some((earlier) => earlier.command === entry.logOf)) {
        throw new InputError(`gate ${gate.id}: ${entry.command} takes the log of ${entry.logOf}, which does not run before it in the gate`, "gate_catalogue_invalid");
      }
    });
  }
  return gates;
}

export const GATE_CATALOGUE: readonly Gate[] = deepFreeze(validateCatalogue(GATES));

/** Every registry command the catalogue runs (the dead-command check counts the gates as a consumer). */
export function catalogueCommandNames(catalogue: readonly Gate[] = GATE_CATALOGUE): readonly string[] {
  return [...new Set(catalogue.flatMap((gate) => [...gate.setup, ...gate.commands.map((entry) => entry.command), ...(gate.cellCommand === undefined ? [] : [gate.cellCommand])]))].toSorted();
}

/** The gate `id`, or a typed refusal naming the known ids. */
export function gateById(id: string, catalogue: readonly Gate[] = GATE_CATALOGUE): Gate {
  const gate = catalogue.find((candidate) => candidate.id === id);
  if (gate === undefined) throw new InputError(`no gate ${JSON.stringify(id)} in the catalogue (known: ${catalogue.map((entry) => entry.id).join(", ")})`, "gate_unknown");
  return gate;
}

export function gatesOfClass(gateClass: GateClass, catalogue: readonly Gate[] = GATE_CATALOGUE): readonly Gate[] {
  return catalogue.filter((gate) => gate.class === gateClass);
}
