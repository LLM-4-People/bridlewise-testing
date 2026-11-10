/**
 * DEPENDABOT IS A SIGNAL, NEVER A COMMITTER (src/workflow/deps-adopt.ts): the
 * bump is derived from the pull request's files and re-applied by the agent;
 * an unrecognised change, a spec that is not a plain registry version of the
 * same package, a drifted trunk, a pull request that is not Dependabot's
 * account (whatever its login) or is closed, and a resolution that could run
 * package code, each refuses typed; the lockfile is never copied and nothing
 * is installed on the host; Dependabot's pull request is closed only after
 * the agent's is open.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { pullRequestFacts } from "../../src/workflow/forge/repository-reads.ts";
import type { ForgeClient } from "../../src/workflow/forge/port.ts";

import {
  ACTION_PIN_REGISTRY,
  adoptDependabotPullRequest,
  applyNpmBump,
  deriveBump,
  moveActionPins,
  npmCommandsFor,
  RESOLUTION_ONLY_FLAGS,
  rewriteActionPins,
  type DepsAdoptPorts,
} from "../../src/workflow/deps-adopt.ts";

const BEFORE = `{\n  "name": "x",\n  "dependencies": {\n    "undici": "^8.11.2",\n    "zod": "^4.4.3"\n  },\n  "devDependencies": {\n    "jsdom": "^29.1.1"\n  }\n}\n`;
const AFTER = BEFORE.replace('"undici": "^8.11.2"', '"undici": "^8.12.2"');
const SHA = (digit: string): string => digit.repeat(40);

function refusedWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: string }).code === code;
}

test("the bump is derived from the files: a package.json dependency-spec change, its lockfile never read", () => {
  const bump = deriveBump([
    { path: "engine/package.json", before: BEFORE, after: AFTER },
    { path: "engine/package-lock.json", before: "{}", after: "{\"lock\":2}" },
  ]);
  assert.deepEqual(bump, { ecosystem: "npm", directory: "engine", changes: [{ section: "dependencies", name: "undici", from: "^8.11.2", to: "^8.12.2" }] });
  assert.deepEqual(npmCommandsFor("engine"), ["engine-lockfile"]);
  assert.deepEqual(npmCommandsFor(""), ["lockfile"]);
});

test("a spec moves only between plain registry semver versions of the same package under the same operator; every other form refuses, named", () => {
  const bumpTo = (from: string, to: string) => deriveBump([{ path: "package.json", before: BEFORE.replace('"^8.11.2"', JSON.stringify(from)), after: BEFORE.replace('"^8.11.2"', JSON.stringify(to)) }]);
  for (const [from, to] of [["^8.11.2", "^8.12.2"], ["~8.11.2", "~8.11.3"], ["8.11.2", "8.12.0"], ["8.11.2", "9.0.0-rc.1"]] as const) {
    assert.equal(bumpTo(from, to).ecosystem, "npm", `${from} to ${to} is a registry move`);
  }
  for (const [to, form] of [
    ["npm:evil-pkg@1.0.0", "an alias to another package"],
    ["github:attacker/zod#main", "a git or GitHub ref"],
    ["attacker/zod#main", "a git or GitHub ref"],
    ["git+https://example.invalid/zod.git", "a git or GitHub ref"],
    ["file:../zod", "a local file"],
    ["link:../zod", "a link"],
    ["https://example.invalid/zod-9.0.0.tgz", "a URL"],
    ["workspace:*", "a workspace"],
    ["latest", "a dist-tag"],
    [">=8.0.0", "a range that is not exact, ^ or ~"],
    ["^8.12.2 || ^9.0.0", "a range that is not exact, ^ or ~"],
    ["8.12.2+build.1", "a range that is not exact, ^ or ~"],
  ] as const) {
    assert.throws(() => bumpTo("^8.11.2", to), (error: unknown) => (error as { code?: string }).code === "deps_spec_unsupported" && (error as Error).message.includes(form), `${to} is ${form}`);
  }
  assert.throws(() => bumpTo("^8.11.2", "8.12.2"), (error: unknown) => (error as { code?: string }).code === "deps_spec_unsupported" && (error as Error).message.includes("changes its range operator"), "^ to exact");
  assert.throws(() => bumpTo("github:attacker/zod#v1", "^8.12.2"), refusedWith("deps_spec_unsupported"), "a non-registry spec is never moved from either");
});

test("every resolution command the adoption runs, as declared in the configuration, is resolution only: lockfile only, no lifecycle scripts", () => {
  const commands = (JSON.parse(readFileSync(new URL("../../bridlewise.config.json", import.meta.url), "utf8")) as { workspaceIsolation: { commands: Record<string, { argv: string[] }> } }).workspaceIsolation.commands;
  for (const directory of ["", "engine"]) {
    for (const name of npmCommandsFor(directory)) {
      for (const flag of RESOLUTION_ONLY_FLAGS) assert.ok(commands[name]?.argv.includes(flag), `${name} carries ${flag}`);
    }
  }
});

test("an unrecognised change refuses, naming it: another field, an added dependency, another file, two directories", () => {
  for (const [why, files] of [
    ["a scripts change", [{ path: "package.json", before: BEFORE, after: AFTER.replace('"name": "x"', '"name": "y"') }]],
    ["an added dependency", [{ path: "package.json", before: BEFORE, after: AFTER.replace('"zod": "^4.4.3"', '"zod": "^4.4.3",\n    "left-pad": "1.0.0"') }]],
    ["a file beside the manifest", [{ path: "package.json", before: BEFORE, after: AFTER }, { path: "src/main.ts", before: "a", after: "b" }]],
    ["a file in the manifest's own directory", [{ path: "package.json", before: BEFORE, after: AFTER }, { path: "README.md", before: "a", after: "b" }]],
    ["two directories", [{ path: "package.json", before: BEFORE, after: AFTER }, { path: "engine/package.json", before: BEFORE, after: AFTER }]],
    ["a workflow line that is not a pin", [{ path: ".github/workflows/ci.yml", before: "run: a\n", after: "run: b\n" }]],
  ] as const) {
    assert.throws(() => deriveBump(files), refusedWith("deps_bump_unrecognized"), why);
  }
});

test("an action bump is the uses: pins moving; the registry (the pins' one owner) moves them and the workflows are rewritten from it", () => {
  const workflow = (sha: string, version: string): string => `jobs:\n  a:\n    steps:\n      - uses: actions/upload-artifact@${sha} # ${version}\n`;
  const bump = deriveBump([{ path: ".github/workflows/ci.yml", before: workflow(SHA("a"), "v6"), after: workflow(SHA("b"), "v7") }]);
  assert.deepEqual(bump, { ecosystem: "github-actions", changes: [{ action: "actions/upload-artifact", fromSha: SHA("a"), toSha: SHA("b"), version: "v7" }] });
  if (bump.ecosystem !== "github-actions") return;
  const registry = JSON.stringify({ entries: [{ id: "actions/upload-artifact", kind: "github-action", pinned: { commit: SHA("a"), version: "v6" }, usedIn: [".github/workflows/ci.yml", ".github/workflows/x.yml"] }] });
  const moved = moveActionPins(registry, bump.changes);
  assert.deepEqual(JSON.parse(moved.text).entries[0].pinned, { commit: SHA("b"), version: "v7" });
  assert.deepEqual(moved.workflows, [".github/workflows/ci.yml", ".github/workflows/x.yml"]);
  assert.equal(rewriteActionPins(workflow(SHA("a"), "v6"), bump.changes), workflow(SHA("b"), "v7"));
  assert.throws(() => moveActionPins(registry.replace(SHA("a"), SHA("c")), bump.changes), refusedWith("deps_bump_drifted"), "a pin the trunk moved since");
});

test("the bump applies to the trunk in place, every other byte kept; a spec the trunk moved since refuses as drifted", () => {
  const changes = [{ section: "dependencies" as const, name: "undici", from: "^8.11.2", to: "^8.12.2" }];
  assert.equal(applyNpmBump(BEFORE, changes, "package.json"), AFTER);
  assert.throws(() => applyNpmBump(BEFORE.replace("^8.11.2", "^8.11.9"), changes, "package.json"), refusedWith("deps_bump_drifted"));
});

/** Fake ports recording every call in order; `files` are the pull request's base and head texts. */
function fakePorts(overrides: Partial<DepsAdoptPorts> = {}, pull: Partial<Awaited<ReturnType<DepsAdoptPorts["readPullRequest"]>>> = {}) {
  const calls: string[] = [];
  const written: string[] = [];
  const texts = new Map<string, string>([["package.json", BEFORE]]);
  const ports: DepsAdoptPorts = {
    readPullRequest: async () => ({ authorLogin: "dependabot[bot]", authorId: ROOT_POLICY.workflow.dependabot.userId, authorType: "Bot", state: "open", baseSha: "base", headSha: "head", files: [{ path: "package.json" }, { path: "package-lock.json" }], ...pull }),
    checkoutAheadOfTrunk: async () => ({ commits: 0, trunk: "origin/main" }),
    readFileAt: async (path, ref) => (path === "package.json" ? (ref === "base" ? BEFORE : AFTER) : `{"lockfile":"${ref}"}`),
    createWorkspace: async (writeSet) => { calls.push(`create ${writeSet.join(",")}`); return { id: "ws-1", worktree: "/w" }; },
    readWorkspaceFile: (_worktree, path) => texts.get(path) ?? "",
    writeWorkspaceFile: (_worktree, path, text) => { calls.push(`write ${path}`); written.push(path); texts.set(path, text); },
    declaredArgv: () => ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit"],
    sandboxUnavailable: () => null,
    sandboxedInstallAndBundle: async (_worktree, directory) => { calls.push(`sandbox ${directory}`); },
    runDeclaredCommand: async (_worktree, name) => { calls.push(`run ${name}`); },
    sync: async () => { calls.push("sync"); },
    commit: async (_worktree, message) => { calls.push(`commit ${message.split("\n")[0]!}`); },
    publish: async () => { calls.push("publish"); return { number: 900 }; },
    closePullRequest: async (number, comment) => { calls.push(`close ${String(number)} ${comment.slice(0, 15)}`); },
    ...overrides,
  };
  return { ports, calls, written, texts };
}

test("the adoption re-applies the bump as the agent, the lockfile from the resolver with nothing installed, and closes Dependabot's pull request only after the agent's is open", async () => {
  const { ports, calls, written, texts } = fakePorts();
  const receipt = await adoptDependabotPullRequest(620, ports);
  assert.equal(receipt.agentPullRequest, 900);
  assert.deepEqual(calls, [
    "create package.json,package-lock.json",
    "write package.json",
    "run lockfile",
    "sync",
    "commit Adopt Dependabot #620: bump undici from ^8.11.2 to ^8.12.2 in /",
    "publish",
    "close 620 Adopted as #900",
  ]);
  assert.deepEqual(written, ["package.json"], "the lockfile is never written from Dependabot's branch: the resolver writes it");
  assert.equal(texts.get("package.json"), AFTER);
});

test("not Dependabot's account (whatever the login), closed, or a resolution that could run package code: refused before any workspace exists; a failed publish never closes Dependabot's pull request", async () => {
  const dependabot = ROOT_POLICY.workflow.dependabot;
  for (const [why, code, pull, overrides] of [
    ["another person", "deps_not_dependabot", { authorLogin: "someone", authorId: 1, authorType: "User" }, {}],
    ["a person whose login reads dependabot[bot]", "deps_not_dependabot", { authorId: 4242, authorType: "User" }, {}],
    ["another bot named dependabot[bot]", "deps_not_dependabot", { authorId: 4242, authorType: "Bot" }, {}],
    ["Dependabot's id on a non-Bot account", "deps_not_dependabot", { authorType: "User" }, {}],
    ["a closed pull request", "deps_pull_request_closed", { state: "closed" as const }, {}],
    ["a lockfile command that runs lifecycle scripts", "deps_resolution_executes", {}, { declaredArgv: () => ["npm", "install", "--package-lock-only"] }],
    ["a lockfile command that installs", "deps_resolution_executes", {}, { declaredArgv: () => ["npm", "ci", "--ignore-scripts"] }],
    ["a checkout carrying commits the trunk lacks", "deps_checkout_not_on_trunk", {}, { checkoutAheadOfTrunk: async () => ({ commits: 3, trunk: "origin/main" }) }],
  ] as const) {
    const { ports, calls } = fakePorts(overrides, pull);
    await assert.rejects(adoptDependabotPullRequest(620, ports), refusedWith(code), why);
    assert.deepEqual(calls, [], `${why}: nothing was created`);
  }
  assert.deepEqual(dependabot, { userId: 49699333, type: "Bot" }, "Dependabot is declared once, by its account");
  const { ports, calls } = fakePorts({ publish: async () => { throw Object.assign(new Error("forge down"), { code: "github_unavailable" }); } });
  await assert.rejects(adoptDependabotPullRequest(620, ports));
  assert.ok(!calls.some((call) => call.startsWith("close")), "Dependabot's pull request stays open while the agent's does not exist");
  assert.equal(ACTION_PIN_REGISTRY, "tests/prevention/external-surface-registry.json");
});

test("the forge read carries the author's numeric account id and type, and refuses a pull request that answers no id", async () => {
  const client = (user: Record<string, unknown>): ForgeClient => ({
    rest: async () => ({ status: 200, data: { user, state: "open", base: { sha: "b" }, head: { sha: "h" } } }),
    paginate: async () => [{ filename: "package.json", status: "modified" }],
  }) as unknown as ForgeClient;
  const facts = await pullRequestFacts(client({ login: "dependabot[bot]", id: 49699333, type: "Bot" }), "o/r", 620, 3);
  assert.deepEqual([facts.authorLogin, facts.authorId, facts.authorType], ["dependabot[bot]", 49699333, "Bot"]);
  await assert.rejects(pullRequestFacts(client({ login: "dependabot[bot]", type: "Bot" }), "o/r", 620, 3), refusedWith("github_response_invalid"));
  await assert.rejects(pullRequestFacts(client({ login: "dependabot[bot]", id: "49699333", type: "Bot" }), "o/r", 620, 3), refusedWith("github_response_invalid"));
});

test("a bump built into the bundle (/engine) runs the real install and the bundle regeneration only inside the sandbox, and refuses before anything exists where the sandbox cannot", async () => {
  const engineFiles = { files: [{ path: "engine/package.json" }, { path: "engine/package-lock.json" }] };
  const engineRead = { readFileAt: async (path: string, ref: string) => (path === "engine/package.json" ? (ref === "base" ? BEFORE : AFTER) : "{}"), readWorkspaceFile: () => BEFORE };
  const { ports, calls } = fakePorts(engineRead, engineFiles);
  await adoptDependabotPullRequest(620, ports);
  assert.deepEqual(calls.slice(0, 5), ["create engine/package.json,engine/package-lock.json", "write engine/package.json", "run engine-lockfile", "sandbox engine", "sync"]);
  const refused = fakePorts({ ...engineRead, sandboxUnavailable: () => "no confined-install mode" }, engineFiles);
  await assert.rejects(adoptDependabotPullRequest(620, refused.ports), (error: unknown) => (error as { code?: string }).code === "deps_sandbox_unavailable" && (error as Error).message.includes("never on the host"));
  assert.deepEqual(refused.calls, [], "nothing was created, nothing installed");
  // A root bump is built into nothing: the sandbox is never asked.
  const root = fakePorts({ sandboxUnavailable: () => { throw new Error("asked"); } });
  await adoptDependabotPullRequest(551, root.ports);
  assert.ok(!root.calls.some((call) => call.startsWith("sandbox")));
});
