import assert from "node:assert/strict";
import test from "node:test";

import type { AuthorityRegistry } from "../../scripts/verification/authority-graph.ts";
import {
  analyze,
  assertOnlyFoundationBlockers,
  BASE_SOURCES,
  CONSUMER_SOURCE,
  has,
  OWNER_SOURCE,
  registry,
  source,
} from "../support/authority-graph-fixture.ts";

test("[AG-C001] derived references and schema materializations compile into a deterministic lock", () => {
  const first = analyze();
  const second = analyze();
  assert.equal(first.ok, false);
  assert.equal(assertOnlyFoundationBlockers(first), true, first.violations.join("\n"));
  assert.equal(first.lock.lockHash, second.lock.lockHash);
  assert.deepEqual(first.lock, second.lock);
  assert.ok(first.lock.occurrences.some((entry) =>
    entry.authorityId === "receipt.version" && entry.role === "reference"));
  assert.ok(first.lock.occurrences.some((entry) =>
    entry.authorityId === "test.surface.scope" && entry.role === "materialization"));
});

test("[AG-C002] direct, concatenated, template, owner-module, and same-export literal copies are exact", () => {
  const copies = [
    `export const COPIED = "example.test-result/v4";`,
    `export const COPIED = "example.test-result" + "/v4";`,
    "export const COPIED = `example.test-result/v4`;",
  ];
  for (const [index, copy] of copies.entries()) {
    const candidate = source(`src/copy-${index}.ts`, copy);
    const sources = [...BASE_SOURCES, candidate];
    assert.equal(has(analyze(sources, registry(sources)), "authority_literal_duplicate:receipt.version"), true);
  }

  const ownerWithCopy = source("src/owner.ts", OWNER_SOURCE.replace(
    `export const CURRENT_VERSION = "example.test-result/v4";`,
    `export const CURRENT_VERSION = "example.test-result/v4";
     export const COPIED_VERSION = "example.test-result/v4";`,
  ));
  const ownerSources = [ownerWithCopy, BASE_SOURCES[1]!];
  assert.equal(has(analyze(ownerSources, registry(ownerSources)),
    "authority_literal_duplicate:receipt.version:src/owner.ts"), true);

  const both = source("test/both.ts", `
    export const BOTH = ["example.test-result/v3", "example.test-result/v4"];
  `);
  const bothSources = [...BASE_SOURCES, both];
  const result = analyze(bothSources, registry(bothSources));
  const candidates = result.lock.occurrences.filter((entry) =>
    entry.authorityId === "receipt.version" && entry.path === both.path && entry.occurrenceKind === "literal");
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0]?.selector, candidates[1]?.selector);

  const scopedOwner = source("src/owner.ts", OWNER_SOURCE.replace(
    `export const CURRENT_VERSION = "example.test-result/v4";`,
    `function historical() { const PART = "/v3"; return PART; }
     const PART = "/v4";
     export const CURRENT_VERSION = "example.test-result" + PART;`,
  ));
  const scopedSources = [scopedOwner, BASE_SOURCES[1]!];
  const scoped = analyze(scopedSources, registry(scopedSources));
  assert.equal(has(scoped, "authority_owner_unsupported:receipt.version"), false, scoped.violations.join("\n"));
  assert.equal(scoped.lock.authorities.find((entry) => entry.id === "receipt.version")?.semanticFingerprint,
    analyze().lock.authorities.find((entry) => entry.id === "receipt.version")?.semanticFingerprint);
});

test("[AG-C003] type, interface, Zod, object, and spread shape twins are detected", () => {
  const copies = [
    `export type Copy = Readonly<{
      dispositionManifestHash: string;
      canonicalNodeSourceIds: readonly string[];
      fullRepositoryTestQualificationComplete: boolean;
    }>;`,
    `export interface Copy {
      dispositionManifestHash: string;
      canonicalNodeSourceIds: readonly string[];
      fullRepositoryTestQualificationComplete: boolean;
    }`,
    `import { z } from "zod";
     export const COPY = z.strictObject({
       dispositionManifestHash: z.string(), canonicalNodeSourceIds: z.array(z.string()),
       fullRepositoryTestQualificationComplete: z.boolean(),
     });`,
    `export const COPY = {
      dispositionManifestHash: "a", canonicalNodeSourceIds: [],
      fullRepositoryTestQualificationComplete: true,
    };`,
    `const BASE = { dispositionManifestHash: "a", canonicalNodeSourceIds: [] };
     export const COPY = { ...BASE, fullRepositoryTestQualificationComplete: true };`,
  ];
  for (const [index, copy] of copies.entries()) {
    const candidate = source(`test/copied-shape-${index}.ts`, copy);
    const sources = [...BASE_SOURCES, candidate];
    assert.equal(has(analyze(sources, registry(sources)), "authority_shape_duplicate:test.surface.scope"), true);
  }
});

test("[AG-C004] shape semantics retain types, optionality, validators, readonly, unions, and one-field authority", () => {
  const owner = source("src/semantic-owner.ts", `
    import { z } from "zod";
    export const SCOPE_SCHEMA = z.strictObject({
      value: z.string().min(3), mode: z.union([z.string(), z.number()]),
    });
  `);
  const same = source("src/same.ts", `export type Same = Readonly<{ value: string; mode: string | number }>;`);
  const optional = source("src/optional.ts", `export type Optional = { value?: string; mode: string | number };`);
  const authorities: AuthorityRegistry["authorities"] = [{
    id: "semantic.scope", kind: "zod-strict-object",
    owner: { path: owner.path, exportName: "SCOPE_SCHEMA" },
  }];
  const sources = [owner, same, optional];
  const result = analyze(sources, registry(sources, { authorities }));
  assert.equal(has(result, `authority_shape_duplicate:semantic.scope:${same.path}`), true);
  assert.equal(result.violations.some((entry) =>
    entry.startsWith(`authority_shape_duplicate:semantic.scope:${optional.path}`)), false);
  assert.notEqual(
    result.lock.authorities[0]?.semanticFingerprint,
    result.lock.occurrences.find((entry) => entry.path === same.path)?.semanticFingerprint,
  );

  const singleOwner = source("src/single-owner.ts", `
    import { z } from "zod"; export const SCOPE = z.strictObject({ value: z.string() });
  `);
  const stringCopy = source("src/string-copy.ts", `export type Copy = { value: string };`);
  const numberCopy = source("src/number-copy.ts", `export type Different = { value: number };`);
  const singleAuthorities: AuthorityRegistry["authorities"] = [{
    id: "single.scope", kind: "zod-strict-object", owner: { path: singleOwner.path, exportName: "SCOPE" },
  }];
  const singleSources = [singleOwner, stringCopy, numberCopy];
  const single = analyze(singleSources, registry(singleSources, { authorities: singleAuthorities }));
  assert.equal(has(single, `authority_shape_duplicate:single.scope:${stringCopy.path}`), true);
  assert.equal(single.violations.some((entry) =>
    entry.startsWith(`authority_shape_duplicate:single.scope:${numberCopy.path}`)), false);
});

test("[AG-C005] field and version bumps change fingerprints and expose stale copies", () => {
  const before = analyze();
  const bumpedOwner = OWNER_SOURCE
    .replace("example.test-result/v4", "example.test-result/v5")
    .replace("  fullRepositoryTestQualificationComplete", "  unsupportedSourceIds: z.array(z.string()),\n  fullRepositoryTestQualificationComplete");
  const bumpedConsumer = CONSUMER_SOURCE.replace(
    "  fullRepositoryTestQualificationComplete",
    "  unsupportedSourceIds: [],\n  fullRepositoryTestQualificationComplete",
  );
  const bumpedSources = [source("src/owner.ts", bumpedOwner), source("src/consumer.ts", bumpedConsumer)];
  const after = analyze(bumpedSources, registry(bumpedSources));
  assert.equal(assertOnlyFoundationBlockers(after), true, after.violations.join("\n"));
  assert.notEqual(after.lock.lockHash, before.lock.lockHash);
  const stale = source("test/stale.ts", `
    export const VERSION = "example.test-result/v4";
    export type ScopeCopy = {
      dispositionManifestHash: string; canonicalNodeSourceIds: readonly string[];
      fullRepositoryTestQualificationComplete: boolean;
    };
  `);
  const staleSources = [...bumpedSources, stale];
  const staleResult = analyze(staleSources, registry(staleSources));
  assert.equal(has(staleResult, "authority_literal_stale:receipt.version"), true);
  assert.equal(has(staleResult, "authority_shape_duplicate:test.surface.scope"), true);
});

test("[AG-C006] only the exact unshadowed imported schema receiver creates a materialization", () => {
  const fake = source("src/fake.ts", `
    import { SCOPE_SCHEMA } from "./owner.ts";
    declare function fake(value: unknown): { parse(input: unknown): unknown };
    export const copied = fake(SCOPE_SCHEMA).parse({
      dispositionManifestHash: "a", canonicalNodeSourceIds: [],
      fullRepositoryTestQualificationComplete: true,
    });
  `);
  const shadowed = source("src/shadowed.ts", `
    import { SCOPE_SCHEMA } from "./owner.ts";
    export function unrelated(SCOPE_SCHEMA: { parse(input: unknown): unknown }) {
      return SCOPE_SCHEMA.parse({ dispositionManifestHash: "a", canonicalNodeSourceIds: [],
        fullRepositoryTestQualificationComplete: true });
    }
  `);
  const sources = [...BASE_SOURCES, fake, shadowed];
  const result = analyze(sources, registry(sources));
  assert.equal(result.lock.occurrences.some((entry) =>
    [fake.path, shadowed.path].includes(entry.path) && entry.role === "materialization"), false);
  for (const candidate of [fake, shadowed]) {
    assert.equal(has(result, `authority_shape_duplicate:test.surface.scope:${candidate.path}`), true);
  }

  const notSchema = source("src/not-schema.ts", `export const NOT_SCHEMA = { a: 1, b: 2 };`);
  const notSchemaAuthority: AuthorityRegistry["authorities"][number] = {
    id: "not.schema", kind: "zod-strict-object", owner: { path: notSchema.path, exportName: "NOT_SCHEMA" },
  };
  const rejectedOwner = analyze([notSchema], registry([notSchema], { authorities: [notSchemaAuthority] }));
  assert.equal(has(rejectedOwner, "authority_owner_unsupported:not.schema"), true,
    rejectedOwner.violations.join("\n"));
});

test("[AG-C007] unrelated array and call spreads do not become authority syntax failures", () => {
  const unrelated = source("src/unrelated.ts", `
    declare const values: readonly number[];
    export const clone = [...values];
    declare function options(): object;
    declare function task(value: object): object;
    export function invoke() { return task({ ...options() }); }
  `);
  const sources = [...BASE_SOURCES, unrelated];
  const result = analyze(sources, registry(sources));
  assert.equal(result.violations.some((entry) =>
    entry.includes(`:${unrelated.path}:`) &&
    (entry.startsWith("authority_shape_unsupported:") || entry.startsWith("authority_literal_unsupported:"))), false,
  result.violations.join("\n"));
});
