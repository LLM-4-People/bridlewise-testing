import assert from "node:assert/strict";
import test from "node:test";

import { verifyGovernedTypeScriptSource } from "../../scripts/tooling/verification/governed-source.ts";

function violations(source: string, path = "src/schema-fixture.ts"): readonly string[] {
  const result: string[] = [];
  verifyGovernedTypeScriptSource(path, source, result);
  return result;
}

test("governed schema exports admit supported Zod builders across paths and export forms", () => {
  const fixtures = [
    ["src/count-fixture.ts", `import { z } from "zod";
      export const Count = z.number().int().nonnegative().safe();`],
    ["scripts/object-fixture.ts", `import { z as validator } from "zod";
      export const Schema = validator.object({ count: validator.number() })
        .catchall(validator.json()).superRefine(() => {});`],
    ["src/named-fixture.ts", `import { z } from "zod";
      const Schema = z.object({}).catchall(z.json()); export { Schema };`],
    ["src/default-fixture.ts", `import { z } from "zod";
      export default z.object({ value: z.string() }).superRefine(() => {});`],
    ["src/optional-fixture.ts", `import { z as validator } from "zod";
      export const Schema = validator.enum(["ready"]).optional().nullable();`],
  ] as const;
  for (const [path, source] of fixtures) {
    assert.deepEqual(violations(source, path), [], source);
  }
});

test("Zod receiver provenance refuses foreign, shadowed and arbitrary builders", () => {
  const fixtures = [
    `import { z } from "foreign-library"; export const Schema = z.number().int();`,
    `import type { z } from "zod"; export const Schema = z.number().int();`,
    `import { type z } from "zod"; export const Schema = z.number().int();`,
    `const z = { number: () => ({ int() { return this; } }) };
      export const Schema = z.number().int();`,
    `import { z as real } from "zod"; const z = unknownNamespace;
      export const Schema = z.number().int();`,
    `import { z } from "zod"; function make() { return z.number(); }
      export const Schema = make().optional();`,
    `import { z } from "zod"; export const Schema = Object.freeze({}).optional();`,
    `import { z } from "zod"; const Schema = z.number; export const Value = Schema().int();`,
  ];
  for (const source of fixtures) {
    assert.ok(violations(source).includes("governed-export-unmodeled:src/schema-fixture.ts"), source);
  }
});

test("schema provenance refuses unsupported, dynamic and data-returning chains", () => {
  const fixtures = [
    `import { z } from "zod"; export const Value = z.number().unknownMethod();`,
    `import { z } from "zod"; export const Value = z.number()[method]();`,
    `import { z } from "zod"; export const Value = z.number().constructor();`,
    `import { z } from "zod"; export const Value = z.number().parse(1);`,
    `import { z } from "zod"; export const Value = z.number().safeParse(1);`,
    `import { z } from "zod"; export const Value = z.number().decode(1);`,
    `import { z } from "zod"; export const Value = z.number().encode(1);`,
    `import { z } from "zod"; export const Value = z.number().toJSONSchema();`,
    `import { z } from "zod"; export const Value = z.number().meta();`,
    `import { z } from "zod"; export const Value = z.parse(z.number(), 1).optional();`,
    `import { z } from "zod"; export const Value = z.unknownFactory().optional();`,
  ];
  for (const source of fixtures) {
    assert.ok(violations(source).includes("governed-export-unmodeled:src/schema-fixture.ts"), source);
  }
});

test("schema provenance refuses local aliases and respects the construction depth bound", () => {
  const fixtures = [
    `import { z } from "zod"; const Schema = z.number(); export const Value = Schema.int();`,
    `import { z } from "zod"; const Schema = z.number(); const Alias = Schema;
      export const Value = Alias.optional().nullable();`,
    `import { z } from "zod"; const namespace = z;
      export const Value = namespace.enum(["ready"]).nullable();`,
    `import { z } from "zod"; let Schema = z.number(); export const Value = Schema.int();`,
    `import { z } from "zod"; const Schema = z.number(); Schema.int = forged;
      export const Value = Schema.int();`,
    `import { z } from "zod"; const Schema = z.number(); const Alias = Schema;
      Alias.int = forged; export const Value = Schema.int();`,
    `import { z } from "zod"; z.number = forged; export const Value = z.number().int();`,
    `const First = Second; const Second = First; export const Value = First.optional();`,
    `import { z } from "zod"; export const Value = z.number()${".optional()".repeat(70)};`,
  ];
  for (const source of fixtures) {
    assert.ok(violations(source).includes("governed-export-unmodeled:src/schema-fixture.ts"), source);
  }
});

test("schema provenance refuses reflective mutation and calls that can retain a schema", () => {
  const fixtures = [
    `import { z } from "zod"; const Schema = z.number();
      Object.assign(Schema, { optional: () => ({ setting: 1 }) });
      export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number();
      Object.defineProperty(Schema, "optional", { value: () => ({ setting: 1 }) });
      export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number();
      Reflect.set(Schema, "optional", () => ({ setting: 1 }));
      export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number(); mutate(Schema);
      export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number(); const Alias = Schema; mutate(Alias);
      export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number(); const holder = { schema: Schema };
      mutate(holder); export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number(); function expose() { return Schema; }
      Object.assign(expose(), { optional: () => ({ setting: 1 }) });
      export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number();
      const expose = () => Schema; mutate(expose()); export const Value = Schema.optional();`,
    `import { z } from "zod"; const Schema = z.number(); delete Schema.optional;
      Schema.__proto__.optional = () => ({ setting: 1 }); export const Value = Schema.optional();`,
  ];
  const admitted = fixtures.filter(source =>
    !violations(source).includes("governed-export-unmodeled:src/schema-fixture.ts"));
  assert.deepEqual(admitted, [], "a const binding does not prove that its schema object stayed immutable");
});

test("schema builder admission preserves recursive effect and policy inspection", () => {
  const effect = violations(`import { z } from "zod";
    export const Schema = z.object({}).superRefine(() => process.binding("fs"));`);
  assert.ok(effect.includes("production-effect-api:schema-fixture.ts:process.binding"), effect.join("\n"));
  const policy = violations(`import { z } from "zod";
    export const Schema = z.object({}).superRefine(() => {
      const bypassPolicy = {}; return bypassPolicy;
    });`);
  assert.ok(policy.includes("universal-policy-parallel-authority:src/schema-fixture.ts"), policy.join("\n"));
});
