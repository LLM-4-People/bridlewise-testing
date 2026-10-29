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
 *
 * WHO MAY RUN INSTALL SCRIPTS. `ignore-scripts: "false"` runs the engine's
 * dependencies' lifecycle scripts. Only the jobs in INSTALL_SCRIPTS_ALLOWED may
 * pass it, each with its reason, and no job in that table may hold a
 * credential (a secret, the workflow token, or an App token it mints): a
 * dependency's script never runs next to one.
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

/** The commands of one shell line (split at `&&`, `||`, `;` and `|`), each as its words with quotes stripped. */
const commandsOf = (line) => line.split(/&&|\|\||;|\|/u).map((command) => command.trim().split(/\s+/u).filter(Boolean).map((word) => word.replace(/^["']|["']$/gu, "")));
/** An npm install command among a line's commands (`npm ci`, `npm --prefix x install`, `npm i`). */
const npmInstall = (line) => commandsOf(line).some((words) => words[0] === "npm" && words.slice(1).some((word) => ["ci", "install", "i"].includes(word)));
/** An engine install in a run line: an npm install with the engine named on the same line (`--prefix engine`, `cd engine && npm ci`). */
const engineInstall = (line) => /\bengine\b/u.test(line) && npmInstall(line);
/** A chmod of the engine configuration among a line's commands. */
const configChmod = (line) => commandsOf(line).some((words) => words[0] === "chmod" && words.slice(1).some((word) => word.endsWith("bridlewise.config.json")));

/** The files that may still set the engine up by hand, each with its follow-up. */
const TEMPORARY_EXCEPTIONS = Object.freeze(new Map([
  [".github/workflows/commit-records.yml", "#743: it checks out the base, which has no engine-setup until #725 is on main"],
]));

/**
 * The jobs that may run the engine's install scripts (`workflow#job` → why). The
 * one engine dependency with an install script is esbuild, the bundler, so
 * these are the jobs that build the engine bundle. A job holding a credential
 * can never be listed here.
 */
const INSTALL_SCRIPTS_ALLOWED = Object.freeze(new Map([
  [".github/workflows/ci.yml#gate", "builds the engine bundle (npm --prefix engine run build:bundle) with esbuild"],
  [".github/workflows/ci.yml#generated", "harness sync --with-bundle builds the engine bundle with esbuild"],
  [".github/workflows/ci.yml#engine-suite", "builds the engine bundle with esbuild before the suite"],
  [".github/workflows/test-shards.yml#shard", "builds the engine bundle with esbuild before its shard"],
]));

/** A credential a job holds: a secret, the workflow token, or an App token it mints. */
const CREDENTIAL = /\bsecrets\.|\bgithub\.token\b|create-github-app-token/u;

/** Every engine-setup call: `{ key, ignoreScripts, credential }` (`workflow#job`, or the action file that calls it). */
function engineSetupCalls(texts) {
  return Object.entries(texts).flatMap(([path, text]) => {
    const document = parse(text);
    const units = document?.jobs !== undefined ? Object.entries(document.jobs).map(([job, body]) => [`${path}#${job}`, body, body?.steps]) : [[path, document, document?.runs?.steps]];
    return units.flatMap(([key, body, steps]) => (Array.isArray(steps) ? steps : [])
      .filter((step) => step?.uses === "./.github/actions/engine-setup")
      .map((step) => ({ key, ignoreScripts: String(step.with?.["ignore-scripts"]), credential: CREDENTIAL.test(JSON.stringify(body)) })));
  });
}

/** The install-script violations of the calls in `texts` against `allowed`. */
export function installScriptViolations(texts, allowed = INSTALL_SCRIPTS_ALLOWED) {
  const calls = engineSetupCalls(texts);
  const found = [];
  for (const call of calls) {
    if (call.ignoreScripts === "false" && !allowed.has(call.key)) found.push(`${call.key} runs the engine's install scripts but is not in INSTALL_SCRIPTS_ALLOWED`);
  }
  for (const [key, why] of allowed) {
    const call = calls.find((entry) => entry.key === key);
    if (call === undefined || call.ignoreScripts !== "false") found.push(`${key} is in INSTALL_SCRIPTS_ALLOWED (${why}) but runs no install scripts: remove it`);
    else if (call.credential) found.push(`${key} holds a credential, so it may never run install scripts: pass ignore-scripts "true"`);
  }
  return found;
}

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
        if (engineInstall(line) || (inEngine && npmInstall(line))) found.push(`${path}: ${at} installs the engine by hand (${line.trim()}); use ${ACTION}`);
        if (configChmod(line)) found.push(`${path}: ${at} sets the configuration's mode by hand (${line.trim()}); use ${ACTION}`);
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
  const plant = (step) => unexcepted(handSetups({ ...texts, [ci]: texts[ci].replace("    steps:\n", `    steps:\n${step}`) }));
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
  assert.ok(stepsOf(action).some(({ step }) => String(step.run ?? "").split("\n").some(configChmod)), "the action sets the configuration's mode");
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

test("only the declared jobs run the engine's install scripts, and none of them holds a credential", () => {
  const texts = liveTexts();
  assert.deepEqual(installScriptViolations(texts), []);
  // The detector sees the credentials it guards against (positive controls).
  const calls = engineSetupCalls(texts);
  for (const key of [".github/workflows/forge-apps-audit.yml#audit", ".github/workflows/community.yml#comment", ".github/workflows/pages.yml#deploy"]) {
    assert.equal(calls.find((call) => call.key === key)?.credential, true, key);
  }
  const flip = (path, job) => {
    const lines = texts[path].split("\n");
    let inJob = false;
    return { ...texts, [path]: lines.map((line) => {
      if (/^  \S+:\s*$/u.test(line)) inJob = line.trim() === `${job}:`;
      return inJob && line.trim() === 'ignore-scripts: "true"' ? line.replace('"true"', '"false"') : line;
    }).join("\n") };
  };
  // Plants: a credentialed job flipped to scripts; the same job then listed in the table; a listed job given a secret; a stale entry.
  const audit = ".github/workflows/forge-apps-audit.yml";
  assert.match(installScriptViolations(flip(audit, "audit")).join(), /forge-apps-audit\.yml#audit runs the engine's install scripts but is not in INSTALL_SCRIPTS_ALLOWED/u);
  const listed = new Map([...INSTALL_SCRIPTS_ALLOWED, [`${audit}#audit`, "planted"]]);
  assert.match(installScriptViolations(flip(audit, "audit"), listed).join(), /forge-apps-audit\.yml#audit holds a credential, so it may never run install scripts/u);
  const ci = ".github/workflows/ci.yml";
  const secret = { ...texts, [ci]: texts[ci].replace("  generated:\n", "  generated:\n    env:\n      PLANTED: ${{ secrets.PLANTED }}\n") };
  assert.match(installScriptViolations(secret).join(), /ci\.yml#generated holds a credential/u);
  assert.match(installScriptViolations(texts, new Map([...INSTALL_SCRIPTS_ALLOWED, [`${ci}#rendered`, "planted"]])).join(), /ci\.yml#rendered is in INSTALL_SCRIPTS_ALLOWED \(planted\) but runs no install scripts/u);
});
