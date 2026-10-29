/**
 * DEPENDABOT IS A SIGNAL, NEVER A COMMITTER (src/workflow/deps-adopt.ts): the
 * bump is derived from the pull request's files and re-applied by the agent;
 * an unrecognised change, a drifted trunk, a pull request that is not
 * Dependabot's or is closed, each refuses typed; the lockfile is never copied;
 * Dependabot's pull request is closed only after the agent's is open.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_PIN_REGISTRY,
  adoptDependabotPullRequest,
  applyNpmBump,
  deriveBump,
  moveActionPins,
  npmCommandsFor,
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
  assert.deepEqual(npmCommandsFor("engine"), ["engine-lockfile", "engine-deps"]);
  assert.deepEqual(npmCommandsFor(""), ["lockfile", "web-deps"]);
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
    readPullRequest: async () => ({ authorLogin: "dependabot[bot]", state: "open", baseSha: "base", headSha: "head", files: [{ path: "package.json" }, { path: "package-lock.json" }], ...pull }),
    readFileAt: async (path, ref) => (path === "package.json" ? (ref === "base" ? BEFORE : AFTER) : `{"lockfile":"${ref}"}`),
    createWorkspace: async (writeSet) => { calls.push(`create ${writeSet.join(",")}`); return { id: "ws-1", worktree: "/w" }; },
    readWorkspaceFile: (_worktree, path) => texts.get(path) ?? "",
    writeWorkspaceFile: (_worktree, path, text) => { calls.push(`write ${path}`); written.push(path); texts.set(path, text); },
    runDeclaredCommand: async (_worktree, name) => { calls.push(`run ${name}`); },
    sync: async () => { calls.push("sync"); },
    commit: async (_worktree, message) => { calls.push(`commit ${message.split("\n")[0]!}`); },
    publish: async () => { calls.push("publish"); return { number: 900 }; },
    closePullRequest: async (number, comment) => { calls.push(`close ${String(number)} ${comment.slice(0, 15)}`); },
    ...overrides,
  };
  return { ports, calls, written, texts };
}

test("the adoption re-applies the bump as the agent, the lockfile from the resolver, and closes Dependabot's pull request only after the agent's is open", async () => {
  const { ports, calls, written, texts } = fakePorts();
  const receipt = await adoptDependabotPullRequest(620, ports);
  assert.equal(receipt.agentPullRequest, 900);
  assert.deepEqual(calls, [
    "create package.json,package-lock.json",
    "write package.json",
    "run lockfile",
    "run web-deps",
    "sync",
    "commit Adopt Dependabot #620: bump undici from ^8.11.2 to ^8.12.2 in /",
    "publish",
    "close 620 Adopted as #900",
  ]);
  assert.deepEqual(written, ["package.json"], "the lockfile is never written from Dependabot's branch: the resolver writes it");
  assert.equal(texts.get("package.json"), AFTER);
});

test("not Dependabot's, or closed: refused before any workspace exists; a failed publish never closes Dependabot's pull request", async () => {
  for (const [code, pull] of [["deps_not_dependabot", { authorLogin: "someone" }], ["deps_pull_request_closed", { state: "closed" as const }]] as const) {
    const { ports, calls } = fakePorts({}, pull);
    await assert.rejects(adoptDependabotPullRequest(620, ports), refusedWith(code));
    assert.deepEqual(calls, [], `${code}: nothing was created`);
  }
  const { ports, calls } = fakePorts({ publish: async () => { throw Object.assign(new Error("forge down"), { code: "github_unavailable" }); } });
  await assert.rejects(adoptDependabotPullRequest(620, ports));
  assert.ok(!calls.some((call) => call.startsWith("close")), "Dependabot's pull request stays open while the agent's does not exist");
  assert.equal(ACTION_PIN_REGISTRY, "tests/prevention/external-surface-registry.json");
});
