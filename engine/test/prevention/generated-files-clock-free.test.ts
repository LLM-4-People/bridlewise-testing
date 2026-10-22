/**
 * A GENERATED FILE HOLDS NO WALL-CLOCK TIME (#221).
 *
 * WHY — measured. A committed generated file that records when it was
 * written (`generatedAt`, `capturedAt`) changes on every regeneration even
 * when nothing it describes changed, so two branches that regenerate it always
 * conflict, and a regeneration is never a no-op to compare against. The
 * artifact manifest carried two such stamps until v4. A generated file is a
 * pure function of the tree: the same tree generates the same bytes, at any
 * time, on any machine.
 *
 * The population is every file whose WHOLE text a generator writes
 * (`wholesaleGeneratedPaths`): partly generated files (a README's consumer
 * block, a pin inside an authored module) also hold prose an author dated on
 * purpose. Each is read as committed and refused when it holds an ISO-8601
 * date-time or a time-of-generation field.
 *
 * GUARD SUBJECT: no wholly generated committed file records a wall-clock time
 * GUARD OWNS: every path of `wholesaleGeneratedPaths()`, read as committed
 * GUARD PLANT: a `"generatedAt": "2026-10-22T12:00:00Z"` field, a bare ISO date-time and a `capturedAt` field are each found; a date alone and a digest are not
 * GUARD DRIVEN: read each wholly generated file of the live tree and match the clock patterns over its text
 * GUARD LIVENESS: the population is asserted to hold the artifact manifest and the config schema, each read non-empty
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { wholesaleGeneratedPaths } from "../../src/workflow/hash-binding-registry.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");

/** An ISO-8601 date-time (a date with a time of day), or a field whose name says it records when it was written. */
const CLOCK = [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u, /"(?:generatedAt|capturedAt|writtenAt|updatedAt|timestamp)"\s*:/u] as const;

function clockFindings(text: string): readonly string[] {
  return CLOCK.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match === null ? [] : [match[0]];
  });
}

test("GeneratedFilesClockFree: no wholly generated file records a wall-clock time", () => {
  const paths = [...wholesaleGeneratedPaths()].toSorted();
  assert.ok(paths.includes(`engine/${ROOT_POLICY.artifactGovernance.canonicalInventory}`), `the artifact manifest is in the population (liveness): ${paths.join(", ")}`);
  assert.ok(paths.includes(`engine/${ROOT_POLICY.configuration.contract.generatedSchemaPath}`), "the config schema is in the population (liveness)");
  const found = paths.flatMap((path) => {
    const absolute = resolve(REPOSITORY_ROOT, path);
    assert.ok(existsSync(absolute), `${path} is generated and committed, so it is present`);
    const text = readFileSync(absolute, "utf8");
    assert.ok(text.length > 0, `${path} is read non-empty`);
    return clockFindings(text).map((finding) => `${path}: ${finding}`);
  });
  assert.deepEqual(found, [], "a generated file is a pure function of the tree: record no time of generation in it");
});

test("GeneratedFilesClockFree: the scan finds a planted time and leaves a date and a digest alone", () => {
  assert.equal(clockFindings('{"generatedAt":"2026-10-22T12:00:00Z"}').length, 2, "a time-of-generation field with its date-time");
  assert.equal(clockFindings("written 2026-10-22 12:00 by hand").length, 1, "a bare date-time");
  assert.equal(clockFindings('{"capturedAt": 1761134400000}').length, 1, "a time-of-generation field holding epoch milliseconds");
  assert.deepEqual(clockFindings('{"date":"2026-10-22","sha256":"2026102212000000abcdef"}'), [], "a date alone and a digest are not times");
});
