import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { verifyAuditMatrix } from "../scripts/tooling/verification/slice-traces.ts";
import { AUDIT_MATRIX_SCHEMA } from "../src/kernel/requirements.ts";

type AuditMatrix = Parameters<typeof verifyAuditMatrix>[0];
type MutableAssessment = {
  applicability: "applicable" | "not-applicable";
  outcome: "pass" | "fail" | "n/a" | "unassessed";
  evidenceLinks: string[];
};
type MutableMatrix = AuditMatrix & {
  angles: Array<AuditMatrix["angles"][number] & {
    surfaceAssessments: { builder: MutableAssessment; runtime: MutableAssessment };
  }>;
  independentAudit: AuditMatrix["independentAudit"] & {
    outcome: "pass" | "fail" | "unassessed";
    evidenceLinks: string[];
  };
};

/**
 * Derive the audit-matrix slice set DYNAMICALLY from the traceability
 * directory: every `traceability/*.json` whose top-level shape carries an
 * `auditMatrix` field is an audit-matrix slice that must remain an honest
 * pre-admission draft. A newly added slice is auto-covered (deny-by-
 * default); no hand-maintained path list that would silently miss it when
 * the slice set grows. Schema/inventory files (which lack `auditMatrix`)
 * are auto-excluded by the content check, so a naming convention is not
 * relied upon.
 */
function discoverAuditMatrixPaths(): readonly string[] {
  const dir = join(process.cwd(), "traceability");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => `traceability/${name}`)
    .filter((rel) => {
      try {
        const trace = JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8")) as { auditMatrix?: unknown };
        return typeof trace.auditMatrix === "object" && trace.auditMatrix !== null;
      } catch {
        return false;
      }
    })
    .sort();
}

const TRACE_PATHS = discoverAuditMatrixPaths();

function loadMutableMatrix(path: string): MutableMatrix {
  const trace = JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8")) as {
    auditMatrix: unknown;
  };
  return structuredClone(AUDIT_MATRIX_SCHEMA.parse(trace.auditMatrix)) as unknown as MutableMatrix;
}

function violations(matrix: AuditMatrix, slice: string): readonly string[] {
  const found: string[] = [];
  verifyAuditMatrix(matrix, slice, found);
  return found;
}

test("audit-matrix discovery is non-empty (the dynamic slice set is exercised)", () => {
  // Non-empty guard: a broken discovery must not make the matrix checks
  // vacuously pass. The traceability directory must contain at least one
  // audit-matrix slice.
  assert.ok(TRACE_PATHS.length > 0, "the dynamically discovered audit-matrix slice set must be non-empty (traceability/*.json with an auditMatrix field)");
});

test("all checked-in slice matrices remain honest pre-admission drafts", () => {
  for (const path of TRACE_PATHS) {
    assert.deepEqual(violations(loadMutableMatrix(path), path), [], path);
  }
});

test("fabricated pass, failure, n/a, and independent-audit outcomes cannot bypass evidence admission", () => {
  for (const path of TRACE_PATHS) {
    for (const outcome of ["pass", "fail"] as const) {
      const matrix = loadMutableMatrix(path);
      matrix.angles[0]!.surfaceAssessments.builder.outcome = outcome;
      matrix.angles[0]!.surfaceAssessments.builder.evidenceLinks = [
        "traceability/canonical/harness-requirements.md",
      ];
      assert.equal(
        violations(matrix, path).includes(
          `audit-matrix-outcome-before-evidence-admission:${path}:alignment:builder`,
        ),
        true,
        `${path}:${outcome}`,
      );
    }

    const notApplicable = loadMutableMatrix(path);
    notApplicable.angles[0]!.surfaceAssessments.builder.applicability = "not-applicable";
    notApplicable.angles[0]!.surfaceAssessments.builder.outcome = "n/a";
    notApplicable.angles[0]!.surfaceAssessments.builder.evidenceLinks = ["fabricated://alignment"];
    assert.equal(
      violations(notApplicable, path).includes(
        `audit-matrix-outcome-before-evidence-admission:${path}:alignment:builder`,
      ),
      true,
      `${path}:n/a`,
    );

    const independent = loadMutableMatrix(path);
    independent.independentAudit.outcome = "pass";
    independent.independentAudit.evidenceLinks = ["fabricated://independent"];
    assert.equal(
      violations(independent, path).includes(
        `audit-matrix-independent-outcome-before-evidence-admission:${path}`,
      ),
      true,
      `${path}:independent`,
    );
  }
});
