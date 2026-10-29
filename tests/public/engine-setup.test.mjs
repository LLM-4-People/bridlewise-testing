/**
 * THE ONE ENGINE SETUP (#725): every job installs the engine and sets its
 * configuration's mode through `.github/actions/engine-setup`, directly or
 * through `site-build-setup`, so the setup cannot drift between jobs. Proven
 * on the tree (no workflow or other local action installs the engine or
 * chmods its configuration by hand, read as YAML) and on the action itself
 * (its install runs against a stub `npm`: `ignore-scripts` is strictly
 * `true` or `false`).
 *
 * ONE TEMPORARY EXCEPTION, `commit-records.yml`: it checks out the BASE (main's
 * judge), so it reads the action from main, which lacks it until #725 lands.
 * Its follow-up (#743) routes it and removes the entry, and an entry whose
 * file no longer sets the engine up by hand is refused, so the exception
 * cannot linger.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ACTION = ".github/actions/engine-setup/action.yml";

/** An npm install command in a run line (`npm ci`, `npm --prefix x install`, `npm i`). */
const NPM_INSTALL = /\bnpm\s+(?:\S+\s+)*?(?:ci|install|i)(?:\s|$)/u;
/** An engine install in a run line: an npm install with the engine named on the same line (`--prefix engine`, `cd engine && npm ci`). */
const engineInstall = (line) => /\bengine\b/u.test(line) && NPM_INSTALL.test(line);
/** A chmod of the engine configuration. */
const CONFIG_CHMOD = /\bchmod\b[^\n]*bridlewise\.config\.json/u;

/** The files that may still set the engine up by hand, each with its follow-up. */
const TEMPORARY_EXCEPTIONS = Object.freeze(new Map([
  [".github/workflows/commit-records.yml", "#743: it checks out the base, which has no engine-setup until #725 is on main"],
]));

/** Every workflow and local action file of the tree, repository-relative. */
function setupFiles(root = ROOT) {
  const workflows = readdirSync(join(root, ".github/workflows")).filter((name) => /\.ya?ml$/u.test(name)).map((name) => `.github/workflows/${name}`);
  const actions = readdirSync(join(root, ".github/actions"), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => ["action.yml", "action.yaml"].map((file) => `.github/actions/${entry.name}/${file}`))
    .filter((path) => existsSync(join(root, path)));
  return [...workflows, ...actions].sort();
}

/** Every step of a workflow's jobs or a composite action, with where it sits. */
function stepsOf(document) {
  const jobs = Object.entries(document?.jobs ?? {}).flatMap(([job, body]) => (Array.isArray(body?.steps) ? body.steps.map((step, index) => ({ at: `jobs.${job}.steps[${String(index)}]`, step })) : []));
  const composite = Array.isArray(document?.runs?.steps) ? document.runs.steps.map((step, index) => ({ at: `runs.steps[${String(index)}]`, step })) : [];
  return [...jobs, ...composite];
}

/** The hand-written engine setups of the files `texts` (`path → YAML text`), outside the one action. */
export function handSetups(texts) {
  const found = [];
  for (const [path, text] of Object.entries(texts)) {
    if (path === ACTION) continue;
    for (const { at, step } of stepsOf(parse(text))) {
      const run = typeof step?.run === "string" ? step.run : "";
      const inEngine = typeof step?.["working-directory"] === "string" && /(?:^|\/)engine\/?$/u.test(step["working-directory"]);
      for (const line of run.split("\n")) {
        if (engineInstall(line) || (inEngine && NPM_INSTALL.test(line))) found.push(`${path}: ${at} installs the engine by hand (${line.trim()}); use ${ACTION}`);
        if (CONFIG_CHMOD.test(line)) found.push(`${path}: ${at} sets the configuration's mode by hand (${line.trim()}); use ${ACTION}`);
      }
    }
  }
  return found;
}

/** The findings outside the temporary exceptions. */
const unexcepted = (found) => found.filter((finding) => ![...TEMPORARY_EXCEPTIONS.keys()].some((path) => finding.startsWith(`${path}: `)));

const liveTexts = () => Object.fromEntries(setupFiles().map((path) => [path, readFileSync(join(ROOT, path), "utf8")]));

test("no workflow or other local action installs the engine or sets its configuration's mode by hand", () => {
  const texts = liveTexts();
  assert.ok(ACTION in texts, "the one engine setup exists");
  const found = handSetups(texts);
  assert.deepEqual(unexcepted(found), []);
  // An exception that sets nothing up by hand any more is refused: its follow-up removes it.
  for (const [path, why] of TEMPORARY_EXCEPTIONS) assert.ok(found.some((finding) => finding.startsWith(`${path}: `)), `${path} no longer sets the engine up by hand: remove its temporary exception (${why})`);
  // Plants: a hand install (each spelling), a configuration chmod, an install in the engine's folder, inside a multi-line block.
  const ci = ".github/workflows/ci.yml";
  const plant = (step) => unexcepted(handSetups({ ...texts, [ci]: texts[ci].replace(/\njobs:\n  (\S+):\n([\s\S]*?)    steps:\n/u, (whole) => `${whole}${step}`) }));
  for (const step of [
    "      - run: npm --prefix engine ci --no-audit --no-fund\n",
    "      - run: npm ci --prefix engine\n",
    "      - run: cd engine && npm ci\n",
    "      - run: |\n          echo setup\n          npm --prefix \"$ROOT/engine\" install\n",
    "      - working-directory: engine\n        run: npm ci\n",
  ]) assert.match(plant(step).join(), /installs the engine by hand/u, step);
  assert.match(plant("      - run: chmod 600 engine/bridlewise.config.json\n").join(), /sets the configuration's mode by hand/u);
  // Near misses: the engine's own scripts and a web install.
  assert.deepEqual(plant("      - run: npm --prefix engine run build:bundle\n"), []);
  assert.deepEqual(plant("      - run: npm ci --no-audit --no-fund\n"), []);
});

test("every job that sets the engine up calls the one action, and site-build-setup builds on it", () => {
  const texts = liveTexts();
  const calls = Object.entries(texts).flatMap(([path, text]) => stepsOf(parse(text)).filter(({ step }) => step?.uses === "./.github/actions/engine-setup").map(({ step }) => ({ path, step })));
  assert.ok(calls.some(({ path }) => path === ".github/actions/site-build-setup/action.yml"), "site-build-setup calls engine-setup");
  for (const { path, step } of calls) assert.ok(["true", "false"].includes(String(step.with?.["ignore-scripts"])), `${path} says whether the install runs scripts`);
  const action = parse(texts[ACTION]);
  assert.equal(action.runs.using, "composite");
  assert.equal(action.inputs["ignore-scripts"].required, true);
  // The inputs reach the shell as data, never spliced into a command line.
  for (const { step } of stepsOf(action)) assert.ok(!String(step.run ?? "").includes("${{"), "no expression inside the run text");
  assert.ok(stepsOf(action).some(({ step }) => CONFIG_CHMOD.test(String(step.run))), "the action sets the configuration's mode");
});

test("the action's install takes ignore-scripts strictly true or false", () => {
  const install = stepsOf(parse(readFileSync(join(ROOT, ACTION), "utf8"))).find(({ step }) => /\bnpm\b/u.test(String(step.run ?? ""))).step;
  const bin = mkdtempSync(join(tmpdir(), "engine-setup-"));
  writeFileSync(join(bin, "npm"), "#!/bin/sh\necho \"npm $*\"\n");
  chmodSync(join(bin, "npm"), 0o755);
  const run = (value) => spawnSync("bash", ["-c", install.run], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH ?? ""}`, ROOT: "/checkout", IGNORE_SCRIPTS: value } });
  assert.equal(run("true").stdout.trim(), "npm --prefix /checkout/engine ci --no-audit --no-fund --ignore-scripts");
  assert.equal(run("false").stdout.trim(), "npm --prefix /checkout/engine ci --no-audit --no-fund");
  for (const value of ["", "yes", "TRUE", "1", "true "]) {
    const refused = run(value);
    assert.notEqual(refused.status, 0, JSON.stringify(value));
    assert.equal(refused.stdout.includes("npm "), false, "nothing is installed");
    assert.match(refused.stdout, /ignore-scripts must be true or false/u);
  }
});
