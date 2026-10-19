import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { type PrivacyPolicyOptions } from "../../src/privacy/privacy-policy.ts";
import { PRIVACY_CONFIG_SCHEMA } from "../../src/privacy/privacy-config-section.ts";
import { DEBUG_CONFIG_SCHEMA } from "../../src/shared/debug/debug-config.ts";
import { SAFETY_CONFIG_SCHEMA } from "../../src/safety/safety-config-section.ts";
import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

/**
 * Mechanical config-consumption contract test.
 *
 * For every field declared on a config-derived type, at least one non-test
 * source file in `src/` must reference the field (e.g. `policy.<field>` or
 * `.<field>` on a variable of the type). This prevents dead configuration:
 * a field plumbed through the config schema, validated, set from config, and
 * tested for storage — but never consumed by any runtime code.
 *
 * The test scans `.ts` files in `src/` (excluding `*.test.ts`) for a reference
 * to each field. The field list is sourced from the canonical type definition.
 * If any field has ZERO non-test consumers, the test fails with a clear
 * message naming the field and the type.
 */

const SRC_ROOT = join(process.cwd(), "src");
const REPO_ROOT = process.cwd();

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(REPO_ROOT) })) {
    if (!file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function fieldIsConsumed(field: string, sourceFiles: readonly string[]): boolean {
  // Match `.<field>` as a property access on any variable (policy, p, privacyPolicy, etc.)
  const pattern = new RegExp(`\\.${field}\\b`, "u");
  return sourceFiles.some((file) => {
    const text = readFileSync(file, "utf8");
    return pattern.test(text);
  });
}

test("config-consumption: every configurable PrivacyPolicy field is consumed by at least one non-test source file", () => {
  // Only check CONFIGURABLE fields (from PrivacyPolicyOptions), not structural
  // data properties (schemaVersion, redactionCategories, rules) which are
  // internal to the policy construction.
  const configurableFields = [
    "enabledCategories",
    "piiClassifications",
    "redactionPrefix",
    "redactionSuffix",
    "maxContextLines",
    "maxFileBytes",
    "maxLines",
    "maxRegexPatternBytes",
    "maxMatchCount",
    "semanticModeEnabled",
    "preserveLineCount",
    "preserveStructure",
    "failClosedOnUncertainty",
    "heldCredentialMinimumLength",
    "urlDecodeLevels",
  ];
  const sourceFiles = listSourceFiles(SRC_ROOT);
  const unconsumed: string[] = [];
  for (const field of configurableFields) {
    if (!fieldIsConsumed(field, sourceFiles)) {
      unconsumed.push(field);
    }
  }
  assert.deepEqual(
    unconsumed,
    [],
    `PrivacyPolicy configurable fields declared in src/privacy/privacy-policy.ts but never consumed by any runtime code: ${unconsumed.join(", ")}. ` +
      `Fix: wire each field into the module that owns its behavior (e.g. file-viewer, redaction-engine, tool-registry) or remove it from the config contract if intentionally unused. ` +
      `Rule: every configurable field must have at least one non-test consumer — no dead configuration (prevention rule: config-consumption-contract).`,
  );
});

test("config-consumption: hardcoded field list matches the actual PrivacyPolicyOptions type", () => {
  // Dynamic contract: the hardcoded list above must exactly match the fields
  // declared on `PrivacyPolicyOptions`. If a new field is added to the type
  // but not to the hardcoded list, the config-consumption test above would
  // silently skip it (an unconsumed field passes undetected). This companion
  // test catches that drift.
  //
  // The `-?: undefined` mapped type makes every field REQUIRED with type
  // `undefined`, so TypeScript errors if a field is added to
  // `PrivacyPolicyOptions` but not to this object literal (missing required
  // field) OR if an extra field is added to the object literal (excess
  // property). `Object.keys` then yields the actual runtime field names,
  // which must match the hardcoded list consumed by the test above.
  const allOptions: { [K in keyof PrivacyPolicyOptions]-?: undefined } = {
    enabledCategories: undefined,
    piiClassifications: undefined,
    maxContextLines: undefined,
    maxFileBytes: undefined,
    maxLines: undefined,
    maxRegexPatternBytes: undefined,
    maxMatchCount: undefined,
    semanticModeEnabled: undefined,
    preserveLineCount: undefined,
    preserveStructure: undefined,
    failClosedOnUncertainty: undefined,
    heldCredentialMinimumLength: undefined,
    urlDecodeLevels: undefined,
    redactionPrefix: undefined,
    redactionSuffix: undefined,
  };
  const actualFields = Object.keys(allOptions).sort();
  const hardcodedFields = [
    "enabledCategories",
    "piiClassifications",
    "redactionPrefix",
    "redactionSuffix",
    "maxContextLines",
    "maxFileBytes",
    "maxLines",
    "maxRegexPatternBytes",
    "maxMatchCount",
    "semanticModeEnabled",
    "preserveLineCount",
    "preserveStructure",
    "failClosedOnUncertainty",
    "heldCredentialMinimumLength",
    "urlDecodeLevels",
  ].sort();
  assert.deepEqual(
    actualFields,
    hardcodedFields,
    "The hardcoded field list in the config-consumption test must exactly match the fields of PrivacyPolicyOptions (src/privacy/privacy-policy.ts). " +
      "Fix: if you add or remove a field from PrivacyPolicyOptions, update the hardcoded list AND the mapped-type object literal in this test. " +
      "Rule: the hardcoded field list must mirror the canonical type so no field escapes the consumption check (prevention rule: config-consumption-contract).",
  );
});

test("config-consumption: every PrivacyPolicy field is consumed by a privacy-module source file (not just stored)", () => {
  // Stronger check: the field must be referenced inside src/privacy/ or src/runtime/
  // (the consumers of a PrivacyPolicy), not just anywhere in src/.
  const privacyFields = [
    "maxContextLines",
    "maxFileBytes",
    "maxLines",
    "maxRegexPatternBytes",
    "maxMatchCount",
    "semanticModeEnabled",
    "preserveLineCount",
    "preserveStructure",
    "failClosedOnUncertainty",
    "heldCredentialMinimumLength",
    "urlDecodeLevels",
  ];
  const consumerDirs = [
    join(SRC_ROOT, "privacy"),
    join(SRC_ROOT, "runtime"),
  ];
  const consumerFiles: string[] = [];
  for (const dir of consumerDirs) {
    try { listSourceFiles(dir, consumerFiles); } catch { /* dir may not exist */ }
  }
  const unconsumed: string[] = [];
  for (const field of privacyFields) {
    if (!fieldIsConsumed(field, consumerFiles)) {
      unconsumed.push(field);
    }
  }
  assert.deepEqual(
    unconsumed,
    [],
    `PrivacyPolicy fields not consumed by privacy/runtime modules (src/privacy or src/runtime): ${unconsumed.join(", ")}. ` +
      `Fix: read each field in the file-viewer, redaction-engine, or tool-registry code path that owns its behavior — a field that is only stored has no behavioral effect. ` +
      `Rule: privacy-policy fields must be consumed by the privacy/runtime modules they configure (prevention rule: config-consumption-contract).`,
  );
});

// ---------------------------------------------------------------------------
// The CONFIG SECTION census — the privacy section's leaves are config
// leaves, and a config leaf that no reader ever reads is the declared-
// but-unread class this guard exists for (the section shipped declared,
// write-gated and consumed by nothing for the rounds before its wiring).
//
// The reader chain, every hop derived (never a restated leaf list):
//
//   config document ──(document schema's privacy shape, walked)──▶ leaf
//   leaf ──(name identity, enforced below)──▶ PrivacyPolicyOptions key
//   options key ──(`options.<key>` in createPrivacyPolicy's own source,
//                  scanned)──▶ the policy constructor READS it
//   policy field ──(the arms above)──▶ consumed by runtime code
//
// A leaf added to the section without a policy field to receive it reds at
// the identity hop; a policy field the constructor stops reading reds at
// the source hop; a section that drifts from what the document schema
// splices reds at the shape-parity hop. Deny-by-default in every
// direction.
// ---------------------------------------------------------------------------

test("config-consumption: every privacy SECTION leaf the config contract declares reaches the policy's options (no declared-but-unread leaf)", () => {
  // Walk the section schema's zod shape — the leaf set is derived, never
  // restated (zod 4 keeps `.shape` through superRefine; the assert below
  // fails loudly if a zod upgrade drops it).
  const sectionShape = (PRIVACY_CONFIG_SCHEMA as unknown as { shape?: Record<string, unknown> }).shape;
  assert.ok(sectionShape !== undefined, "the privacy section schema must expose its zod shape — re-derive this walk if the zod version changes");
  const sectionLeaves = Object.keys(sectionShape);
  assert.ok(
    sectionLeaves.length >= 12,
    `the privacy section's leaf walk found ${sectionLeaves.length} leaves — a shrinking leaf set means the schema regressed`,
  );

  // The options keys, derived from the canonical type (the same mapped-type
  // discipline the list-matches-type arm above enforces).
  const optionsProbe: { [K in keyof PrivacyPolicyOptions]-?: undefined } = {
    enabledCategories: undefined,
    piiClassifications: undefined,
    maxContextLines: undefined,
    maxFileBytes: undefined,
    maxLines: undefined,
    maxRegexPatternBytes: undefined,
    maxMatchCount: undefined,
    semanticModeEnabled: undefined,
    preserveLineCount: undefined,
    preserveStructure: undefined,
    failClosedOnUncertainty: undefined,
    heldCredentialMinimumLength: undefined,
    urlDecodeLevels: undefined,
    redactionPrefix: undefined,
    redactionSuffix: undefined,
  };
  const optionsKeys = Object.keys(optionsProbe);

  // Hop 1 — the identity join: every section leaf IS an options key.
  const orphans = sectionLeaves.filter((leaf) => !optionsKeys.includes(leaf));
  assert.deepEqual(
    orphans,
    [],
    `privacy config-section leaves with no PrivacyPolicyOptions field to receive them: ${orphans.join(", ")}. ` +
      `A config leaf that resolves into nothing is the declared-but-unread class: add the policy field that consumes it, or remove the leaf from the section schema.`,
  );

  // Hop 2 — the constructor READS each key: `options.<leaf>` appears in
  // createPrivacyPolicy's own source, so a leaf that resolves but is
  // never read into the policy cannot pass silently.
  const policySource = readFileSync(join(SRC_ROOT, "privacy", "privacy-policy.ts"), "utf8");
  const unread = sectionLeaves.filter((leaf) => !new RegExp(`options\\.${leaf}\\b`, "u").test(policySource));
  assert.deepEqual(
    unread,
    [],
    `privacy config-section leaves createPrivacyPolicy never reads from its options: ${unread.join(", ")}. ` +
      `The resolver hands the section through; the constructor must read every leaf it declares — an unread options key makes the config write land with no effect.`,
  );

  // Hop 3 — the document splices EXACTLY the section owner's shape: the
  // write gate cannot accept a leaf the section owner does not declare,
  // and the section owner cannot drift from what the document validates.
  const documentPrivacyShape =
    (CONFIG_DOCUMENT_SCHEMA as unknown as { shape?: Record<string, unknown> }).shape?.privacy;
  assert.ok(documentPrivacyShape !== undefined, "the config document must declare the privacy section");
  const inner = (documentPrivacyShape as unknown as { unwrap?: () => { shape?: Record<string, unknown> } }).unwrap?.().shape;
  const documentLeaves = Object.keys(inner ?? (documentPrivacyShape as unknown as { shape?: Record<string, unknown> }).shape ?? {});
  assert.deepEqual(
    [...documentLeaves].sort(),
    [...sectionLeaves].sort(),
    "the document schema's privacy section must declare exactly the section owner's leaves — a spliced shape that drifts makes the write gate and the policy door disagree about what is configurable",
  );
});

// ---------------------------------------------------------------------------
// The debug SECTION census — the same declared-but-unread class, judged
// against the debug system's own source. The debug section was the other
// round-34 zombie: declared, write-gated, shipped in the file, and consumed
// by NOTHING in any process (the web bootstrap read one env var and ran on
// code defaults). The wiring made the section real through ONE resolver;
// this census is what keeps it real:
//
//   config document ──(document schema's debug shape, walked recursively)
//   ──▶ leaf PATH (the section is nested: audit/errorHandling/sinks/redaction)
//   leaf ──(the read patterns below, scanned in debug-system.ts's own
//           source)──▶ the debug system READS it at emit/admission time
//
// `schemaVersion` is the one structural exception: it is the section's
// identity literal, consumed by the zod parse itself (a wrong value fails
// the document at the gate), not a runtime knob — stated here so the
// exception is a named disposition, not a silent skip.
//
// The withdrawn leaves (§ the debug config contract's own header) are NOT
// here because they are no longer in the schema — a leaf re-added without a
// reader reds below, which is the arm that would have caught them.
// ---------------------------------------------------------------------------

test("config-consumption: every debug SECTION leaf the config contract declares is read by the debug system (no declared-but-unread leaf)", () => {
  // The walk is RECURSIVE: a member with its own zod `.shape` is a
  // sub-object to descend into, anything else is a leaf. The leaf set is
  // derived, never restated.
  const walkLeaves = (shape: Record<string, unknown>, prefix: readonly string[]): string[] => {
    const out: string[] = [];
    for (const [key, member] of Object.entries(shape)) {
      const inner = (member as { shape?: Record<string, unknown> }).shape;
      if (inner !== undefined) out.push(...walkLeaves(inner, [...prefix, key]));
      else out.push([...prefix, key].join("."));
    }
    return out;
  };
  const sectionShape = (DEBUG_CONFIG_SCHEMA as unknown as { shape?: Record<string, unknown> }).shape;
  assert.ok(sectionShape !== undefined, "the debug section schema must expose its zod shape — re-derive this walk if the zod version changes");
  const sectionLeaves = walkLeaves(sectionShape, []);
  assert.ok(
    sectionLeaves.length >= 15,
    `the debug section's leaf walk found ${sectionLeaves.length} leaves — a shrinking leaf set means the schema regressed`,
  );

  // The read grammar of debug-system.ts's own source: top-level leaves are
  // read as `config.<leaf>`; nested leaves as `config.<parent>.<leaf>`; the
  // redaction sub-object is destructured to a local `cfg`/`redaction` binding
  // in the emit path, so its leaves answer under those aliases too. The
  // alias map is the reader's known binding set (two names), not a per-leaf
  // hand table — the leaves stay derived.
  const systemSource = readFileSync(join(SRC_ROOT, "shared", "debug", "debug-system.ts"), "utf8");
  const NESTED_ALIASES: Readonly<Record<string, readonly string[]>> = {
    redaction: ["cfg", "redaction"],
  };
  const structuralExceptions = new Set(["schemaVersion"]);
  const unread = sectionLeaves.filter((path) => {
    if (structuralExceptions.has(path)) return false;
    const parts = path.split(".");
    const leaf = parts[parts.length - 1]!;
    const patterns = [new RegExp(`config\\.${parts.join("\\.")}\\b`, "u")];
    const aliases = parts.length > 1 ? NESTED_ALIASES[parts[0]!] : undefined;
    if (aliases !== undefined) {
      for (const alias of aliases) patterns.push(new RegExp(`\\b${alias}\\.${leaf}\\b`, "u"));
    }
    return !patterns.some((pattern) => pattern.test(systemSource));
  });
  assert.deepEqual(
    unread,
    [],
    `debug config-section leaves debug-system.ts never reads: ${unread.join(", ")}. ` +
      `A config leaf no runtime code reads is the declared-but-unread class this guard exists for: wire it into the debug system's emit/admission path, or remove it from the section schema AND the shipped config file in the same change.`,
  );

  // The document splices EXACTLY the section owner's shape, and the splice
  // runs the section's own floor: a debug document that drifts from the
  // section schema makes the write gate and the bootstrap resolver disagree
  // about what is configurable, and a splice without the floor lets a
  // weakening section reach disk only to brick the next boot.
  const documentDebugShape =
    (CONFIG_DOCUMENT_SCHEMA as unknown as { shape?: Record<string, unknown> }).shape?.debug;
  assert.ok(documentDebugShape !== undefined, "the config document must declare the debug section");
  const unwrapped = (documentDebugShape as unknown as { unwrap?: () => { shape?: Record<string, unknown> } }).unwrap?.().shape;
  const documentLeaves = walkLeaves(
    unwrapped ?? (documentDebugShape as unknown as { shape?: Record<string, unknown> }).shape ?? {},
    [],
  );
  assert.deepEqual(
    [...documentLeaves].sort(),
    [...sectionLeaves].sort(),
    "the document schema's debug section must declare exactly the section owner's leaves — a spliced shape that drifts makes the write gate and the debug bootstrap disagree about what is configurable",
  );
  const contractsSource = readFileSync(join(SRC_ROOT, "kernel", "config-contracts.ts"), "utf8");
  assert.match(
    contractsSource,
    /debugConfigViolations/,
    "the document's debug splice must run the section's own floor owner (debugConfigViolations) — the write gate's refusal for a weakening debug section is that call, and a splice without it accepts what the next boot would brick on",
  );
  // AND BEHAVIORALLY, because a source scan is satisfied by the identifier's
  // mere presence (the import alone matched the pattern above while the
  // splice's call was severed in mutation): the DOCUMENT itself must refuse
  // a weakening debug section — the shipped document with only
  // `debug.redaction.enabled` flipped must fail the parse with the floor's
  // own sentence. The shipped config is the base (never a restated section).
  const shippedDoc = JSON.parse(readFileSync(join(REPO_ROOT, "bridlewise.config.json"), "utf8")) as Record<string, unknown>;
  assert.ok(shippedDoc.debug !== undefined, "the shipped config must carry the debug section for the floor probe");
  const weakenedDoc = structuredClone(shippedDoc);
  (weakenedDoc.debug as { redaction: { enabled: boolean } }).redaction.enabled = false;
  const weakenedParse = CONFIG_DOCUMENT_SCHEMA.safeParse(weakenedDoc);
  assert.equal(
    weakenedParse.success,
    false,
    "the config document must refuse a debug section that switches the debug redactor off — a splice that accepts it lets the write land and the next boot die on the bridge's refusal instead",
  );
  assert.ok(
    !weakenedParse.success && weakenedParse.error.issues.some((issue) => issue.message.includes("debug_redaction_required")),
    "the document's refusal for a weakening debug section must carry the floor's own code — a bare structural failure would not say WHO refused",
  );
});

// ---------------------------------------------------------------------------
// The safety SECTION census — the declared-but-unread class judged against
// the gates the section arms. The safety section governs the model-facing
// gate layer: the pre-dispatch tool-call gate and the four event-feed
// detectors. Every leaf must be CONSUMED past the resolver plumbing — a
// leaf that resolves into the config object but no runtime code ever reads
// is the zombie this guard exists for (the measured instance: a leaf named
// for the investigation stage that nothing consulted — the runtime created
// the investigator unconditionally — pruned with this census).
//
//   config document ──(the section schema's zod shape, walked recursively)
//   ──▶ leaf PATH (the section is nested: toolCallGate/, eventFeed/,
//       eventFeed.families.<family>/, eventFeed.learnOptions/)
//   leaf ──(the read grammar below, scanned in the non-test sources)
//   ──▶ a runtime consumer
//
// The resolver plumbing itself does NOT count: `resolveBandaidConfig`'s
// override merge references every declared name by construction, so a scan
// that included it could never catch a zombie — the plumbing file is
// excluded and the consumption must live in the detectors, the gate, the
// learner, the pause-ask builder, or the exposure registration.
// ---------------------------------------------------------------------------

test("config-consumption: every safety SECTION leaf the config contract declares is read past the resolver plumbing (no declared-but-unread leaf)", () => {
  // The walk is RECURSIVE, through the optional wrappers the safety section's
  // nested members carry (unlike the debug section, whose sub-objects are
  // bare): unwrap optional/default/nullable/readonly first, then a member
  // with its own zod `.shape` is a sub-object to descend into, anything
  // else is a leaf.
  const unwrapSchema = (schema: unknown): Record<string, unknown> | undefined => {
    let current = schema as { _def?: { type?: string; innerType?: unknown }; shape?: Record<string, unknown> } | undefined;
    while (current?._def?.type !== undefined && ["optional", "default", "nullable", "readonly"].includes(current._def.type)) {
      current = current._def.innerType as typeof current;
    }
    return current?.shape;
  };
  const walkLeaves = (shape: Record<string, unknown>, prefix: readonly string[]): string[] => {
    const out: string[] = [];
    for (const [key, member] of Object.entries(shape)) {
      const inner = unwrapSchema(member);
      if (inner !== undefined) out.push(...walkLeaves(inner, [...prefix, key]));
      else out.push([...prefix, key].join("."));
    }
    return out;
  };
  const sectionShape = (SAFETY_CONFIG_SCHEMA as unknown as { shape?: Record<string, unknown> }).shape;
  assert.ok(sectionShape !== undefined, "the safety section schema must expose its zod shape — re-derive this walk if the zod version changes");
  const sectionLeaves = walkLeaves(sectionShape, []);
  // 49 today: the round-21 audit's 50 minus the one pruned consumerless
  // leaf. A shrinking set means the schema regressed; a growing set reds in
  // the unread check below until each new leaf earns a consumer.
  assert.ok(
    sectionLeaves.length >= 49,
    `the safety section's leaf walk found ${sectionLeaves.length} leaves — a shrinking leaf set means the schema regressed`,
  );

  // The scan population: the non-test sources of BOTH trees the section's
  // consumers live in (the engine's detectors, gate, learner and pause-ask
  // builder; the server's safety runtime), EXCLUDING the resolver plumbing
  // file whose override merge references every declared name by construction
  // (including it would make this census unable to catch the zombie it
  // exists for). The exposure registration stays IN — its REAL reads are
  // pinned by the grammar below (a receiver-qualified access), which its
  // configPath string literals cannot satisfy: "safety.eventFeed.<X>" is a
  // path, not a `cfg.<X>` read.
  const sources = listSourceFiles(SRC_ROOT).filter((file) => !file.endsWith(join("safety", "bandaid-config.ts")))
    .concat(listSourceFiles(join(REPO_ROOT, "..", "server")).map((p) => p));
  const sourceText = sources.map((file) => readFileSync(file, "utf8"));

  // The read grammar per leaf family, derived from how each consumer
  // actually spells its access — never a per-leaf hand table:
  //   <X> (top level)    — the module's own live state: `safetyState.<X>`
  //                       (read by the report/enforce actions).
  //   toolCallGate.<X>   — the gate's state machine reads `config.<X>`
  //                       (the resolver spells its merge `override.<X>`, so
  //                       the pattern cannot be satisfied by plumbing).
  //   families.<f>.<X>   — the detectors bind the family object
  //                       (`cfg.families.<f>`), and enabled/minEvents are
  //                       read through that binding — the family-qualified
  //                       access is the consumption unit.
  //   <other>.<X>        — the field read off a resolved config or options
  //                       receiver (`cfg.<X>`, `options.<X>`,
  //                       `config?.<X>`), never a bare path string.
  const consumedBy = (path: string): boolean => {
    const parts = path.split(".");
    const leaf = parts[parts.length - 1]!;
    const patterns: RegExp[] = [];
    if (parts.length === 1) {
      patterns.push(new RegExp(`safetyState\\.${leaf}\\b`, "u"));
    } else if (parts[0] === "toolCallGate") {
      patterns.push(new RegExp(`config\\.${leaf}\\b`, "u"));
    } else if (parts[0] === "eventFeed" && parts[1] === "families") {
      patterns.push(new RegExp(`cfg\\.families\\.${parts[2]!}\\b`, "u"));
    } else {
      patterns.push(new RegExp(`(?:cfg|options|config)\\??\\.${leaf}\\b`, "u"));
    }
    return sourceText.some((text) => patterns.some((pattern) => pattern.test(text)));
  };
  const unread = sectionLeaves.filter((path) => !consumedBy(path));
  assert.deepEqual(
    unread,
    [],
    `safety config-section leaves no runtime code reads past the resolver plumbing: ${unread.join(", ")}. ` +
      `A config leaf that resolves into the config object but influences nothing is the declared-but-unread class this guard exists for: wire it into the gate or the detectors it names, or remove it from the section schema (and the shipped file, if it sets it) in the same change.`,
  );

  // The document splices EXACTLY the section owner's shape, and the splice
  // runs the section's own posture floor: a safety document that drifts
  // from the section schema makes the write gate and the per-run accessors
  // disagree about what is configurable, and a splice without the floor
  // accepts a weakening section at every sanctioned door.
  const documentSafetyShape =
    (CONFIG_DOCUMENT_SCHEMA as unknown as { shape?: Record<string, unknown> }).shape?.safety;
  assert.ok(documentSafetyShape !== undefined, "the config document must declare the safety section");
  const documentLeaves = walkLeaves(unwrapSchema(documentSafetyShape) ?? {}, []);
  assert.deepEqual(
    [...documentLeaves].sort(),
    [...sectionLeaves].sort(),
    "the document schema's safety section must declare exactly the section owner's leaves — a spliced shape that drifts makes the write gate and the per-run accessors disagree about what is configurable",
  );
  const contractsSource = readFileSync(join(SRC_ROOT, "kernel", "config-contracts.ts"), "utf8");
  assert.match(
    contractsSource,
    /safetyConfigViolations/,
    "the document's safety splice must run the section's own floor owner (safetyConfigViolations) — the write gate's refusal for a weakening safety section is that call",
  );
  // AND BEHAVIORALLY (a source scan is satisfied by the identifier's mere
  // presence): the DOCUMENT itself must refuse a weakening safety section —
  // the shipped document with one gate check flipped must fail the parse
  // with the floor's own sentence. The shipped config is the base, never a
  // restated section.
  const shippedDoc = JSON.parse(readFileSync(join(REPO_ROOT, "bridlewise.config.json"), "utf8")) as Record<string, unknown>;
  assert.ok(shippedDoc.safety !== undefined, "the shipped config must carry the safety section for the floor probe");
  const weakenedDoc = structuredClone(shippedDoc);
  (weakenedDoc.safety as { toolCallGate: { enableLoopDetection: boolean } }).toolCallGate.enableLoopDetection = false;
  const weakenedParse = CONFIG_DOCUMENT_SCHEMA.safeParse(weakenedDoc);
  assert.equal(
    weakenedParse.success,
    false,
    "the config document must refuse a safety section that turns a pre-dispatch gate check off — a splice that accepts it lets the disarm reach every downstream door",
  );
  assert.ok(
    !weakenedParse.success && weakenedParse.error.issues.some((issue) => issue.message.includes("safety_gate_loop_detection_required")),
    "the document's refusal for a weakening safety section must carry the floor's own code — a bare structural failure would not say WHO refused",
  );
});
