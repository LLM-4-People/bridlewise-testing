import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { FORGE_APP_ROLES, FORGE_APPS } from "../../engine/src/workflow/forge/app-registry.ts";

/**
 * THE ENVIRONMENT APPS' AUDIT JOB (`.github/workflows/forge-apps-audit.yml`,
 * runbook P1.11, GH-KEYS) AGREES WITH THE APP REGISTRY. The door's and the
 * publisher's keys exist only as their environments' secrets, so their audit
 * runs in a job of that environment.
 * - the matrix holds exactly the environment Apps, each in its own environment;
 * - the audit step hands in exactly the secret and variable names the
 *   registry declares, the key from `secrets` and the client id from `vars`;
 * - it runs `harness forge apps audit --role <role>`;
 * - it is started by hand only;
 * - no secret appears anywhere else in the file, the run's token is exactly
 *   `contents: read`, and no dependency's install script runs in the job.
 * Read as YAML (the repository's one YAML reader), never line by line.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = parse(readFileSync(join(ROOT, ".github/workflows/forge-apps-audit.yml"), "utf8"));

test("the audit job runs each environment App in its own environment, handed exactly the registry's key and client id", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  const job = workflow.jobs.audit;
  assert.equal(job.environment, "${{ matrix.environment }}");
  const environmentApps = FORGE_APP_ROLES.filter((role) => FORGE_APPS[role].custody.kind === "environment");
  assert.deepEqual(job.strategy.matrix.include, environmentApps.map((role) => ({ role, environment: FORGE_APPS[role].custody.environment })));
  const step = job.steps.find((candidate) => candidate.name === "Audit the installation");
  assert.equal(step.run, 'node src/cli.ts harness forge apps audit --role "${{ matrix.role }}"');
  const expected = Object.fromEntries(environmentApps.flatMap((role) => {
    const custody = FORGE_APPS[role].custody;
    return [
      [custody.keySecret, `\${{ matrix.role == '${role}' && secrets.${custody.keySecret} || '' }}`],
      [custody.clientIdVariable, `\${{ matrix.role == '${role}' && vars.${custody.clientIdVariable} || '' }}`],
    ];
  }));
  assert.deepEqual(step.env, expected, "each job is handed only its own App's key and client id");
});

/** Every string in `value`, with its path in the document. */
function stringsOf(value, path = []) {
  if (typeof value === "string") return [{ path: path.join("."), text: value }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => stringsOf(entry, [...path, String(index)]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([key, entry]) => [...stringsOf(key, [...path, `<key ${key}>`]), ...stringsOf(entry, [...path, key])]);
  return [];
}

test("a key is handed to the audit step alone: no secret anywhere else, the run's token reads only, and no dependency script runs beside it", () => {
  const job = workflow.jobs.audit;
  const index = job.steps.findIndex((candidate) => candidate.name === "Audit the installation");
  const allowed = new Set(FORGE_APP_ROLES.filter((role) => FORGE_APPS[role].custody.kind === "environment").map((role) => `jobs.audit.steps.${index}.env.${FORGE_APPS[role].custody.keySecret}`));
  const secrets = stringsOf(workflow).filter((entry) => /\bsecrets\b/u.test(entry.text));
  assert.deepEqual(secrets.map((entry) => entry.path).filter((path) => !allowed.has(path)), [], "a secret appears outside the audit step's env");
  assert.equal(secrets.length, allowed.size, "each key once, in that step");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(job.permissions, { contents: "read" }, "the job's token is exactly read access");
  const installs = (candidate) => typeof candidate.run === "string" && candidate.run.split(/\s+/u).includes("npm") && candidate.run.split(/\s+/u).includes("ci");
  for (const step of job.steps.filter(installs)) {
    assert.match(step.run, /--ignore-scripts/u, `${step.name} runs no dependency script`);
  }
  assert.ok(job.steps.some(installs), "the job installs (the check is not vacuous)");
});
