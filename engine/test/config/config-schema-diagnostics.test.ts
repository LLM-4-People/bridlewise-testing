import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

const RETIRED_HARNESS_RETRY_CASES: readonly Readonly<Record<string, number>>[] = [
  { commandErroredRetries: 2 },
  { commandErroredRetries: 0 },
  { commandRetryBackoffMs: 60000 },
  { commandRetryBackoffMs: 1 },
  { commandRetryBackoffMs: 0 },
  { commandErroredRetries: 2, commandRetryBackoffMs: 60000 },
];

function withRetiredRetryKeys(
  document: Record<string, unknown>,
  retired: Readonly<Record<string, number>>,
): Record<string, unknown> {
  return { ...structuredClone(document), harness: { ...(isPlainObject(document.harness) ? document.harness : {}), ...retired } };
}

test("config schema: retired harness retry keys are unknown, including explicit zero", () => {
  const shipped = shippedConfig();
  for (const retired of RETIRED_HARNESS_RETRY_CASES) {
    const parsed = CONFIG_DOCUMENT_SCHEMA.safeParse(withRetiredRetryKeys(shipped, retired));
    assert.equal(parsed.success, false, "a retired retry setting must not be silently accepted");
    const keys = Object.keys(retired);
    assert.ok(
      parsed.error.issues.some((issue) => issue.code === "unrecognized_keys" &&
        issue.path.length === 1 && issue.path[0] === "harness" &&
        keys.every((key) => issue.keys.includes(key))),
      "strict harness schema removal must reject the old vocabulary, rather than retain a configurable leaf",
    );
    const detail = describeSchemaIssues(parsed.error.issues);
    assert.match(detail, /harness/u);
    assert.match(detail, /unrecognized_keys/u);
    for (const key of keys) assert.ok(detail.includes(key), `the canonical diagnostic names ${key}`);
  }
});

test("config schema: the shipped config omits both retired retry declarations and keeps other harness bounds", () => {
  const shipped = shippedConfig();
  assert.ok(isPlainObject(shipped.harness), "the shipped harness bounds remain present");
  for (const key of ["commandErroredRetries", "commandRetryBackoffMs"]) {
    assert.equal(Object.hasOwn(shipped.harness, key), false, `${key} was removed from the shipped document`);
  }
  const legacy = withRetiredRetryKeys(shipped, { commandErroredRetries: 2, commandRetryBackoffMs: 60000 });
  assert.ok(isPlainObject(legacy.harness));
  delete legacy.harness.commandErroredRetries;
  delete legacy.harness.commandRetryBackoffMs;
  assert.deepEqual(legacy, shipped, "migration removes only the two declarations");
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(legacy).success, "omission is the supported configuration");
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

test("config schema diagnostics: the real CLI refuses retired retries without rewriting the config", async () => {
  const { invoke, makeRuntimeCandidate, removeOwnedTemporaryDirectories, writeConfig } =
    await scenarioHarness();
  try {
    const root = makeRuntimeCandidate();
    const configPath = join(root, "bridlewise.config.json");
    // The runtime-copy owner supplies the complete current config. Keep its
    // required fields and every sibling value; vary only the retired keys.
    const document = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    for (const retired of RETIRED_HARNESS_RETRY_CASES) {
      writeConfig(root, withRetiredRetryKeys(document, retired));
      const before = readFileSync(configPath);
      const invocation = invoke(root, ["--version"]);
      assert.notEqual(invocation.status, 0, "a legacy document must not load");
      const payload = errorPayload(invocation);
      assert.equal(payload.error, "config_schema_invalid");
      const message = String(payload.message);
      assert.match(message, /harness/u);
      assert.match(message, /unrecognized_keys/u);
      for (const key of Object.keys(retired)) assert.ok(message.includes(key), `${key} is named in the refusal`);
      assert.deepEqual(readFileSync(configPath), before, "load refusal does not silently migrate the file");
    }
    writeConfig(root, document);
    const omission = invoke(root, ["--version"]);
    assert.equal(
      omission.status,
      0,
      `the same real loader accepts omission\nstdout: ${omission.stdout}\nstderr: ${omission.stderr}`,
    );
  } finally {
    removeOwnedTemporaryDirectories();
  }
});

test("config schema diagnostics: the real engine store refuses retired retry keys before saving", async () => {
  const { makeRuntimeCandidate, removeOwnedTemporaryDirectories } = await scenarioHarness();
  try {
    const root = makeRuntimeCandidate();
    const storeModule = pathToFileURL(join(root, "src", "shared", "exposure", "config-binding.ts")).href;
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { readFileSync } from "node:fs";
      const { createEngineCustomizationConfigStore } = await import(${JSON.stringify(storeModule)});
      const store = createEngineCustomizationConfigStore();
      const original = readFileSync(store.configFilePath);
      const document = store.readDocument();
      const cases = ${JSON.stringify(RETIRED_HARNESS_RETRY_CASES)};
      for (const retired of cases) {
        const candidate = { ...structuredClone(document), harness: { ...(document.harness ?? {}), ...retired } };
        assert.throws(() => store.writeDocument(candidate), (error) => {
          assert.equal(error.code, "invalid_config_document");
          assert.match(error.message, /harness/u);
          assert.match(error.message, /unrecognized_keys/u);
          for (const key of Object.keys(retired)) assert.ok(error.message.includes(key));
          return true;
        });
        assert.deepEqual(readFileSync(store.configFilePath), original, "refused save changed the candidate config");
      }
      const supportedValue = document.memory?.trimThreshold === 0.73 ? 0.74 : 0.73;
      const supported = { ...structuredClone(document), memory: { ...(document.memory ?? {}), trimThreshold: supportedValue } };
      store.writeDocument(supported);
      const saved = readFileSync(store.configFilePath);
      assert.notDeepEqual(saved, original, "the supported control must actually change the stored bytes");
      assert.deepEqual(JSON.parse(saved.toString("utf8")), supported, "saved bytes preserve the complete supported document");
      assert.deepEqual(store.readDocument(), supported, "the real store reads back the supported control");
      process.stdout.write(JSON.stringify({ rejected: cases.length, saved: true }));
    `], { cwd: root, encoding: "utf8", timeout: 120_000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), { rejected: RETIRED_HARNESS_RETRY_CASES.length, saved: true });
  } finally {
    removeOwnedTemporaryDirectories();
  }
});
