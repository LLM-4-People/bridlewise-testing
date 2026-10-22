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
 * - it is started by hand only.
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
