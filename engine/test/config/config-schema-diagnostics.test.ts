import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { describeSchemaIssues } from "../../src/kernel/errors.ts";
import type { Invocation } from "../support/s1-scenario-shared.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

/**
 * `s1-scenario-shared.ts` parses the shipped config at MODULE scope, so a
 * schema/config mismatch makes importing it throw before any test body runs —
 * which is precisely the failure mode these tests exist to describe. It is
 * therefore imported lazily, inside the one test that needs a subprocess, so
 * the pure-schema assertions below still execute (and still explain
 * themselves) when the shipped config does not validate.
 */
async function scenarioHarness() {
  return import("../support/s1-scenario-shared.ts");
}

/**
 * Config schema failures must NAME what is wrong.
 *
 * THE DEFECT THIS GUARDS
 *
 * `parseConfigDocument` used to discard `safeParse`'s error entirely and throw
 * a bare "Configuration does not match the canonical schema". The config
 * loader runs before everything, so a single unknown key stopped the harness
 * — and every test — with an error that named neither the key nor its
 * section. The observed failure was four keys added under `webUi.graph`
 * without the matching schema entries: `npm test` printed
 * `{"error":"config_schema_invalid","message":"Configuration does not match
 * the canonical schema"}` and nothing else, so the only way to find the key
 * was to bisect the config by hand.
 *
 * DYNAMIC DISCOVERY
 *
 * The sweep below enumerates the object sections of the REAL shipped config at
 * run time; it never carries a list of section names. A section added to the
 * config is covered the moment it exists, and a section removed stops being
 * required — the test cannot go stale.
 */

const CONFIG_PATH = new URL("../../bridlewise.config.json", import.meta.url);

/** A key no schema section may legitimately accept. */
const PROBE_KEY = "__unknown_probe_key__";

function shippedConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The single JSON error line the CLI writes to stderr. */
function errorPayload(invocation: Invocation): Record<string, unknown> {
  const line = invocation.stderr.split("\n").find((candidate) => candidate.trim().startsWith("{"));
  assert.ok(line !== undefined, `no JSON error line on stderr: ${invocation.stderr}`);
  return JSON.parse(line) as Record<string, unknown>;
}

test("config schema: the shipped bridlewise.config.json validates against the canonical schema", () => {
  const parsed = CONFIG_DOCUMENT_SCHEMA.safeParse(shippedConfig());
  assert.ok(
    parsed.success,
    parsed.success
      ? ""
      : "The shipped config does not match src/config-contracts.ts. A key was added to " +
        "bridlewise.config.json (or to a web-UI consumer) without the matching schema " +
        `entry. Offending paths: ${describeSchemaIssues(parsed.error.issues)}`,
  );
});

test("config schema diagnostics: an unknown key in ANY config section is named by path and key", () => {
  const shipped = shippedConfig();
  const sections = Object.keys(shipped)
    .filter((key) => isPlainObject(shipped[key]))
    .toSorted();
  assert.ok(sections.length > 0, "dynamic discovery found no object sections in the shipped config");

  for (const section of sections) {
    const candidate = structuredClone(shipped);
    (candidate[section] as Record<string, unknown>)[PROBE_KEY] = 1;
    const parsed = CONFIG_DOCUMENT_SCHEMA.safeParse(candidate);
    assert.equal(
      parsed.success,
      false,
      `section "${section}" accepted an unknown key — deny-by-default requires a strict object`,
    );
    const detail = describeSchemaIssues(parsed.error.issues);
    assert.ok(detail.includes(section), `failure detail must name the section "${section}", got: ${detail}`);
    assert.ok(detail.includes(PROBE_KEY), `failure detail must name the offending key, got: ${detail}`);
  }
});

test("config schema diagnostics: the detail renders paths, codes and key names — never the validator message", () => {
  // A validator's human message MAY embed the offending VALUE (Zod does for
  // several issue types, and a custom refinement can for any of them). A
  // config value may be a secret, so the renderer must carry the schema's own
  // vocabulary — path, code, key name — and must ignore `message` entirely.
  // The issue below is shaped exactly like a real one plus a message that
  // quotes the value, which is the case that must not round-trip.
  const SECRET = "s3cr3t-value-do-not-echo";
  const issue = {
    code: "invalid_type",
    path: ["credentials", "token"],
    message: `Invalid input: expected number, received "${SECRET}"`,
  };
  const detail = describeSchemaIssues([issue]);
  assert.ok(!detail.includes(SECRET), `detail leaked a document value: ${detail}`);
  assert.ok(detail.includes("credentials.token"), `detail must name the path, got: ${detail}`);
  assert.ok(detail.includes("invalid_type"), `detail must name the code, got: ${detail}`);
});

test("config schema diagnostics: a pathless issue is located, not blank", () => {
  // An issue at the document root has an empty `path`. Rendering it as "" is
  // indistinguishable from a missing location, so it gets an explicit marker.
  const detail = describeSchemaIssues([{ code: "unrecognized_keys", path: [], keys: ["rootPolicy"] }]);
  assert.ok(detail.includes("<root>"), `a pathless issue must be located, got: ${detail}`);
  assert.ok(detail.includes("rootPolicy"), `a pathless issue must still name its keys, got: ${detail}`);
});

test("config schema diagnostics: describeSchemaIssues is total for an empty issue list", () => {
  assert.equal(describeSchemaIssues([]), "no issues reported");
});

test("config schema diagnostics: the CLI reports WHICH key was rejected", async () => {
  const { config, invoke, makeRuntimeCandidate, removeOwnedTemporaryDirectories, writeConfig } =
    await scenarioHarness();
  try {
    const root = makeRuntimeCandidate();
    writeConfig(root, { ...config(), rootPolicy: { modelInvocation: true } });
    const payload = errorPayload(invoke(root));
    assert.equal(payload.error, "config_schema_invalid");
    const message = String(payload.message);
    assert.match(
      message,
      /rootPolicy/u,
      `the operator-facing message must name the offending key, got: ${message}`,
    );
  } finally {
    removeOwnedTemporaryDirectories();
  }
});
