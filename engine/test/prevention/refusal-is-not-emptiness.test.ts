/**
 * GUARD SUBJECT: a privacy/redaction refusal omits the payload at runtime rather than returning an empty-but-present payload field (a refusal is not an emptiness)
 * GUARD OWNS: src/privacy/evidence-handler.ts + src/privacy/file-viewer.ts — the refused variants of EvidenceRedactionResult / FileViewResult and the entry points that produce them
 * GUARD PLANT: re-add `redactedContent: ""` (or `content: ""`) to a refusal-producing entry point's blocked branch; a benign-content probe must first be ADMITTED so the refusal case is proven to have decided
 * GUARD DRIVEN: each evidence entry point discovered from the module's own exports, called with an uncertifiable policy, plus viewFile on a file carrying a secret — the real caller's entry points, not the inner redactor
 * GUARD LIVENESS: the benign-content probe must be admitted (status not blocked) BEFORE the refusal verdict is read — a guard that never reaches a refusal is measuring a non-driven path
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import * as evidenceHandler from "../../src/privacy/evidence-handler.ts";
import { viewFile } from "../../src/privacy/file-viewer.ts";
import type { ToolDefinition } from "../../src/runtime/provider-adapter.ts";
import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * A SAFETY CHECK THAT CANNOT DECIDE MUST REFUSE — IT MUST NOT DESTROY.
 *
 * ── THE FAMILY, WHICH IS NOT THE DEFAULT-INSTEAD-OF-CONFIG FAMILY ───────────
 *
 * These two shared one incident and are otherwise unrelated. The first was a
 * consumer reading a default instead of a resolved field. The SECOND is what
 * happened when that first defect fired: the residual-secret check could not
 * certify the redaction, and the code answered by EMPTYING the payload —
 * `redactedContent: ""`, `content: ""` — while every other field kept the
 * shape of a successful result.
 *
 * An empty payload is not a refusal. It is a value a successful call can also
 * produce: a clean empty document, a regex with no matching lines, a file with
 * nothing in it. So a caller cannot tell them apart, and two callers did not:
 * the `read_file` tool and the slice redactor both returned the viewer's
 * payload unconditionally, so a file whose redaction could not be verified
 * reached the model as an EMPTY FILE. The check destroyed the evidence and the
 * destruction read downstream as success.
 *
 * ── WHAT IS ENFORCED HERE, AND AT WHICH RUNG ────────────────────────────────
 *
 * The structural half is enforced by the TYPE: the refused variants of
 * `EvidenceRedactionResult` and `FileViewResult` do not declare a payload
 * field at all, so reading one without narrowing is a compile error rather
 * than a silent empty string. That is unrepresentable-by-shape and no test has
 * to notice it.
 *
 * This file guards the two things a type cannot state:
 *   1. every refusal-producing entry point really does omit the payload at
 *      RUNTIME (a frozen object literal could still carry the key);
 *   2. the consumers that used to hand emptiness onward now RAISE a typed
 *      refusal instead.
 *
 * Entry points are discovered from the module's own exports rather than
 * listed, so an entry point added tomorrow is covered without anyone
 * remembering to add it here.
 */

/**
 * A policy whose replacement marker is itself a credential. The engine cannot
 * certify its own output under it, so every path that verifies a redaction is
 * driven into a refusal — which is what makes this a usable probe rather than
 * a special case.
 */
const UNCERTIFIABLE = createPrivacyPolicy({
  redactionPrefix: ("sk" + "_abcdefghijklmnopqrstuvwx"),
  redactionSuffix: "",
});
const BENIGN = createPrivacyPolicy();
/**
 * A second benign policy with a DISTINCT marker. Discovery uses it to prove
 * that the options argument actually landed in the argument slot it was aimed
 * at: `markUnparseable(content, reason, options)` and
 * `redactEvidence(content, options)` have different shapes, and a probe that
 * guessed wrong still gets a plausible-looking result back — one that quietly
 * ran under the DEFAULT policy. Requiring this marker in the output is how the
 * probe knows it is driving the function rather than watching it.
 */
const PROBE = createPrivacyPolicy({ redactionPrefix: "<PROBE:", redactionSuffix: ">" });
const CONTENT_WITH_A_SECRET = "password = MyS3cretPassw0rd12345678";

type EvidenceEntryPoint = Readonly<{ name: string; call: (policy: ReturnType<typeof createPrivacyPolicy>) => unknown }>;

/**
 * Every exported function of the evidence handler that answers with an
 * admission status, found by calling it rather than by naming it. A function
 * that does not answer that way is not this guard's business and drops out.
 */
function discoverEvidenceEntryPoints(): readonly EvidenceEntryPoint[] {
  const found: EvidenceEntryPoint[] = [];
  for (const [name, value] of Object.entries(evidenceHandler)) {
    if (typeof value !== "function") continue;
    for (const call of [
      (policy: ReturnType<typeof createPrivacyPolicy>) => (value as (c: string, o: unknown) => unknown)(CONTENT_WITH_A_SECRET, { policy }),
      (policy: ReturnType<typeof createPrivacyPolicy>) => (value as (c: string, r: string, o: unknown) => unknown)(CONTENT_WITH_A_SECRET, "probe_reason", { policy }),
    ]) {
      let probe: unknown;
      try {
        probe = call(PROBE);
      } catch {
        continue;
      }
      if (typeof probe !== "object" || probe === null) continue;
      if (!("status" in probe) || !("metadata" in probe)) continue;
      // The policy must have REACHED it. Without this the probe accepts an
      // arity it guessed wrong, which then runs under the default policy and
      // reports whatever the default does — a discovery that watches instead
      // of driving.
      const payload = (probe as Record<string, unknown>)["redactedContent"];
      if (typeof payload !== "string" || !payload.includes(PROBE.redactionPrefix)) continue;
      found.push({ name, call });
      break;
    }
  }
  return found;
}

test("refusal is not emptiness: every evidence entry point omits the payload when it refuses", () => {
  const entryPoints = discoverEvidenceEntryPoints();
  // A guard about what a refusal does NOT contain must first prove a refusal
  // happened at all, and that the same entry point DOES produce a payload when
  // it admits. Without both, an entry point that always throws, or one whose
  // probe silently fell out of the discovery loop, would pass by absence.
  assert.ok(
    entryPoints.length >= 4,
    `expected the evidence handler's admission entry points to be discovered; found ${entryPoints.length}`,
  );

  const failures: string[] = [];
  for (const entry of entryPoints) {
    const admitted = entry.call(BENIGN) as Record<string, unknown>;
    if (admitted["status"] === "blocked") {
      failures.push(`${entry.name}: refused benign content, so the refusal case below proves nothing`);
      continue;
    }
    if (typeof admitted["redactedContent"] !== "string") {
      failures.push(`${entry.name}: an admitted result must carry its payload`);
    }

    const refused = entry.call(UNCERTIFIABLE) as Record<string, unknown>;
    if (refused["status"] !== "blocked") {
      failures.push(`${entry.name}: expected a refusal under an uncertifiable policy, got ${String(refused["status"])}`);
      continue;
    }
    if ("redactedContent" in refused) {
      failures.push(
        `${entry.name}: the refusal still carries \`redactedContent\` (${JSON.stringify(refused["redactedContent"])}) — ` +
          `an empty payload is a value a successful call also produces, so a caller cannot tell them apart`,
      );
    }
    if (typeof refused["blockReason"] !== "string" || (refused["blockReason"] as string).length === 0) {
      failures.push(`${entry.name}: a refusal must say why`);
    }
  }
  assert.deepEqual(failures, [], failures.join("; "));
});

test("refusal is not emptiness: the file viewer omits the payload when it refuses", () => {
  const admitted = viewFile("probe.ts", CONTENT_WITH_A_SECRET, { mode: "full", policy: BENIGN });
  assert.equal(admitted.outcome, "viewed", "precondition: the benign policy must produce a view");
  assert.ok(admitted.outcome === "viewed" && admitted.content.length > 0, "an admitted view must carry content");

  for (const mode of ["full", "regex", "semantic"] as const) {
    const refused = viewFile("probe.ts", CONTENT_WITH_A_SECRET, {
      mode,
      pattern: "password",
      policy: UNCERTIFIABLE,
    });
    assert.equal(refused.outcome, "refused", `${mode}: expected a refusal under an uncertifiable policy`);
    assert.ok(
      !("content" in refused),
      `${mode}: the refusal still carries \`content\` — an empty string is a value a successful view also produces`,
    );
    assert.ok(
      typeof refused.blockReason === "string" && refused.blockReason.length > 0,
      `${mode}: a refusal must say why`,
    );
  }
});

/**
 * Arguments for a tool, synthesised from the tool's OWN declared schema.
 *
 * Naming the tools this guard covers is what made an earlier version of it
 * miss half its own subject: it drove `read_file` only, while `redactSlice`
 * — the second of the two call sites the whole fix exists for — was reached
 * by three other tools and covered by nothing. A tool added tomorrow is
 * covered here because nobody had to remember it.
 */
function argumentsFromSchema(definition: ToolDefinition, file: string, symbol: string, lastLine: number): string {
  const parameters = definition.function.parameters as
    | Readonly<{ properties?: Record<string, { type?: string }>; required?: readonly string[] }>
    | undefined;
  const required = parameters?.required ?? [];
  const properties = parameters?.properties ?? {};
  const filled: Record<string, unknown> = {};
  for (const key of required) {
    const schema = properties[key];
    if (key === "path" || key === "file") filled[key] = file;
    else if (key === "startLine") filled[key] = 1;
    else if (key === "endLine") filled[key] = lastLine;
    else if (schema?.type === "integer" || schema?.type === "number") filled[key] = 1;
    else if (schema?.type === "boolean") filled[key] = false;
    else if (schema?.type === "array") filled[key] = [];
    else filled[key] = symbol;
  }
  // A bounded window is optional in the schema but meaningless unbounded, so
  // supply it whenever the tool declares it at all.
  if ("startLine" in properties) filled["startLine"] = 1;
  if ("endLine" in properties) filled["endLine"] = lastLine;
  return JSON.stringify(filled);
}

test("refusal is not emptiness: every tool that reaches the viewer raises a typed refusal", () => {
  // The consumer half, and the one that actually reached the model. The tools
  // are DISCOVERED by driving them: a tool qualifies only when its benign
  // output carries the probe policy's own marker, which proves the file viewer
  // ran under the policy this test supplied rather than under the default. A
  // tool that never reaches the viewer drops out instead of passing by absence.
  const directory = mkTempDir("refusal-is-not-emptiness-");
  try {
    // Every declaration holds the secret, so a slice, a line window and a
    // caller-context excerpt all contain something the engine must mask —
    // which is what makes each of them a usable probe.
    const source = [
      `export function probeSubject(): string {`,
      `  const password = "MyS3cretPassw0rd12345678";`,
      `  return password;`,
      `}`,
      ``,
      `export function probeCaller(): string {`,
      `  const password = "MyS3cretPassw0rd12345678";`,
      `  return probeSubject() + password;`,
      `}`,
      ``,
    ];
    // The slice/viewport indexes scan the declared source directories, so the
    // fixture has to live in one of them for those tools to reach the viewer.
    const file = "src/probe-fixture.ts";
    mkdirSync(join(directory, "src"), { recursive: true });
    writeFileSync(join(directory, file), source.join("\n"));

    const probeRegistry = createToolRegistry({ privacyPolicy: PROBE });
    const refusingRegistry = createToolRegistry({ privacyPolicy: UNCERTIFIABLE });

    const covered: string[] = [];
    const failures: string[] = [];
    for (const definition of probeRegistry.definitions()) {
      const name = definition.function.name;
      const args = argumentsFromSchema(definition, file, "probeSubject", source.length);
      const admitted = probeRegistry.execute({ id: `probe-${name}`, name, arguments: args }, { repositoryRoot: directory });
      // The liveness precondition: this tool really did run the viewer under
      // OUR policy, and really did produce content.
      if (admitted.isError) continue;
      if (!admitted.content.includes(PROBE.redactionPrefix)) continue;
      covered.push(name);
      if (admitted.content.includes("MyS3cretPassw0rd12345678")) {
        failures.push(`${name}: the benign run leaked the secret it was supposed to mask`);
      }

      const refused = refusingRegistry.execute({ id: `refused-${name}`, name, arguments: args }, { repositoryRoot: directory });
      if (!refused.isError) {
        failures.push(
          `${name}: a view whose redaction cannot be certified must be an error, not a payload. ` +
            `Got isError=false with ${JSON.stringify(refused.content.slice(0, 200))}`,
        );
        continue;
      }
      if (!refused.content.includes("refused")) {
        failures.push(`${name}: the error must say the view was refused; got ${JSON.stringify(refused.content)}`);
      }
      if (refused.content.length === 0) {
        failures.push(`${name}: a refusal must never be delivered as empty content`);
      }
    }

    assert.ok(
      covered.length >= 3,
      `the probe must actually drive the viewer through the registry; tools covered: ${JSON.stringify(covered)}`,
    );
    assert.deepEqual(failures, [], failures.join("; "));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
