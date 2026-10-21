import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

/**
 * THE WORKFLOW POLICY: rules every GitHub Actions workflow in the tree obeys.
 *
 * A `main` run is never cancelled. GitHub cancels a run in two ways: a
 * `cancel-in-progress: true` group cancels the running one, and the default
 * single-slot queue cancels a PENDING one when a newer run joins the group,
 * even with `cancel-in-progress: false`. So every `concurrency` block either
 * gives each non-pull-request run a group of its own (`github.run_id`) and
 * cancels only on pull requests, or keeps a shared group with `queue: max`
 * and never cancels. Shorthand `concurrency: <group>` (a shared group with the
 * single-slot queue) is refused.
 *
 * Every check a pull request runs also runs in the merge queue. `main` is
 * guarded by a merge queue, which judges the composed tree on `merge_group`
 * events; a workflow that runs on `pull_request` but not on `merge_group`
 * would leave its check unreported in the queue (a required one would block
 * every land). The one exemption is named below with its reason.
 *
 * Each file is READ AS YAML (the `yaml` package, the repository's one YAML
 * reader), never matched line by line: indentation, flow maps and flow lists
 * are all the same document to GitHub, so they are to this guard. A file that
 * does not parse, or whose `on`, `jobs` or `concurrency` has a shape GitHub
 * would not accept, is itself a violation: what the guard cannot read, it
 * cannot certify.
 *
 * The scan covers every workflow file of the tree, not a list of names.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIRECTORY = ".github/workflows";

const PER_RUN_GROUP = "github.event_name == 'pull_request' && github.ref || github.run_id";
const PULL_REQUEST_ONLY_CANCEL = "${{ github.event_name == 'pull_request' }}";

/**
 * Workflows that run on pull requests only, each with its reason. Nothing
 * else may be listed: a stale entry fails the live test.
 */
const PULL_REQUEST_ONLY = new Map([
  [
    ".github/workflows/dependency-review.yml",
    "judges a pull request's dependency diff against its base; the queue composes PRs that each passed it, and the check is not required",
  ],
]);

/** Every workflow file of the tree, as `{ path, text }`. */
function liveWorkflows(root = ROOT) {
  return readdirSync(join(root, WORKFLOW_DIRECTORY))
    .filter((name) => /\.ya?ml$/u.test(name))
    .sort()
    .map((name) => {
      const path = `${WORKFLOW_DIRECTORY}/${name}`;
      return { path, text: readFileSync(join(root, path), "utf8") };
    });
}

/**
 * One workflow, parsed. Answers the events it triggers on, its concurrency
 * blocks (workflow and job level, each with its line), and every reason it
 * could not be read.
 */
function readWorkflow({ path, text }) {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, uniqueKeys: true, prettyErrors: false });
  const unreadable = [];
  const at = (node) => `${path}:${String(node?.range === undefined ? 1 : lines.linePos(node.range[0]).line)}`;
  for (const error of [...document.errors, ...document.warnings]) unreadable.push(`${path}: unreadable YAML: ${error.message.split("\n")[0]}`);
  if (unreadable.length > 0) return { events: new Set(), blocks: [], unreadable };
  const root = document.contents;
  if (!isMap(root)) return { events: new Set(), blocks: [], unreadable: [`${path}: unreadable: the document is not a mapping`] };

  const events = new Set();
  const on = root.get("on", true);
  if (isScalar(on) && typeof on.value === "string") events.add(on.value);
  else if (isSeq(on) && on.items.every((item) => isScalar(item) && typeof item.value === "string")) for (const item of on.items) events.add(item.value);
  else if (isMap(on) && on.items.every((pair) => isScalar(pair.key))) for (const pair of on.items) events.add(String(pair.key.value));
  else unreadable.push(`${at(on)} unreadable: \`on\` is missing or is not an event name, a list of names or a map of events`);

  const blocks = [];
  const readBlock = (node, owner) => {
    if (node === undefined) return;
    if (isScalar(node) && typeof node.value === "string") {
      blocks.push({ at: at(node), owner, shorthand: true });
      return;
    }
    if (!isMap(node)) {
      unreadable.push(`${at(node)} unreadable: ${owner}'s concurrency is neither a group name nor a map`);
      return;
    }
    const value = node.toJSON();
    blocks.push({ at: at(node), owner, shorthand: false, group: value.group, cancel: value["cancel-in-progress"] ?? false, queue: value.queue ?? "single" });
  };
  readBlock(root.get("concurrency", true), "the workflow");
  const jobs = root.get("jobs", true);
  if (!isMap(jobs)) unreadable.push(`${at(jobs)} unreadable: \`jobs\` is missing or is not a map`);
  else for (const pair of jobs.items) if (isMap(pair.value)) readBlock(pair.value.get("concurrency", true), `job ${String(pair.key?.value)}`);
  return { events, blocks, unreadable };
}

/** The concurrency violations of one workflow, each naming its file and line. */
function concurrencyViolations(workflow) {
  const { blocks, unreadable } = readWorkflow(workflow);
  const violations = [...unreadable];
  for (const block of blocks) {
    if (block.shorthand) {
      violations.push(`${block.at}: shorthand concurrency shares one single-slot group, which cancels a pending main run`);
      continue;
    }
    const { group, cancel, queue } = block;
    if (typeof group !== "string" || group === "") {
      violations.push(`${block.at}: concurrency without a group`);
    } else if (queue === "max") {
      if (cancel !== false) violations.push(`${block.at}: a queue: max group must never cancel (cancel-in-progress: ${String(cancel)})`);
    } else if (queue !== "single") {
      violations.push(`${block.at}: unreadable: queue ${String(queue)} is neither single nor max`);
    } else if (!group.includes(PER_RUN_GROUP)) {
      violations.push(`${block.at}: group ${group} is shared by main runs; give non-pull-request runs github.run_id or use queue: max`);
    } else if (cancel !== false && cancel !== PULL_REQUEST_ONLY_CANCEL) {
      violations.push(`${block.at}: cancel-in-progress ${String(cancel)} may cancel a main run; cancel only on pull requests`);
    }
  }
  return violations;
}

/** A workflow that gates pull requests but not merge groups, or one the guard cannot read. */
function mergeQueueViolations(workflow) {
  const { events, unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  if (!events.has("pull_request") || events.has("merge_group") || PULL_REQUEST_ONLY.has(workflow.path)) return [];
  return [`${workflow.path}: runs on pull_request but not on merge_group, so the merge queue never reports its checks`];
}

/** Literal group prefixes shared by two workflows cancel each other's pull-request runs. */
function sharedGroupPrefixes(workflows) {
  const owners = new Map();
  const violations = [];
  for (const workflow of workflows) {
    for (const block of readWorkflow(workflow).blocks) {
      if (block.shorthand || typeof block.group !== "string") continue;
      const prefix = block.group.split("${{")[0];
      const owner = owners.get(prefix);
      if (owner !== undefined && owner !== workflow.path) {
        violations.push(`${block.at}: group prefix "${prefix}" is also used by ${owner}`);
      }
      owners.set(prefix, workflow.path);
    }
  }
  return violations;
}

const workflow = (path, concurrency) => ({
  path,
  text: `name: Planted\non:\n  push:\n    branches: [main]\n  pull_request:\n  merge_group:\n\n${concurrency}\njobs:\n  build:\n    runs-on: ubuntu-24.04\n`,
});

test("every live workflow keeps main runs uncancelled", () => {
  const workflows = liveWorkflows();
  assert.ok(workflows.length > 0, "the workflow walk found no workflow");
  assert.ok(
    workflows.some((entry) => readWorkflow(entry).blocks.length > 0),
    "the walk found no concurrency block at all; the reader no longer reads the tree",
  );
  assert.deepEqual(workflows.flatMap(concurrencyViolations), []);
  assert.deepEqual(sharedGroupPrefixes(workflows), []);
});

test("every live workflow that gates a pull request also runs in the merge queue", () => {
  const workflows = liveWorkflows();
  assert.ok(workflows.some((entry) => readWorkflow(entry).events.has("merge_group")), "no workflow runs on merge_group");
  assert.deepEqual(workflows.flatMap(mergeQueueViolations), []);
  const paths = new Set(workflows.map((entry) => entry.path));
  for (const [path] of PULL_REQUEST_ONLY) {
    assert.ok(paths.has(path), `the exemption ${path} names no workflow`);
    const { events } = readWorkflow(workflows.find((entry) => entry.path === path));
    assert.ok(events.has("pull_request") && !events.has("merge_group"), `the exemption ${path} is stale`);
  }
});

test("pull-request-only workflows are refused in every YAML spelling; near misses pass", () => {
  const planted = {
    "block map": "on:\n  push:\n  pull_request:\n    branches: [main]\njobs: {}\n",
    "four-space indentation": "on:\n    push:\n        branches: [main]\n    pull_request:\njobs:\n    build:\n        runs-on: x\n",
    "flow list": "on: [push, pull_request]\njobs: {}\n",
    "quoted flow list": 'on: ["push", "pull_request"]\njobs: {}\n',
    "flow map": "on: {pull_request: {branches: [main]}, push: {}}\njobs: {}\n",
    "scalar": "on: pull_request\njobs: {}\n",
    "quoted key": '"on":\n  pull_request:\njobs: {}\n',
  };
  for (const [shape, text] of Object.entries(planted)) {
    const found = mergeQueueViolations({ path: ".github/workflows/planted.yml", text });
    assert.equal(found.length, 1, `${shape}: ${JSON.stringify(found)}`);
    assert.match(found[0], /runs on pull_request but not on merge_group/u, shape);
  }
  const nearMisses = {
    "both, block": "on:\n  pull_request:\n  merge_group:\n    types: [checks_requested]\njobs: {}\n",
    "both, flow": "on: [pull_request, merge_group]\njobs: {}\n",
    "both, flow map": "on: {pull_request: {}, merge_group: {}}\njobs: {}\n",
    "comment and a job named like an event": "on:\n  push:\n    branches: [main]\n  # pull_request: commented out\njobs:\n  pull_request:\n    runs-on: x\n",
  };
  for (const [shape, text] of Object.entries(nearMisses)) {
    assert.deepEqual(mergeQueueViolations({ path: ".github/workflows/near.yml", text }), [], shape);
  }
  assert.deepEqual(mergeQueueViolations({ path: ".github/workflows/dependency-review.yml", text: "on:\n  pull_request:\njobs: {}\n" }), []);
});

test("a workflow the reader cannot read is a violation, never a pass", () => {
  const unreadable = {
    "broken YAML": "on:\n  pull_request:\n   - [unclosed\njobs: {}\n",
    "a duplicate key": "on:\n  push:\non:\n  pull_request:\njobs: {}\n",
    "tab indentation": "on:\n\tpull_request:\njobs: {}\n",
    "no on": "name: x\njobs: {}\n",
    "on of the wrong shape": "on: 3\njobs: {}\n",
    "no jobs": "on: pull_request\n",
    "a list document": "- on: pull_request\n",
    "concurrency of the wrong shape": "on: [push, merge_group]\nconcurrency: [a, b]\njobs: {}\n",
  };
  for (const [shape, text] of Object.entries(unreadable)) {
    const entry = { path: ".github/workflows/unreadable.yml", text };
    const found = [...mergeQueueViolations(entry), ...concurrencyViolations(entry)];
    assert.ok(found.length > 0 && found.every((line) => line.includes("unreadable")), `${shape}: ${JSON.stringify(found)}`);
  }
});

test("planted cancelling groups are refused at workflow and job level, in any YAML spelling", () => {
  const planted = [
    workflow(".github/workflows/a.yml", "concurrency:\n  group: a-${{ github.ref }}\n  cancel-in-progress: true\n"),
    workflow(".github/workflows/b.yml", "concurrency:\n  group: b-${{ github.ref }}\n  cancel-in-progress: false\n"),
    workflow(".github/workflows/c.yml", "concurrency: c-${{ github.ref }}\n"),
    workflow(".github/workflows/d.yml", "concurrency:\n  group: d\n  queue: max\n  cancel-in-progress: true\n"),
    workflow(".github/workflows/e.yml", `concurrency:\n  group: e-\${{ ${PER_RUN_GROUP} }}\n  cancel-in-progress: true\n`),
    workflow(".github/workflows/f.yml", "concurrency: {group: f, cancel-in-progress: false}\n"),
    {
      path: ".github/workflows/g.yml",
      text: "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-24.04\n    concurrency:\n        group: deploy\n    steps: []\n",
    },
  ];
  for (const entry of planted) {
    const violations = concurrencyViolations(entry);
    assert.equal(violations.length, 1, `${entry.path} must be refused once: ${JSON.stringify(violations)}`);
    assert.match(violations[0], new RegExp(`^${entry.path.replaceAll(".", "\\.")}:\\d+: `, "u"));
  }
  assert.match(concurrencyViolations(planted[6])[0], /g\.yml:6:/u, "the job-level block is reported at its own line");
});

test("near misses pass: per-run groups, pull-request-only cancel, queue: max", () => {
  const nearMisses = [
    workflow(
      ".github/workflows/a.yml",
      `concurrency:\n  # comment\n  group: a-\${{ ${PER_RUN_GROUP} }}\n  cancel-in-progress: ${PULL_REQUEST_ONLY_CANCEL}\n`,
    ),
    workflow(".github/workflows/b.yml", `concurrency:\n  group: b-\${{ ${PER_RUN_GROUP} }}\n  cancel-in-progress: false\n`),
    workflow(".github/workflows/c.yml", "concurrency:\n  group: pages\n  queue: max\n  cancel-in-progress: false\n"),
    workflow(".github/workflows/d.yml", "concurrency: {group: deploy, queue: max}\n"),
    workflow(".github/workflows/e.yml", "# concurrency: not a block\n"),
  ];
  assert.deepEqual(nearMisses.flatMap(concurrencyViolations), []);
  assert.deepEqual(sharedGroupPrefixes(nearMisses), []);
});

test("two workflows sharing a group prefix are refused", () => {
  const shared = [
    workflow(".github/workflows/a.yml", `concurrency:\n  group: ci-\${{ ${PER_RUN_GROUP} }}\n`),
    workflow(".github/workflows/b.yml", `concurrency:\n  group: ci-\${{ ${PER_RUN_GROUP} }}\n`),
  ];
  assert.equal(sharedGroupPrefixes(shared).length, 1);
});
