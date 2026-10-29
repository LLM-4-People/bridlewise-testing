import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, visit } from "yaml";

import { commandSubstitutions, networkInstalls, shellCommands, shellWords } from "../helpers/network-install.ts";

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
 *
 * One `types` list is no filter: one on `pull_request` that holds every one of
 * GitHub's default types ({@link DEFAULT_PULL_REQUEST_TYPES}) skips no event
 * the unfiltered trigger runs on, and only ADDS events (a label change that
 * re-judges a check). Any narrower list still skips a gating event and is
 * refused. The added events bring their own hazard, {@link requiredSkipViolations}.
 */
/** The `pull_request` activity types GitHub runs a workflow on when none are named. */
const DEFAULT_PULL_REQUEST_TYPES = Object.freeze(["opened", "synchronize", "reopened"]);

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
  if (unreadable.length > 0) return { events: new Set(), filters: [], blocks: [], unreadable, extraTypes: [], jobs: [] };
  visit(document, {
    Pair(_key, pair) {
      if (isPair(pair) && isScalar(pair.key) && pair.key.value === "<<") {
        unreadable.push(`${at(pair.key)} unreadable: a YAML merge key (<<), which GitHub does not support`);
      }
    },
  });
  const root = resolved(document.contents);
  if (!isMap(root)) return { events: new Set(), filters: [], blocks: [], unreadable: [...unreadable, `${path}: unreadable: the document is not a mapping`], extraTypes: [], jobs: [] };

  const events = new Set();
  const filters = [];
  /** The `pull_request` types a full types list adds beyond GitHub's defaults. */
  const extraTypes = [];
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
          if (node === undefined) continue;
          if (event === "pull_request" && filter === "types") {
            const list = resolved(node);
            const types = isSeq(list) && list.items.map(resolved).every((item) => isScalar(item) && typeof item.value === "string") ? list.items.map((item) => String(resolved(item).value)) : null;
            if (types !== null && DEFAULT_PULL_REQUEST_TYPES.every((type) => types.includes(type))) {
              extraTypes.push(...types.filter((type) => !DEFAULT_PULL_REQUEST_TYPES.includes(type)));
              continue;
            }
          }
          filters.push({ event, filter, at: at(node) });
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
  // Each job's key, display name, condition and line (what a required check is named by, and what can skip it).
  const jobsNode = resolved(root.get("jobs", true));
  const jobList = isMap(jobsNode)
    ? jobsNode.items.filter((pair) => isScalar(pair.key) && isMap(resolved(pair.value))).map((pair) => {
      const job = resolved(pair.value);
      const name = resolved(job.get("name", true));
      const condition = resolved(job.get("if", true));
      return { key: String(pair.key.value), name: isScalar(name) ? String(name.value) : String(pair.key.value), condition: isScalar(condition) ? String(condition.value) : null, at: at(pair.key) };
    })
    : [];
  return { events, filters, blocks, unreadable, extraTypes, jobs: jobList };
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
 * The checks the forge requires: the required-status-check contexts of every
 * ruleset it applies, read from the one declaration it applies them from (the
 * generated `.github/forge` objects of kind `org-ruleset` or `ruleset`).
 */
function declaredRequiredChecks(root = ROOT) {
  const contexts = new Set();
  const walkForge = (directory) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walkForge(path);
      else if (entry.name.endsWith(".json")) {
        const object = JSON.parse(readFileSync(join(root, path), "utf8"));
        if (object.kind !== "org-ruleset" && object.kind !== "ruleset") continue;
        for (const rule of object.desired?.rules ?? []) {
          if (rule.type !== "required_status_checks") continue;
          for (const check of rule.parameters?.required_status_checks ?? []) contexts.add(check.context);
        }
      }
    }
  };
  walkForge(".github/forge");
  return contexts;
}

/**
 * A REQUIRED job that can skip itself on the events a full `types` list adds.
 * A skipped job still reports a check run, the newer one at the same head,
 * and GitHub counts a skipped run as passing for a required check: a label
 * event would turn the job's earlier failure into a pass. So in a workflow
 * whose `pull_request` trigger adds types, a job the forge requires (by its
 * display name, or its key when it has none) never carries an `if:` that
 * reads the event's action or label, or names an added type.
 */
function requiredSkipViolations(workflow, required = declaredRequiredChecks()) {
  const { extraTypes, jobs, unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  if (extraTypes.length === 0) return [];
  const skipsOnExtra = (condition) => condition !== null && (/github\.event\.(?:action|label)\b/u.test(condition) || extraTypes.some((type) => condition.includes(`'${type}'`)));
  return jobs
    .filter((job) => (required.has(job.name) || required.has(job.key)) && skipsOnExtra(job.condition))
    .map((job) => `${job.at}: the required job "${job.name}" can skip itself on the added pull_request types (${extraTypes.join(", ")}); a skipped run is the newer one at the head and counts as passing, so a label event would turn its failure into a pass`);
}

/** The CodeQL steps that upload results to code scanning: `analyze` (unless told otherwise) and `upload-sarif` (always). */
const CODEQL_ANALYZE = /^github\/codeql-action\/analyze@/u;
const CODEQL_UPLOAD_SARIF = /^github\/codeql-action\/upload-sarif@/u;
/** The one spelling of an analysis that uploads everywhere but in a merge group. */
const UPLOAD_EXCEPT_MERGE_GROUP = "${{ github.event_name == 'merge_group' && 'never' || 'always' }}";
/** A step condition that keeps a step out of merge groups. */
const NOT_IN_MERGE_GROUP = /github\.event_name\s*!=\s*'merge_group'/u;

/**
 * A workflow that runs in the merge queue never uploads code scanning results
 * from a merge group: GitHub's code scanning merge protection does not apply to
 * merge queue groups, and the queue may delete the group's temporary branch
 * before an upload lands, which fails the required check with "ref ... not
 * found" (a configuration error; #736 was dropped from the queue by it). A
 * CodeQL `analyze` step sets `upload` to {@link UPLOAD_EXCEPT_MERGE_GROUP}, and
 * an `upload-sarif` step carries a condition that excludes merge groups.
 */
function codeScanningUploadViolations(workflow) {
  const { events, unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  if (!events.has("merge_group")) return [];
  const root = parseDocument(workflow.text).toJS({ maxAliasCount: 100 }) ?? {};
  const violations = [];
  for (const [jobName, job] of Object.entries(root.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      const uses = typeof step?.uses === "string" ? step.uses : "";
      const at = `${workflow.path}: jobs.${jobName}.steps[${String(index)}]`;
      if (CODEQL_ANALYZE.test(uses) && step.with?.upload !== UPLOAD_EXCEPT_MERGE_GROUP) {
        violations.push(`${at}: a CodeQL analysis in a merge-queue workflow uploads from merge groups (upload is ${JSON.stringify(step.with?.upload ?? "always")}; set it to ${UPLOAD_EXCEPT_MERGE_GROUP})`);
      }
      if (CODEQL_UPLOAD_SARIF.test(uses) && !NOT_IN_MERGE_GROUP.test(String(step.if ?? ""))) {
        violations.push(`${at}: a SARIF upload in a merge-queue workflow runs in merge groups (its condition must exclude github.event_name 'merge_group')`);
      }
    }
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
 * creates, edits or deletes one. Each step's `run:` is read as commands (the
 * shared shell reader: continuations joined, cut at `;` `&&` `||` `|`, each
 * tokenised; the string an `eval` or a shell's `-c` runs is read again), and
 * a command is a label write when it is:
 *   - `gh label create|edit|delete|clone`;
 *   - `gh api <endpoint>` on a label definition (`…/labels` or
 *     `…/labels/<name>`, never `…/issues/<n>/labels`, which applies a declared
 *     label) with a writing method, or with fields and no method (POST);
 *   - `curl` on such a URL with a writing method or a body;
 *   - `gh api graphql` whose query calls `createLabel`, `updateLabel` or
 *     `deleteLabel`, or whose query the rule cannot read (`@file`, `--input`).
 * The commands inside `$(…)` and backticks are read too. gh api's own flag
 * table says which flags consume a value, so the endpoint is its first
 * operand however many headers come first.
 * The program is found after any prefix (`sudo`, `timeout`, `env …`: prefixes
 * are not enumerated, as in the shared reader), so even an echoed write is read
 * as one. An actions/github-script step writes one when its script names
 * `createLabel`, `updateLabel` or `deleteLabel` (REST or GraphQL), or holds a
 * request on a label definition with a writing method
 * (`github.request('POST /repos/{owner}/{repo}/labels')`, `octokit.request`,
 * or the object form's `method` and `url`), read from its string literals.
 *
 * This rule is defence in depth. The structural limit is the token: no job
 * outside the declared ones may hold `issues: write` (see
 * {@link issuesWriteViolations}).
 */
const LABEL_SUBCOMMANDS = new Set(["create", "edit", "delete", "clone"]);
const WRITING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const GH_API_VALUE_OPTIONS = new Set(["-X", "--method", "-f", "-F", "--field", "--raw-field", "-H", "--header", "--input", "-q", "--jq", "-t", "--template", "--hostname", "--cache", "-p", "--preview"]);
const GH_API_FIELD_OPTIONS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);
const CURL_VALUE_OPTIONS = new Set(["-X", "--request", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-H", "--header", "-o", "--output", "-u", "--user", "-F", "--form"]);
const CURL_BODY_OPTIONS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-F", "--form"]);
const SCRIPT_LABEL_WRITES = new Set(["createLabel", "updateLabel", "deleteLabel"]);
const SHELLS = new Set(["sh", "bash", "dash", "zsh"]);

const programName = (word) => word.slice(word.lastIndexOf("/") + 1);
const identifiers = (text) => text.split(/[^A-Za-z0-9_$]+/u);
const namesLabelWrite = (text) => identifiers(text).some((word) => SCRIPT_LABEL_WRITES.has(word));

/** Every string literal of a script (single, double or backtick quotes; a backslash escapes), as its text. */
function stringLiterals(script) {
  const literals = [];
  for (let at = 0; at < script.length; at += 1) {
    const quote = script[at];
    if (quote !== "'" && quote !== "\"" && quote !== "`") continue;
    let text = "";
    let end = at + 1;
    for (; end < script.length && script[end] !== quote; end += 1) text += script[end] === "\\" ? script[++end] ?? "" : script[end];
    literals.push(text);
    at = end;
  }
  return literals;
}

/** Whether a github-script writes a label: a label-writing call by name, or a request on a label definition with a writing method. */
function githubScriptWritesLabel(script) {
  if (namesLabelWrite(script)) return true;
  const literals = stringLiterals(script).map((literal) => literal.trim());
  const routes = literals.map((literal) => literal.split(/\s+/u)).filter((words) => words.length === 2 && labelDefinitionPath(words[1]));
  if (routes.some(([method]) => WRITING_METHODS.has(method.toUpperCase()))) return true;
  return literals.some(labelDefinitionPath) && literals.some((literal) => WRITING_METHODS.has(literal.toUpperCase()));
}

/** A path or URL naming a label definition: a `labels` segment not under `issues/<n>` (or `pulls/<n>`). */
function labelDefinitionPath(target) {
  const path = target.includes("://") ? target.slice(target.indexOf("/", target.indexOf("://") + 3) + 1) : target;
  const segments = path.split("?")[0].split("/").filter((segment) => segment.length > 0);
  const at = segments.indexOf("labels");
  return at >= 0 && at >= segments.length - 2 && !(at >= 2 && (segments[at - 2] === "issues" || segments[at - 2] === "pulls"));
}

/** The option values and operands of `words` after a program: `-X POST`, `-XPOST` and `--method=POST` read alike. */
function readOptions(words, valueOptions) {
  const options = [];
  const operands = [];
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at];
    const equals = word.startsWith("--") ? word.indexOf("=") : -1;
    if (equals > 0) options.push([word.slice(0, equals), word.slice(equals + 1)]);
    else if (valueOptions.has(word)) { options.push([word, words[at + 1] ?? ""]); at += 1; }
    else if (/^-[A-Za-z]$/u.test(word.slice(0, 2)) && word.length > 2 && valueOptions.has(word.slice(0, 2))) options.push([word.slice(0, 2), word.slice(2)]);
    else if (word.startsWith("-")) options.push([word, null]);
    else operands.push(word);
  }
  return { options, operands };
}

/** Whether one command, as words, writes a label. */
function commandWritesLabel(words) {
  for (let at = 0; at < words.length; at += 1) {
    const program = programName(words[at]);
    const rest = words.slice(at + 1);
    if (program === "gh" && rest[0] === "label" && LABEL_SUBCOMMANDS.has(rest[1])) return true;
    if (program === "gh" && rest[0] === "api") {
      const { options, operands } = readOptions(rest.slice(1), GH_API_VALUE_OPTIONS);
      if (operands[0] === "graphql") {
        const query = options.filter(([name]) => GH_API_FIELD_OPTIONS.has(name));
        if (query.some(([name, value]) => name === "--input" || (value ?? "").includes("=@") || namesLabelWrite(value ?? ""))) return true;
        continue;
      }
      const method = options.find(([name]) => name === "-X" || name === "--method")?.[1]?.toUpperCase();
      const writes = method === undefined ? options.some(([name]) => GH_API_FIELD_OPTIONS.has(name)) : WRITING_METHODS.has(method);
      if (writes && operands.length > 0 && labelDefinitionPath(operands[0])) return true;
    }
    if (program === "curl") {
      const { options, operands } = readOptions(rest, CURL_VALUE_OPTIONS);
      const method = options.find(([name]) => name === "-X" || name === "--request")?.[1]?.toUpperCase();
      const writes = method === undefined ? options.some(([name]) => CURL_BODY_OPTIONS.has(name)) : WRITING_METHODS.has(method);
      if (writes && operands.some(labelDefinitionPath)) return true;
    }
    // The string an `eval` or a shell's `-c` runs is a command line of its own.
    const argumentAt = program === "eval" ? 0 : SHELLS.has(program) ? rest.findIndex((word) => /^-[A-Za-z]*c[A-Za-z]*$/u.test(word)) + 1 : -1;
    if (argumentAt >= 0 && argumentAt < rest.length && (program === "eval" || argumentAt > 0) && scriptWritesLabel(rest.slice(argumentAt).join(" "))) return true;
  }
  return false;
}

function scriptWritesLabel(text) {
  return [text, ...commandSubstitutions(text)].some((part) => shellCommands(part).some((command) => commandWritesLabel(shellWords(command))));
}

function labelWriteViolations(workflow) {
  const { unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  const document = parseDocument(workflow.text).toJS() ?? {};
  const violations = [];
  for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
    for (const [index, step] of (Array.isArray(job?.steps) ? job.steps : []).entries()) {
      const shell = typeof step?.run === "string" && scriptWritesLabel(step.run);
      const githubScript = typeof step?.uses === "string" && step.uses.startsWith("actions/github-script@") && typeof step?.with?.script === "string" &&
        githubScriptWritesLabel(step.with.script);
      if (shell || githubScript) {
        violations.push(`${workflow.path}: jobs.${jobName}.steps[${String(index)}] writes a label; the forge is the one label writer (declare it in docs/community/labels.json)`);
      }
    }
  }
  return violations;
}

/**
 * THE STRUCTURAL LIMIT: only the jobs declared here may hold `issues: write`,
 * through the workflow token (a job's `permissions`, or the workflow's when
 * the job sets none; `write-all` included) or an App token it mints
 * (`actions/create-github-app-token`'s `permission-issues: write`). Each entry
 * says why it needs it. Every other job is refused, whatever its steps run.
 */
const ISSUES_WRITE_JOBS = new Map([
  [".github/workflows/community.yml#comment", "IssueOps: answers a command on the issue it was typed on"],
  [".github/workflows/community.yml#welcome-issue", "welcomes a newcomer on their own issue"],
  [".github/workflows/workflow-failure-issue.yml#report", "the legacy failure reporter, retired by runbook P5.5 (MAIN-RED)"],
  [".github/workflows/reusable-workflow-failure.yml#report", "the legacy failure reporter, retired by runbook P5.5 (MAIN-RED)"],
]);

function grantsIssuesWrite(permissions) {
  return permissions === "write-all" || (permissions !== null && typeof permissions === "object" && permissions.issues === "write");
}

function issuesWriteViolations(workflow) {
  const { unreadable } = readWorkflow(workflow);
  if (unreadable.length > 0) return unreadable;
  const document = parseDocument(workflow.text).toJS() ?? {};
  const violations = [];
  for (const [jobName, job] of Object.entries(document.jobs ?? {})) {
    const token = grantsIssuesWrite(job?.permissions === undefined ? document.permissions : job.permissions);
    const app = (Array.isArray(job?.steps) ? job.steps : []).some((step) =>
      typeof step?.uses === "string" && step.uses.startsWith("actions/create-github-app-token@") && step?.with?.["permission-issues"] === "write");
    if ((token || app) && !ISSUES_WRITE_JOBS.has(`${workflow.path}#${jobName}`)) {
      violations.push(`${workflow.path}: jobs.${jobName} holds issues: write (${token ? "its token" : "an App token it mints"}) but is not a declared issue-writing job`);
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
  const required = declaredRequiredChecks();
  assert.ok(required.size > 0, "the forge's declaration names no required check; the reader no longer reads it");
  assert.deepEqual(workflows.flatMap((entry) => requiredSkipViolations(entry, required)), []);
  const paths = new Set(workflows.map((entry) => entry.path));
  for (const [path] of PULL_REQUEST_ONLY) {
    assert.ok(paths.has(path), `the exemption ${path} names no workflow`);
    const { events } = readWorkflow(workflows.find((entry) => entry.path === path));
    assert.ok(events.has("pull_request") && !events.has("merge_group"), `the exemption ${path} is stale`);
  }
});

test("no merge-queue workflow uploads code scanning results from a merge group: the live CodeQL workflow, and planted shapes", () => {
  for (const workflow of liveWorkflows()) assert.deepEqual(codeScanningUploadViolations(workflow), [], workflow.path);
  assert.ok(liveWorkflows().some((workflow) => /github\/codeql-action\/analyze@/u.test(workflow.text)), "the CodeQL analysis is still a live workflow");
  const analyze = (withBlock) => `on:\n  pull_request:\n  merge_group:\njobs:\n  analyze:\n    runs-on: ubuntu-24.04\n    steps:\n      - uses: github/codeql-action/analyze@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee\n${withBlock}`;
  const refused = {
    "upload left at its default": analyze(""),
    "upload always": analyze("        with:\n          upload: always\n"),
    "upload on another condition": analyze("        with:\n          upload: ${{ github.event_name == 'push' && 'always' || 'never' }}\n"),
    "a SARIF upload in merge groups": "on: [pull_request, merge_group]\njobs:\n  scan:\n    runs-on: x\n    steps:\n      - uses: github/codeql-action/upload-sarif@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee\n",
  };
  for (const [shape, text] of Object.entries(refused)) {
    assert.equal(codeScanningUploadViolations({ path: `planted/${shape}.yml`, text }).length, 1, shape);
  }
  const passing = {
    "upload except in merge groups": analyze(`        with:\n          upload: ${UPLOAD_EXCEPT_MERGE_GROUP}\n`),
    "a SARIF upload kept out of merge groups": "on: [pull_request, merge_group]\njobs:\n  scan:\n    runs-on: x\n    steps:\n      - uses: github/codeql-action/upload-sarif@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee\n        if: github.event_name != 'merge_group'\n",
    "no merge queue at all": "on: [push]\njobs:\n  analyze:\n    runs-on: x\n    steps:\n      - uses: github/codeql-action/analyze@6f2ac81f5cd81fe351a197ba0b00d91d03cd2aee\n",
  };
  for (const [shape, text] of Object.entries(passing)) {
    assert.deepEqual(codeScanningUploadViolations({ path: `planted/${shape}.yml`, text }), [], shape);
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
  const narrower = {
    "types missing synchronize": "on:\n  pull_request:\n    types: [opened, reopened, labeled]\n  merge_group:\njobs: {}\n",
    "types missing reopened": "on:\n  pull_request:\n    types: [opened, synchronize, labeled, unlabeled]\n  merge_group:\njobs: {}\n",
  };
  for (const [shape, text] of Object.entries(narrower)) {
    const found = mergeQueueViolations({ path: ".github/workflows/gate.yml", text });
    assert.equal(found.length, 1, `${shape}: ${JSON.stringify(found)}`);
    assert.match(found[0], /filters `pull_request` by `types`/u, shape);
  }
  const nearMisses = {
    "every default type, plus labeled and unlabeled": "on:\n  pull_request:\n    types: [opened, synchronize, reopened, labeled, unlabeled]\n  merge_group:\njobs: {}\n",
    "unfiltered gate, main push named": "on:\n  push:\n    branches: [main]\n  pull_request:\n  merge_group:\njobs: {}\n",
    "an empty settings map": "on: {pull_request: {}, merge_group: {}}\njobs: {}\n",
    "a path-filtered workflow outside the queue": "on:\n  push:\n    paths: ['docs/**']\njobs: {}\n",
  };
  for (const [shape, text] of Object.entries(nearMisses)) {
    assert.deepEqual(mergeQueueViolations({ path: ".github/workflows/near.yml", text }), [], shape);
  }
});

test("a required job never skips itself on the pull_request types a workflow adds; a job the forge does not require may", () => {
  const required = new Set(["Required job"]);
  const trigger = "on:\n  pull_request:\n    types: [opened, synchronize, reopened, labeled, unlabeled]\n  merge_group:\n";
  const skipping = `${trigger}jobs:\n  gate:\n    name: Required job\n    if: github.event.action != 'labeled'\n    runs-on: ubuntu-24.04\n    steps: [{run: 'true'}]\n`;
  const found = requiredSkipViolations({ path: ".github/workflows/skip.yml", text: skipping }, required);
  assert.equal(found.length, 1, JSON.stringify(found));
  assert.match(found[0], /skip\.yml:\d+: the required job "Required job" can skip itself/u);
  const byLabel = `${trigger}jobs:\n  gate:\n    name: Required job\n    if: github.event.label.name == 'visual-change'\n    runs-on: ubuntu-24.04\n    steps: [{run: 'true'}]\n`;
  assert.equal(requiredSkipViolations({ path: ".github/workflows/skip.yml", text: byLabel }, required).length, 1, "a condition on the label is one on the added event too");
  const notRequired = `${trigger}jobs:\n  build:\n    name: Build the site\n    if: github.event.action != 'labeled' && github.event.action != 'unlabeled'\n    runs-on: ubuntu-24.04\n    steps: [{run: 'true'}]\n`;
  assert.deepEqual(requiredSkipViolations({ path: ".github/workflows/near.yml", text: notRequired }, required), [], "a job the forge does not require may skip on a label event");
  const noSkip = `${trigger}jobs:\n  gate:\n    name: Required job\n    runs-on: ubuntu-24.04\n    steps: [{run: 'true'}]\n`;
  assert.deepEqual(requiredSkipViolations({ path: ".github/workflows/near.yml", text: noSkip }, required), [], "a required job that never skips runs on the label event too");
  const unfiltered = "on:\n  pull_request:\n  merge_group:\njobs:\n  gate:\n    name: Required job\n    if: github.event.action != 'labeled'\n    runs-on: ubuntu-24.04\n    steps: [{run: 'true'}]\n";
  assert.deepEqual(requiredSkipViolations({ path: ".github/workflows/near.yml", text: unfiltered }, required), [], "with no added types, no label event reaches the job");
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
    "curl --data '{\"name\":\"x\"}' https://api.github.com/repos/o/r/labels",
    "gh api --method=DELETE /repos/o/r/labels/x",
    "gh api -XPOST repos/o/r/labels --input label.json",
    "sudo gh label create x",
    "bash -c \"gh label create x\"",
    "eval gh label delete x --yes",
    "echo start && gh label create x",
    // Review of #270: headers before the method, a GraphQL mutation, substitutions.
    "gh api -H \"Accept: application/vnd.github+json\" -X POST repos/o/r/labels -f name=x",
    "gh api --header 'X-GitHub-Api-Version: 2022-11-28' --method PATCH repos/o/r/labels/x -f color=000000",
    "gh api -H Accept:application/json repos/o/r/labels -F name=x",
    "gh api graphql -f query='mutation { createLabel(input: {repositoryId: \"R\", name: \"x\", color: \"ffffff\"}) { label { id } } }'",
    "gh api graphql -F query=@mutation.graphql",
    "gh api graphql --input query.json",
    "echo \"$(gh label create x)\"",
    "id=$(gh api -X POST repos/o/r/labels -f name=x --jq .id)",
    "echo `gh label delete x --yes`",
    "out=$(echo $(gh label edit x --color 000000))",
  ]) {
    assert.equal(run(text).length, 1, text);
  }
  const script = (body) => plant(`      - uses: actions/github-script@v7\n        with:\n          script: |\n${body.split("\n").map((line) => `            ${line}`).join("\n")}`);
  for (const body of [
    "await github.rest.issues.createLabel({ owner, repo, name: 'x' });",
    "await github.request('POST /repos/{owner}/{repo}/labels', { owner, repo, name: 'x' });",
    "await octokit.request(\"DELETE /repos/{owner}/{repo}/labels/{name}\", { owner, repo, name: 'x' });",
    "await github.request({ method: 'PATCH', url: '/repos/o/r/labels/x', color: '000000' });",
    "await github.graphql(`mutation { deleteLabel(input: {id: \"L\"}) { clientMutationId } }`);",
  ]) {
    assert.equal(script(body).length, 1, body);
  }
  for (const body of [
    "await github.request('GET /repos/{owner}/{repo}/labels');",
    "await github.rest.issues.addLabels({ owner, repo, issue_number: 3, labels: ['ci-failure'] });",
    "await github.request('POST /repos/{owner}/{repo}/issues/3/labels', { labels: ['ci-failure'] });",
  ]) {
    assert.deepEqual(script(body), [], body);
  }
  for (const text of [
    "gh api \"repos/${GH_REPO}/labels/ci-failure\" --silent",
    "gh issue list --label ci-failure --state open",
    "gh issue create --label ci-failure --title t --body b",
    "gh issue edit 3 --add-label ci-failure",
    "gh api repos/o/r/issues/3/labels -f 'labels[]=ci-failure'",
    "gh api repos/o/r/labels",
    "gh api -X GET repos/o/r/labels/x",
    "curl https://api.github.com/repos/o/r/labels",
    "curl -X POST https://api.github.com/repos/o/r/issues/3/labels -d '[\"ci-failure\"]'",
    "gh label list --search lane:",
    "gh pr edit 4 --add-label ci-failure",
    "gh api -H \"Accept: application/vnd.github+json\" repos/o/r/labels/x",
    "gh api graphql -f query='query { repository(owner: \"o\", name: \"r\") { labels(first: 10) { nodes { name } } } }'",
    "n=$(gh issue list --label ci-failure --json number --jq length)",
  ]) {
    assert.deepEqual(run(text), [], text);
  }
});

test("only the declared jobs hold issues: write, through the workflow token or an App token they mint", () => {
  assert.deepEqual(liveWorkflows().flatMap(issuesWriteViolations), []);
  const plant = (text) => issuesWriteViolations({ path: ".github/workflows/plant.yml", text });
  for (const text of [
    "on: push\npermissions:\n  issues: write\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: true\n",
    "on: push\njobs:\n  j:\n    runs-on: x\n    permissions:\n      issues: write\n    steps:\n      - run: true\n",
    "on: push\npermissions: write-all\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: true\n",
    "on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/create-github-app-token@0\n        with:\n          permission-issues: write\n",
    "on: push\njobs:\n  j:\n    permissions:\n      issues: write\n    uses: ./.github/workflows/other.yml\n",
  ]) {
    assert.equal(plant(text).length, 1, text);
  }
  for (const text of [
    "on: push\npermissions:\n  issues: read\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: true\n",
    "on: push\npermissions:\n  issues: write\njobs:\n  j:\n    runs-on: x\n    permissions:\n      contents: read\n    steps:\n      - run: true\n",
    "on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: actions/create-github-app-token@0\n        with:\n          permission-pull-requests: write\n",
  ]) {
    assert.deepEqual(plant(text), [], text);
  }
  // A declared job is declared by its workflow AND its name: the same job name elsewhere is refused.
  assert.deepEqual(issuesWriteViolations({ path: ".github/workflows/community.yml", text: "on: issue_comment\njobs:\n  comment:\n    runs-on: x\n    permissions:\n      issues: write\n    steps:\n      - run: true\n" }), []);
  assert.equal(issuesWriteViolations({ path: ".github/workflows/other.yml", text: "on: issue_comment\njobs:\n  comment:\n    runs-on: x\n    permissions:\n      issues: write\n    steps:\n      - run: true\n" }).length, 1);
});
