import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";

import { networkInstalls } from "../helpers/network-install.ts";

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
 * A gating workflow (one the merge queue runs) triggers unconditionally on
 * `pull_request` and `merge_group` (no branch, type or path filter), and its
 * `push` trigger skips no main commit: a required check it produces would
 * otherwise stay pending on every PR a filter skips.
 *
 * Contributions from forks are safe by design (github-only §10.1), judged
 * by WHAT RUNS WITH PRIVILEGE, never by a trigger's name: no workflow runs
 * under `pull_request_target`; and a workflow whose run holds the base
 * repository's token or secrets (its own trigger, or for a reusable workflow
 * any caller's, followed through `uses: ./.github/workflows/…`) names no
 * pull-request-controlled value anywhere (a checkout's `ref`, an `env` at any
 * level, a job output, `run` text) and never fetches, checks out or reads a
 * pull request's head. The one exception is a declared data-only job, whose
 * declared env variables may carry such values into an issue's text while it
 * checks out nothing; its run text gets no exemption.
 *
 * No script splices outsider text (github-only §10.1, script injection): in
 * EVERY workflow, privileged or not, an outsider-controlled expression
 * (`github.event.*`, `github.head_ref`) never appears inside `run` text or an
 * inline script; such values reach a step only through `env:`.
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

/**
 * The trigger filters a GATING workflow (one the merge queue runs) may not
 * carry. Its required checks must report on every pull request and every
 * merge group: a `branches`/`branches-ignore` filter (`[develop]`), a
 * `types` filter (`[labeled]`) or a `paths`/`paths-ignore` filter leaves the
 * check PENDING on the pull requests it skips, so they can never land. On
 * `push` (main's post-land run) only the path and excluded-branch filters
 * would skip a main commit; `branches: [main]` names the branch it guards.
 */
const GATE_FILTERS = new Map([
  ["pull_request", ["branches", "branches-ignore", "types", "paths", "paths-ignore"]],
  ["merge_group", ["branches", "branches-ignore", "types", "paths", "paths-ignore"]],
  ["push", ["paths", "paths-ignore", "branches-ignore"]],
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
 * One workflow, parsed. Answers the events it triggers on, the path or branch
 * filters on its `push` and `pull_request` triggers, its concurrency blocks
 * (workflow and job level, each with its line), and every reason it could not
 * be read.
 *
 * Anchors and aliases are YAML 1.2 and GitHub expands them, so an alias is
 * resolved and judged like the node it names. A merge key (`<<`) is not: it
 * is a YAML 1.1 extension GitHub does not support, so a workflow carrying one
 * means something other than it appears to, and is unreadable here.
 */
function readWorkflow({ path, text }) {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, uniqueKeys: true, prettyErrors: false });
  const unreadable = [];
  const at = (node) => `${path}:${String(node?.range === undefined ? 1 : lines.linePos(node.range[0]).line)}`;
  const resolved = (node) => (isAlias(node) ? node.resolve(document) : node);
  for (const error of [...document.errors, ...document.warnings]) unreadable.push(`${path}: unreadable YAML: ${error.message.split("\n")[0]}`);
  if (unreadable.length > 0) return { events: new Set(), filters: [], blocks: [], unreadable };
  visit(document, {
    Pair(_key, pair) {
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === "<<") {
        unreadable.push(`${at(pair.key)} unreadable: a YAML merge key (<<), which GitHub does not support`);
      }
    },
  });
  const root = resolved(document.contents);
  if (!isMap(root)) return { events: new Set(), filters: [], blocks: [], unreadable: [...unreadable, `${path}: unreadable: the document is not a mapping`] };

  const events = new Set();
  const filters = [];
  const on = resolved(root.get("on", true));
  if (isScalar(on) && typeof on.value === "string") events.add(on.value);
  else if (isSeq(on) && on.items.map(resolved).every((item) => isScalar(item) && typeof item.value === "string")) for (const item of on.items) events.add(resolved(item).value);
  else if (isMap(on) && on.items.every((pair) => isScalar(pair.key))) {
    for (const pair of on.items) {
      const event = String(pair.key.value);
      events.add(event);
      const settings = resolved(pair.value);
      if (isMap(settings) && GATE_FILTERS.has(event)) {
        for (const filter of GATE_FILTERS.get(event)) {
          const node = settings.get(filter, true);
          if (node !== undefined) filters.push({ event, filter, at: at(node) });
        }
      }
    }
  } else unreadable.push(`${at(on)} unreadable: \`on\` is missing or is not an event name, a list of names or a map of events`);

  const blocks = [];
  const readBlock = (raw, owner) => {
    const node = resolved(raw);
    if (node === undefined) return;
    if (isScalar(node) && typeof node.value === "string") {
      blocks.push({ at: at(node), owner, shorthand: true });
      return;
    }
    if (!isMap(node)) {
      unreadable.push(`${at(node)} unreadable: ${owner}'s concurrency is neither a group name nor a map`);
      return;
    }
    const value = node.toJS(document);
    blocks.push({ at: at(node), owner, shorthand: false, group: value.group, cancel: value["cancel-in-progress"] ?? false, queue: value.queue ?? "single" });
  };
  readBlock(root.get("concurrency", true), "the workflow");
  const jobs = resolved(root.get("jobs", true));
  if (!isMap(jobs)) unreadable.push(`${at(jobs)} unreadable: \`jobs\` is missing or is not a map`);
  else for (const pair of jobs.items) {
    const job = resolved(pair.value);
    if (isMap(job)) readBlock(job.get("concurrency", true), `job ${String(pair.key?.value)}`);
  }
  return { events, filters, blocks, unreadable };
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

/**
 * A workflow that gates pull requests but not merge groups, a gating
 * workflow (one that runs in the merge queue) whose `push` or `pull_request`
 * trigger is filtered by path or excluded branch (its required check would
 * stay PENDING on a PR the filter skips, so the PR could never land), or one
 * the guard cannot read.
 */
function mergeQueueViolations(workflow) {
  const { events, filters, unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  const violations = [];
  if (events.has("merge_group")) {
    for (const { event, filter, at } of filters) {
      violations.push(`${at}: a gating workflow filters \`${event}\` by \`${filter}\`, so its required check stays pending on what the filter skips`);
    }
  }
  if (events.has("pull_request") && !events.has("merge_group") && !PULL_REQUEST_ONLY.has(workflow.path)) {
    violations.push(`${workflow.path}: runs on pull_request but not on merge_group, so the merge queue never reports its checks`);
  }
  return violations;
}

/**
 * The triggers whose runs execute in the BASE repository's context, with its
 * write token or secrets, while their event can name a fork's code: what
 * matters is what runs with privilege, not the trigger's name.
 */
const PRIVILEGED_EVENTS = new Set([
  "pull_request_target", "workflow_run", "check_suite", "check_run", "repository_dispatch", "deployment_status", "status",
  "issue_comment", "issues", "discussion", "discussion_comment", "schedule",
]);
/** An expression whose value a pull request (a fork) controls: its head commit, branch or repository, or a dispatch payload. */
const PULL_REQUEST_CONTROLLED = /github\.event\.(?:workflow_run\.(?:head_|pull_requests)|pull_request\.head|check_suite\.(?:head_|pull_requests)|check_run\.(?:head_sha|pull_requests|check_suite\.(?:head_|pull_requests))|deployment(?:_status)?\.|status\.(?:sha|branches|commit)|client_payload|issue\.pull_request)|github\.head_ref/iu;
/** Text (a run step, a ref, an env value) that fetches, checks out or reads a pull request's head, however the value got there. */
const HEAD_IN_RUN = /\bpull\/\S*\/(?:head|merge)\b|refs\/pull\/|\bgh\s+pr\s+checkout\b|\bhead_(?:sha|branch|ref|repository)\b|\bpull_requests\b|\bclient_payload\b/u;
/**
 * The ONE declared data-only path: a job that reads pull-request-controlled
 * values only as data (into an issue's text), with no checkout and no git
 * fetch of any kind. Each entry names the job, the env variables that carry
 * the values, and why; an entry that names nothing live is itself refused.
 */
const DATA_ONLY = new Map([
  [".github/workflows/reusable-workflow-failure.yml", {
    job: "report",
    variables: ["HEAD_SHA", "HEAD_BRANCH", "PR_NUMBER"],
    why: "the failure reporter writes the failed run's commit, branch and pull-request number into an issue's text; it checks out nothing and fetches nothing",
  }],
]);
const CHECKOUT = /^actions\/checkout@/iu;
const GIT_FETCH = /\bgit\s+(?:fetch|checkout|switch|clone|pull|worktree)\b|\bgh\s+(?:pr|repo)\s+(?:checkout|clone)\b/iu;

/** Every string of a parsed value, with where it sits (`jobs.x.steps[0].run`). */
function stringsOf(value, path = "") {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => stringsOf(item, `${path}[${String(index)}]`));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => stringsOf(item, path === "" ? key : `${path}.${key}`));
  return [];
}

/**
 * The events each workflow effectively runs under: its own, plus, for a
 * reusable workflow (`workflow_call`), every event of every workflow that
 * calls it through `uses: ./.github/workflows/<file>`, followed to a fixed
 * point. A reusable workflow nobody in the tree calls is judged privileged.
 */
function effectiveEvents(workflows) {
  const own = new Map(workflows.map((workflow) => [workflow.path, new Set(readWorkflow(workflow).events)]));
  const calls = workflows.flatMap((workflow) => {
    const jobs = parseDocument(workflow.text).toJS()?.jobs ?? {};
    return Object.values(jobs).flatMap((job) => (typeof job?.uses === "string" && job.uses.startsWith("./") ? [{ caller: workflow.path, callee: job.uses.slice(2).replace(/@.*$/u, "") }] : []));
  });
  const effective = new Map([...own].map(([path, events]) => [path, new Set(events)]));
  for (let changed = true; changed;) {
    changed = false;
    for (const { caller, callee } of calls) {
      const target = effective.get(callee);
      if (target === undefined) continue;
      for (const event of effective.get(caller) ?? []) if (!target.has(event)) { target.add(event); changed = true; }
    }
  }
  for (const [path, events] of effective) {
    if (events.has("workflow_call") && !calls.some((call) => call.callee === path)) events.add("uncalled-reusable");
  }
  return effective;
}

/**
 * The fork-safety violations of `workflow` among `workflows` (for its
 * callers): a `pull_request_target` trigger; and, in a workflow that runs
 * with privilege (its own or a caller's trigger), ANY pull-request-controlled
 * expression wherever it sits — `with`, `env` at every level, job outputs,
 * `run` text — and any run text that fetches, checks out or reads a head,
 * outside the declared data-only path.
 */
function forkSafetyViolations(workflow, workflows = [workflow]) {
  const { unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  const events = effectiveEvents(workflows.some((entry) => entry.path === workflow.path) ? workflows : [...workflows, workflow]).get(workflow.path);
  const violations = [];
  if (events.has("pull_request_target")) violations.push(`${workflow.path}: runs under pull_request_target, which holds write access and secrets beside a fork's code; use pull_request`);
  if (![...events].some((event) => PRIVILEGED_EVENTS.has(event) || event === "uncalled-reusable")) return violations;
  const document = parseDocument(workflow.text).toJS() ?? {};
  const dataOnly = DATA_ONLY.get(workflow.path);
  const dataJob = dataOnly === undefined ? undefined : document.jobs?.[dataOnly.job];
  const dataJobClean = dataJob !== undefined && !(dataJob.steps ?? []).some((step) => (typeof step?.uses === "string" && CHECKOUT.test(step.uses)) || (typeof step?.run === "string" && GIT_FETCH.test(step.run)));
  // Inside the declared data-only job (and only while it checks out and fetches nothing), its declared env
  // variables may carry the values; its run text gets no exemption (it reads them as $VARIABLES).
  const declared = (path) => dataOnly !== undefined && dataJobClean && dataOnly.variables.some((variable) => path === `jobs.${dataOnly.job}.env.${variable}`);
  for (const { path, value } of stringsOf(document)) {
    if (path === "on" || path.startsWith("on.") || declared(path)) continue;
    if (PULL_REQUEST_CONTROLLED.test(value)) violations.push(`${workflow.path}: ${path} names a value a pull request controls (${value.trim().split("\n")[0]}) in a run that holds the base repository's privilege`);
    else if (HEAD_IN_RUN.test(value)) violations.push(`${workflow.path}: ${path} fetches, checks out or reads a pull request's head in a run that holds the base repository's privilege`);
  }
  return violations;
}

/** An expression context an outsider controls: any event field (a comment, a title, a branch name, a body), the head ref. */
const UNTRUSTED_CONTEXT = /\bgithub\.(?:event\b|head_ref\b)/u;

/**
 * The script-injection violations of one workflow, privileged or not: an
 * outsider-controlled expression written inside a step's `run` text (or an
 * inline script), where GitHub splices it into the shell before it runs.
 * Untrusted values reach a step only through `env:`, as declared variables
 * the script reads quoted (`"$TITLE"`).
 */
function injectionViolations(workflow) {
  const { unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  const document = parseDocument(workflow.text).toJS() ?? {};
  const violations = [];
  for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      for (const [field, text] of [["run", step?.run], ["with.script", step?.with?.script]]) {
        if (typeof text !== "string") continue;
        for (const match of text.matchAll(/\$\{\{([\s\S]*?)\}\}/gu)) {
          if (UNTRUSTED_CONTEXT.test(match[1])) violations.push(`${workflow.path}: jobs.${jobName}.steps[${String(index)}].${field} inlines \${{${match[1]}}}, which an outsider controls; pass it through env and read the variable`);
        }
      }
    }
  }
  return violations;
}

/**
 * NO NETWORK INSTALL ON THE TEST PATH (#333). A system package manager
 * fetching from a mirror inside a job waits on the network without bound: a
 * hung mirror held two shards until their 45-minute timeout and read as a red
 * suite. The toolchain comes from the runner image and is PROBED (a missing
 * tool is a named failure), never installed by a step. What counts as an
 * install is the one reader `tests/helpers/network-install.ts`, shared with
 * the external-surface registry and the guardian compiler pin.
 */
function networkInstallViolations(workflow) {
  const { unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  const document = parseDocument(workflow.text).toJS() ?? {};
  const violations = [];
  for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      if (typeof step?.run !== "string") continue;
      for (const install of networkInstalls(step.run)) {
        violations.push(`${workflow.path}: jobs.${jobName}.steps[${String(index)}].run installs from the network (${install.command}); probe the runner image's tool instead`);
      }
    }
  }
  return violations;
}

/**
 * The forge is the ONE label writer (`harness forge apply`, from
 * docs/community/labels.json): a workflow uses a declared label and never
 * creates, edits or deletes one, in a step's script (`gh label create|edit|
 * delete|clone`, a write to a labels endpoint through `gh api` or `curl`) or
 * an actions/github-script call (`createLabel`, `updateLabel`, `deleteLabel`).
 * Applying a declared label to an issue (`…/issues/{n}/labels`) is no label write.
 */
const LABEL_WRITES = [
  /\bgh\s+label\s+(?:create|edit|delete|clone)\b/u,
  /\b(?:gh\s+api|curl)\b[^\n]{0,400}?(?<!issues\/[^\/\s]{1,40})\/labels\b[^\n]{0,400}?(?:-X|--method|--request)\s*['"]?(?:POST|PATCH|PUT|DELETE)\b/iu,
  /\b(?:gh\s+api|curl)\b[^\n]{0,400}?(?:-X|--method|--request)\s*['"]?(?:POST|PATCH|PUT|DELETE)\b[^\n]{0,400}?(?<!issues\/[^\/\s]{1,40})\/labels\b/iu,
  /\bgh\s+api\b[^\n]{0,400}?(?<!issues\/[^\/\s]{1,40})\/labels\b[^\n]{0,400}?\s(?:-f|-F|--field|--raw-field|--input)\s/u,
  /\b(?:createLabel|updateLabel|deleteLabel)\s*\(/u,
];

function labelWriteViolations(workflow) {
  const { unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  const document = parseDocument(workflow.text).toJS() ?? {};
  const violations = [];
  for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      const scripts = [step?.run, step?.with?.script].filter((text) => typeof text === "string").map((text) => text.replace(/\\\r?\n\s*/gu, " "));
      if (scripts.some((text) => LABEL_WRITES.some((pattern) => pattern.test(text)))) {
        violations.push(`${workflow.path}: jobs.${jobName}.steps[${String(index)}] writes a label; the forge is the one label writer (declare it in docs/community/labels.json)`);
      }
    }
  }
  return violations;
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
    "both, block": "on:\n  pull_request:\n  merge_group:\njobs: {}\n",
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

test("anchors and aliases are judged as the nodes they name; a merge key is unreadable", () => {
  const aliased = {
    "an aliased on": "x-events: &events [push, pull_request]\non: *events\njobs: {}\n",
    "an aliased event map": "x-events: &events\n  pull_request:\non: *events\njobs: {}\n",
  };
  for (const [shape, text] of Object.entries(aliased)) {
    const found = mergeQueueViolations({ path: ".github/workflows/alias.yml", text });
    assert.equal(found.length, 1, `${shape}: ${JSON.stringify(found)}`);
    assert.match(found[0], /runs on pull_request but not on merge_group/u, shape);
  }
  const aliasedGroup = `x-group: &shared\n  group: ci-\${{ github.ref }}\n  cancel-in-progress: true\non: [push, merge_group]\nconcurrency: *shared\njobs: {}\n`;
  assert.equal(concurrencyViolations({ path: ".github/workflows/alias.yml", text: aliasedGroup }).length, 1, "an aliased cancelling group is refused");
  const merged = {
    "a merge key in on": "x-events: &events\n  pull_request:\non:\n  <<: *events\n  merge_group:\njobs: {}\n",
    "a merge key in concurrency": `x-group: &shared\n  group: ci-\${{ ${JSON.stringify(PER_RUN_GROUP).slice(1, -1)} }}\non: [push, merge_group]\nconcurrency:\n  <<: *shared\njobs: {}\n`,
    "a merge key in a job": "x-job: &job\n  runs-on: x\non: [push, merge_group]\njobs:\n  build:\n    <<: *job\n",
  };
  for (const [shape, text] of Object.entries(merged)) {
    const entry = { path: ".github/workflows/merge-key.yml", text };
    const found = [...mergeQueueViolations(entry), ...concurrencyViolations(entry)];
    assert.ok(found.some((line) => line.includes("merge key")), `${shape}: ${JSON.stringify(found)}`);
  }
});

test("a gating workflow never filters its pull_request or merge_group trigger, nor main's push by path", () => {
  const planted = {
    "paths on pull_request": "on:\n  pull_request:\n    paths: ['src/**']\n  merge_group:\njobs: {}\n",
    "paths-ignore on push": "on:\n  push:\n    paths-ignore: ['docs/**']\n  pull_request:\n  merge_group:\njobs: {}\n",
    "branches-ignore, flow map": "on: {pull_request: {branches-ignore: [wip]}, merge_group: {}}\njobs: {}\n",
    "branches on pull_request": "on:\n  pull_request:\n    branches: [develop]\n  merge_group:\njobs: {}\n",
    "types on pull_request": "on:\n  pull_request:\n    types: [labeled]\n  merge_group:\njobs: {}\n",
    "types on merge_group": "on:\n  pull_request:\n  merge_group:\n    types: [checks_requested]\njobs: {}\n",
    "branches on merge_group, flow": "on: {pull_request: {}, merge_group: {branches: [main]}}\njobs: {}\n",
  };
  for (const [shape, text] of Object.entries(planted)) {
    const found = mergeQueueViolations({ path: ".github/workflows/gate.yml", text });
    assert.equal(found.length, 1, `${shape}: ${JSON.stringify(found)}`);
    assert.match(found[0], /gate\.yml:\d+: a gating workflow filters/u, shape);
  }
  const nearMisses = {
    "unfiltered gate, main push named": "on:\n  push:\n    branches: [main]\n  pull_request:\n  merge_group:\njobs: {}\n",
    "an empty settings map": "on: {pull_request: {}, merge_group: {}}\njobs: {}\n",
    "a path-filtered workflow outside the queue": "on:\n  push:\n    paths: ['docs/**']\njobs: {}\n",
  };
  for (const [shape, text] of Object.entries(nearMisses)) {
    assert.deepEqual(mergeQueueViolations({ path: ".github/workflows/near.yml", text }), [], shape);
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

test("every live workflow is fork-safe, and the data-only path names a live job", () => {
  const workflows = liveWorkflows();
  assert.deepEqual(workflows.flatMap((workflow) => forkSafetyViolations(workflow, workflows)), []);
  for (const [path, entry] of DATA_ONLY) {
    const workflow = workflows.find((candidate) => candidate.path === path);
    assert.ok(workflow !== undefined, `the data-only entry ${path} names no workflow`);
    const env = parseDocument(workflow.text).toJS()?.jobs?.[entry.job]?.env ?? {};
    for (const variable of entry.variables) assert.ok(variable in env, `the data-only entry ${path} names ${entry.job}.env.${variable}, which is gone`);
  }
});

test("fork-safety refuses every planted bypass and passes the near misses", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const plant = (text, others = []) => {
    const workflow = { path: ".github/workflows/plant.yml", text };
    return forkSafetyViolations(workflow, [workflow, ...others]);
  };
  const job = (event, body) => `on: ${event}\njobs:\n  j:\n    runs-on: ubuntu-24.04\n${body}`;
  const checkout = (withBlock) => `    steps:\n      - uses: actions/checkout@${SHA}\n${withBlock}`;
  // pull_request_target in three spellings.
  assert.equal(plant("on: pull_request_target\njobs:\n  j:\n    runs-on: x\n    steps: []\n").length, 1);
  assert.equal(plant("on: [push, pull_request_target]\njobs:\n  j:\n    runs-on: x\n    steps: []\n").length, 1);
  assert.equal(plant("on:\n  pull_request_target:\n    types: [opened]\njobs:\n  j:\n    runs-on: x\n    steps: []\n").length, 1);
  // A checkout of a head, on each privileged trigger, in any case.
  for (const [event, ref] of [
    ["workflow_run", "${{ github.event.workflow_run.head_sha }}"],
    ["issue_comment", "refs/pull/${{ github.event.issue.number }}/head"],
    ["check_suite", "${{ github.event.check_suite.head_sha }}"],
    ["check_run", "${{ github.event.check_run.head_sha }}"],
    ["repository_dispatch", "${{ github.event.client_payload.sha }}"],
    ["deployment_status", "${{ github.event.deployment.sha }}"],
    ["status", "${{ github.event.sha }}${{ github.event.status.sha }}"],
  ]) {
    assert.ok(plant(job(event, checkout(`        with:\n          ref: "${ref}"\n`))).length >= 1, `${event}: ${ref}`);
  }
  assert.ok(plant(job("workflow_run", `    steps:\n      - uses: Actions/Checkout@${SHA}\n        with:\n          ref: \${{ github.head_ref }}\n`)).length >= 1, "a checkout spelled in another case");
  // 1. A run step that fetches the head.
  assert.ok(plant(job("workflow_run", "    steps:\n      - run: git fetch origin pull/${{ github.event.workflow_run.pull_requests[0].number }}/head && git checkout FETCH_HEAD\n")).length >= 1);
  assert.ok(plant(job("workflow_run", "    steps:\n      - run: git fetch origin \"pull/$N/head\"\n")).length >= 1, "a fetch through a shell variable");
  assert.ok(plant(job("workflow_run", "    steps:\n      - run: echo \"sha=$(jq -r .workflow_run.head_sha \"$GITHUB_EVENT_PATH\")\" >> \"$GITHUB_OUTPUT\"\n")).length >= 1, "a head read from the event file");
  // 2. A reusable workflow called from a privileged one, and one nobody calls.
  const reusable = (body) => `on: workflow_call\njobs:\n  j:\n    runs-on: ubuntu-24.04\n${body}`;
  const caller = { path: ".github/workflows/caller.yml", text: "on: workflow_run\njobs:\n  call:\n    uses: ./.github/workflows/plant.yml\n" };
  assert.ok(plant(reusable(checkout("        with:\n          ref: ${{ github.event.workflow_run.head_sha }}\n")), [caller]).length >= 1, "called from workflow_run");
  assert.ok(plant(reusable(checkout("        with:\n          ref: ${{ github.event.workflow_run.head_sha }}\n"))).length >= 1, "a reusable workflow nobody calls");
  // 3. Indirection through env and needs.
  assert.ok(plant(`on: workflow_run\nenv:\n  REF: \${{ github.event.workflow_run.head_sha }}\njobs:\n  j:\n    runs-on: x\n${checkout("        with:\n          ref: ${{ env.REF }}\n")}`).length >= 1, "workflow-level env");
  assert.ok(plant(`on: workflow_run\njobs:\n  prep:\n    runs-on: x\n    outputs:\n      sha: \${{ github.event.workflow_run.head_sha }}\n    steps: []\n  j:\n    needs: prep\n    runs-on: x\n${checkout("        with:\n          ref: ${{ needs.prep.outputs.sha }}\n")}`).length >= 1, "a job output");
  // 4. The data-only path holds only for its declared job and only while it checks nothing out.
  const failureReporter = (steps) => ({ path: ".github/workflows/reusable-workflow-failure.yml", text: `on: workflow_call\njobs:\n  report:\n    runs-on: x\n    env:\n      HEAD_SHA: \${{ github.event.workflow_run.head_sha }}\n      HEAD_BRANCH: \${{ github.event.workflow_run.head_branch }}\n      PR_NUMBER: \${{ github.event.workflow_run.pull_requests[0].number }}\n    steps:\n${steps}` });
  const reporterCaller = { path: ".github/workflows/workflow-failure-issue.yml", text: "on: workflow_run\njobs:\n  report:\n    uses: ./.github/workflows/reusable-workflow-failure.yml\n" };
  const clean = failureReporter("      - run: gh issue create --body \"$HEAD_SHA\"\n");
  assert.deepEqual(forkSafetyViolations(clean, [clean, reporterCaller]), [], "the declared data-only job");
  const fetching = failureReporter("      - run: git fetch origin \"$HEAD_SHA\"\n");
  assert.ok(forkSafetyViolations(fetching, [fetching, reporterCaller]).length >= 1, "a data-only job that fetches loses the exemption");
  // Near misses: a privileged run on main, a pull_request run checking out its own head, a plain push.
  assert.deepEqual(plant(job("workflow_run", checkout("        with:\n          ref: main\n"))), []);
  assert.deepEqual(plant(job("issue_comment", checkout(""))), []);
  assert.deepEqual(plant(job("pull_request", checkout("        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n"))), []);
  assert.deepEqual(plant(job("push", "    steps:\n      - run: git fetch origin main\n")), []);
});

test("no live workflow inlines an outsider-controlled expression into a script", () => {
  assert.deepEqual(liveWorkflows().flatMap(injectionViolations), []);
});

test("script injection is refused in every workflow, privileged or not; env-passed values and trusted contexts pass", () => {
  const plant = (event, step) => injectionViolations({ path: ".github/workflows/plant.yml", text: `on: ${event}\njobs:\n  j:\n    runs-on: x\n    steps:\n${step}` });
  for (const [event, expression] of [
    ["issue_comment", "github.event.comment.body"],
    ["issues", "github.event.issue.title"],
    ["discussion", "github.event.discussion.body"],
    ["workflow_run", "github.event.workflow_run.display_title"],
    ["workflow_run", "github.event.workflow_run.head_branch"],
    ["pull_request", "github.event.pull_request.title"],
    ["pull_request", "github.head_ref"],
  ]) {
    assert.equal(plant(event, `      - run: echo "\${{ ${expression} }}"\n`).length, 1, `${event}: ${expression}`);
  }
  assert.equal(plant("issue_comment", "      - uses: actions/github-script@0123456789abcdef0123456789abcdef01234567\n        with:\n          script: console.log(\"${{ github.event.comment.body }}\")\n").length, 1, "an inline script");
  // The data-only job's run text gets no exemption: an inline head branch in the failure reporter is refused.
  const reporter = { path: ".github/workflows/reusable-workflow-failure.yml", text: "on: workflow_call\njobs:\n  report:\n    runs-on: x\n    env:\n      HEAD_BRANCH: ${{ github.event.workflow_run.head_branch }}\n    steps:\n      - run: gh issue create --title \"${{ github.event.workflow_run.head_branch }}\"\n" };
  const reporterCaller = { path: ".github/workflows/workflow-failure-issue.yml", text: "on: workflow_run\njobs:\n  report:\n    uses: ./.github/workflows/reusable-workflow-failure.yml\n" };
  assert.equal(injectionViolations(reporter).length, 1);
  assert.ok(forkSafetyViolations(reporter, [reporter, reporterCaller]).length >= 1, "an inline head expression in the data-only job's run text");
  // Near misses: the value through env, a trusted context, an input.
  assert.deepEqual(plant("issue_comment", "      - env:\n          BODY: ${{ github.event.comment.body }}\n        run: printf '%s' \"$BODY\"\n"), []);
  assert.deepEqual(plant("push", "      - run: echo \"${{ github.sha }} ${{ github.repository }} ${{ matrix.shard }} ${{ inputs.runner }}\"\n"), []);
});

test("no live workflow installs system packages from the network on its path (#333)", () => {
  assert.deepEqual(liveWorkflows().flatMap(networkInstallViolations), []);
});

test("network installs are refused in any spelling; probes and near misses pass", () => {
  const plant = (run) => networkInstallViolations({ path: ".github/workflows/plant.yml", text: `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: |\n${run.split("\n").map((line) => `          ${line}`).join("\n")}\n` });
  for (const run of [
    "sudo apt-get update", "sudo apt-get install -y gcc-14", "apt install -y make", "sudo apt-get -qq update", "brew install llvm", "apk add gcc",
    // Options before the subcommand, a continued line, and a prefixed environment (review of #335).
    "sudo apt-get -o Acquire::Retries=3 install -y gcc-14",
    "sudo apt-get \\\n  install -y gcc-14",
    "env DEBIAN_FRONTEND=noninteractive apt-get install -y gcc-14",
    "/usr/bin/apt-get install -y gcc-14",
    // A command word the reader cannot see through: a variable or a substitution (review of #335).
    "$PM install -y gcc-14",
    "${PM} install -y gcc-14",
    "sudo $PM add gcc",
    "$(command -v apt-get) install -y gcc-14",
    // Any expansion form, after any prefix, and inside eval or a shell's -c (second review of #415).
    "${PM:-apt-get} install -y gcc-14",
    "${PM[0]} install -y gcc-14",
    "timeout 60 $PM install -y gcc-14",
    "nice -n 5 $PM install -y gcc-14",
    "doas $PM add gcc",
    "echo gcc-14 | xargs $PM install -y",
    "eval \"$PM install -y gcc-14\"",
    "bash -c \"$PM install -y gcc-14\"",
    "sh -ec \"apt-get update\"",
  ]) {
    assert.equal(plant(run).length, 1, run);
  }
  for (const run of [
    "command -v gcc-14 >/dev/null || exit 1", "gcc-14 --version | head -n 1", "echo apt-get is not used here", "npm ci --no-audit --no-fund", "make -C engine/guardian all",
    // Expansions that are not the command word, or not followed by a subcommand.
    "TMPDIR=\"$RUNNER_TEMP/bw\" npm --prefix engine test", "npm install $PACKAGE", "cd \"$WORKDIR\" || exit 1", "$CC -o out file.c",
  ]) {
    assert.deepEqual(plant(run), [], run);
  }
});

test("no live workflow writes a label: the forge is the one label writer", () => {
  assert.deepEqual(liveWorkflows().flatMap(labelWriteViolations), []);
});

test("label writes are refused in a script or github-script; reading or applying a declared label passes", () => {
  const plant = (step) => labelWriteViolations({ path: ".github/workflows/plant.yml", text: `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n${step}\n` });
  const run = (text) => plant(`      - run: |\n${text.split("\n").map((line) => `          ${line}`).join("\n")}`);
  for (const text of [
    "gh label create ci-failure --color B60205 || true",
    "gh label \\\n  create ci-failure",
    "gh label edit ci-failure --color 000000",
    "gh label delete stale --yes",
    "gh label clone other/repo",
    "gh api repos/o/r/labels -f name=x -f color=ffffff",
    "gh api -X POST repos/o/r/labels -f name=x",
    "gh api --method PATCH repos/o/r/labels/x -f color=000000",
    "curl -X DELETE https://api.github.com/repos/o/r/labels/x",
  ]) {
    assert.equal(run(text).length, 1, text);
  }
  assert.equal(plant("      - uses: actions/github-script@v7\n        with:\n          script: |\n            await github.rest.issues.createLabel({ owner, repo, name: 'x' });").length, 1);
  for (const text of [
    "gh api \"repos/${GH_REPO}/labels/ci-failure\" --silent",
    "gh issue list --label ci-failure --state open",
    "gh issue create --label ci-failure --title t --body b",
    "gh issue edit 3 --add-label ci-failure",
    "gh api repos/o/r/issues/3/labels -f 'labels[]=ci-failure'",
  ]) {
    assert.deepEqual(run(text), [], text);
  }
});
