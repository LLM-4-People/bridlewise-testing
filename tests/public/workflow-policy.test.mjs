import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
 * The scan covers every workflow file of the tree, not a list of names.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW_DIRECTORY = ".github/workflows";

const PER_RUN_GROUP = "github.event_name == 'pull_request' && github.ref || github.run_id";
const PULL_REQUEST_ONLY_CANCEL = "${{ github.event_name == 'pull_request' }}";

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
 * Every `concurrency` block of one workflow (workflow level or job level),
 * with its scalar fields. A comment line inside the block is skipped.
 */
function concurrencyBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)concurrency:\s*(.*)$/u.exec(lines[index]);
    if (match === null) continue;
    const indent = match[1].length;
    const inline = match[2].replace(/\s+#.*$/u, "").trim();
    const fields = {};
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() === "" || line.trim().startsWith("#")) continue;
      const lead = /^(\s*)/u.exec(line)[1].length;
      if (lead <= indent) break;
      const field = /^\s*([a-z-]+):\s*(.*)$/u.exec(line);
      if (field !== null) fields[field[1]] = field[2].trim();
    }
    blocks.push({ line: index + 1, inline, fields });
  }
  return blocks;
}

/** The violations of one workflow, each naming its file and line. */
function concurrencyViolations({ path, text }) {
  const violations = [];
  for (const block of concurrencyBlocks(text)) {
    const at = `${path}:${String(block.line)}`;
    if (block.inline !== "") {
      violations.push(`${at}: shorthand concurrency shares one single-slot group, which cancels a pending main run`);
      continue;
    }
    const group = block.fields.group ?? "";
    const cancel = block.fields["cancel-in-progress"] ?? "false";
    const queue = block.fields.queue ?? "single";
    if (group === "") {
      violations.push(`${at}: concurrency without a group`);
    } else if (queue === "max") {
      if (cancel !== "false") violations.push(`${at}: a queue: max group must never cancel (cancel-in-progress: ${cancel})`);
    } else if (!group.includes(PER_RUN_GROUP)) {
      violations.push(`${at}: group ${group} is shared by main runs; give non-pull-request runs github.run_id or use queue: max`);
    } else if (cancel !== "false" && cancel !== PULL_REQUEST_ONLY_CANCEL) {
      violations.push(`${at}: cancel-in-progress ${cancel} may cancel a main run; cancel only on pull requests`);
    }
  }
  return violations;
}

/** Literal group prefixes shared by two workflows cancel each other's pull-request runs. */
function sharedGroupPrefixes(workflows) {
  const owners = new Map();
  const violations = [];
  for (const workflow of workflows) {
    for (const block of concurrencyBlocks(workflow.text)) {
      const prefix = (block.fields.group ?? block.inline).split("${{")[0];
      const owner = owners.get(prefix);
      if (owner !== undefined && owner !== workflow.path) {
        violations.push(`${workflow.path}:${String(block.line)}: group prefix "${prefix}" is also used by ${owner}`);
      }
      owners.set(prefix, workflow.path);
    }
  }
  return violations;
}

const workflow = (path, concurrency) => ({
  path,
  text: `name: Planted\non:\n  push:\n    branches: [main]\n  pull_request:\n\n${concurrency}\njobs:\n  build:\n    runs-on: ubuntu-24.04\n`,
});

test("every live workflow keeps main runs uncancelled", () => {
  const workflows = liveWorkflows();
  assert.ok(workflows.length > 0, "the workflow walk found no workflow");
  assert.ok(
    workflows.some((entry) => concurrencyBlocks(entry.text).length > 0),
    "the walk found no concurrency block at all; the parser no longer reads the tree",
  );
  assert.deepEqual(workflows.flatMap(concurrencyViolations), []);
  assert.deepEqual(sharedGroupPrefixes(workflows), []);
});

test("planted cancelling groups are refused at workflow and job level", () => {
  const planted = [
    workflow(".github/workflows/a.yml", "concurrency:\n  group: a-${{ github.ref }}\n  cancel-in-progress: true\n"),
    workflow(".github/workflows/b.yml", "concurrency:\n  group: b-${{ github.ref }}\n  cancel-in-progress: false\n"),
    workflow(".github/workflows/c.yml", "concurrency: c-${{ github.ref }}\n"),
    workflow(".github/workflows/d.yml", "concurrency:\n  group: d\n  queue: max\n  cancel-in-progress: true\n"),
    workflow(
      ".github/workflows/e.yml",
      `concurrency:\n  group: e-\${{ ${PER_RUN_GROUP} }}\n  cancel-in-progress: true\n`,
    ),
    {
      path: ".github/workflows/f.yml",
      text: "on: push\njobs:\n  deploy:\n    runs-on: ubuntu-24.04\n    concurrency:\n      group: deploy\n    steps: []\n",
    },
  ];
  const found = planted.map((entry) => concurrencyViolations(entry));
  for (const [index, violations] of found.entries()) {
    assert.equal(violations.length, 1, `${planted[index].path} must be refused once: ${JSON.stringify(violations)}`);
    assert.match(violations[0], new RegExp(`^${planted[index].path.replaceAll(".", "\\.")}:\\d+: `, "u"));
  }
  assert.match(found[5][0], /f\.yml:5:/u, "the job-level block is reported at its own line");
});

test("near misses pass: per-run groups, pull-request-only cancel, queue: max", () => {
  const nearMisses = [
    workflow(
      ".github/workflows/a.yml",
      `concurrency:\n  # comment\n  group: a-\${{ ${PER_RUN_GROUP} }}\n  cancel-in-progress: ${PULL_REQUEST_ONLY_CANCEL}\n`,
    ),
    workflow(".github/workflows/b.yml", `concurrency:\n  group: b-\${{ ${PER_RUN_GROUP} }}\n  cancel-in-progress: false\n`),
    workflow(".github/workflows/c.yml", "concurrency:\n  group: pages\n  queue: max\n  cancel-in-progress: false\n"),
    workflow(".github/workflows/d.yml", "concurrency:\n  group: deploy\n  queue: max\n"),
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
