import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  parseSseEventBlock,
  parseSseText,
  SseBuffer,
  SSE_DONE_SENTINEL,
} from "../../src/runtime/sse-parser.ts";
import { MWA_DEFAULT_ROOT_POLICY } from "../../verification/core/coordination/migration-write-authority/backend-node-sqlite.ts";
import { PROVIDER_NOT_CONFIGURED_BASE_URL, isProviderConfigured } from "../../src/kernel/contracts.ts";
import { createDriftDetector, DEFAULT_DRIFT_CONFIG } from "../../src/memory/unified/drift-detector.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { RESPONSES_TRANSPORT_SCHEMA } from "../../src/shared/llm/config.ts";
import { engineModulePath, engineModuleSourceRelative } from "../support/module-resolver.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

/**
 * DRY-6 regression: the `[DONE]` SSE sentinel and the MCP protocol version
 * were hardcoded in runtime code instead of read from the central config. The
 * fix routed both through the config contract / root policy. These tests
 * mechanically verify (a) the SSE parser honours a config-provided sentinel,
 * (b) the MCP adapter reads the protocol version from root policy (not a
 * local literal), and (c) no runtime file hardcodes the literals as a string
 * value outside the canonical owners.
 */

const CONFIG_PATH = join(process.cwd(), "bridlewise.config.json");

interface ConfigShape {
  contracts?: Readonly<{ chatStreamDoneSentinel?: string; mcpProtocolVersion?: string }>;
}

function readConfigSentinel(): string {
  assert.ok(existsSync(CONFIG_PATH), "bridlewise.config.json must exist");
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigShape;
  const sentinel = raw.contracts?.chatStreamDoneSentinel;
  assert.ok(typeof sentinel === "string", "config.contracts.chatStreamDoneSentinel must be a string");
  return sentinel;
}

// a2-design L1: every native transport field is discoverable to an operator
// in the shipped document — the KEY set of `runtime.responses` equals the
// transport schema's (`maximumResponseHeaderBytes` was missing). Values are
// deliberately not compared: the schema's defaults are the one owner.
test("config-consistency: runtime.responses in the shipped document declares every transport field", () => {
  const document = JSON.parse(readFileSync(join(process.cwd(), "bridlewise.config.json"), "utf8")) as { runtime?: { responses?: Record<string, unknown> } };
  const declared = Object.keys(document.runtime?.responses ?? {}).sort();
  assert.deepEqual(declared, Object.keys(RESPONSES_TRANSPORT_SCHEMA.shape).sort());
});

test("config-consistency: SSE parser default sentinel equals the config sentinel", () => {
  const configSentinel = readConfigSentinel();
  assert.equal(SSE_DONE_SENTINEL, configSentinel, "SSE_DONE_SENTINEL must match config.contracts.chatStreamDoneSentinel");
  assert.equal(SSE_DONE_SENTINEL, "[DONE]");
});

test("config-consistency: parseSseEventBlock honours a custom config sentinel", () => {
  // A custom sentinel (e.g. "[STREAM_DONE]") from a hypothetical config must
  // be respected as the end-of-stream marker, not the hardcoded [DONE].
  const custom = "[STREAM_DONE]";
  const ev = parseSseEventBlock("data: [STREAM_DONE]", custom);
  assert.equal(ev?.type, "done");
  // The default sentinel must NOT terminate a stream using the custom sentinel.
  const notDone = parseSseEventBlock("data: [DONE]", custom);
  assert.equal(notDone?.type, "data");
  assert.equal((notDone as { data: string }).data, "[DONE]");
});

test("config-consistency: SseBuffer honours a custom config sentinel", () => {
  const custom = "<<END>>";
  const buf = new SseBuffer(custom);
  buf.push("data: hello\n\ndata: <<END>>\n\n");
  const events = [...buf.drain(), ...buf.flush()];
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, "data");
  assert.equal(events[1]!.type, "done");
});

test("config-consistency: parseSseText honours a custom config sentinel end-to-end", () => {
  const custom = "STOP";
  const events = parseSseText("data: a\n\ndata: STOP\n\ndata: b\n\n", custom);
  // parseSseText is a batch parser: it yields every parsed event (it does not
  // short-circuit at the done marker the way the streaming generator does).
  // The contract under test is that the custom sentinel is RECOGNIZED as the
  // done event type, not the default [DONE].
  assert.ok(events.length >= 2, `expected at least 2 events, got ${events.length}`);
  assert.equal(events[0]!.type, "data");
  assert.equal(events[1]!.type, "done", `the custom sentinel "STOP" must be recognized as the done event, got ${events[1]!.type}`);
  // The default [DONE] must NOT be recognized when a custom sentinel is configured.
  const defaultEvents = parseSseText("data: [DONE]\n\n", custom);
  assert.equal(defaultEvents[0]!.type, "data", "with a custom sentinel, the default [DONE] must be plain data, not done");
  assert.equal((defaultEvents[0] as { data: string }).data, "[DONE]");
});

test("config-consistency: MCP adapter protocol version is sourced from root policy", () => {
  // The MCP adapter must not hardcode the protocol version. It must read
  // ROOT_POLICY.contracts.mcpProtocolVersion. We verify the root policy value
  // is the single source the adapter consumes.
  assert.ok(
    typeof ROOT_POLICY.contracts.mcpProtocolVersion === "string" &&
      ROOT_POLICY.contracts.mcpProtocolVersion.length > 0,
    "root policy must declare mcpProtocolVersion",
  );
  // The config document also declares the same value (the schema literal binds it).
  assert.equal(
    ROOT_POLICY.contracts.mcpProtocolVersion,
    "2025-11-25",
    "mcpProtocolVersion canonical value",
  );
});

// ---------------------------------------------------------------------------
// Mechanical prevention: no runtime file hardcodes the protocol version literal
// or the SSE sentinel literal outside the canonical owners.
// ---------------------------------------------------------------------------

function readFile(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  acc.push(...walk(dir, { exts: [".ts"] }));
  return acc;
}

/** Every TypeScript module under `src/`, discovered rather than listed. */
function srcTsFiles(): string[] {
  return listTsFiles(join(process.cwd(), "src"));
}

/** A repository-relative path, so a failure message names a file a reader can open. */
function relativeToRepo(absolute: string): string {
  const root = `${process.cwd()}/`;
  return absolute.startsWith(root) ? absolute.slice(root.length) : absolute;
}

test("mechanical: mcp/config.ts does not hardcode the MCP protocol version as a literal", () => {
  const src = readFile("src/mcp/config.ts");
  // The MCP module must source the default protocol version from ROOT_POLICY,
  // not a local literal.
  assert.ok(
    /protocolVersion:\s*ROOT_POLICY\.contracts\.mcpProtocolVersion/u.test(src),
    "mcp/config.ts must derive DEFAULT_MCP_MODULE_CONFIG.defaults.protocolVersion from ROOT_POLICY.contracts.mcpProtocolVersion",
  );
  // A local literal assignment like protocolVersion: "2025-11-25" is forbidden.
  const localLiteral = /protocolVersion\s*[:=]\s*["'`]2025-11-25["'`]/u;
  assert.equal(
    localLiteral.test(src),
    false,
    "mcp/config.ts must not hardcode protocolVersion: \"2025-11-25\"",
  );
});

test("mechanical: provider-adapter.ts does not hardcode the [DONE] sentinel", () => {
  const providerSrc = readFile("src/runtime/provider-adapter.ts");
  // It must use the imported SSE_DONE_SENTINEL or the config-provided value,
  // never a fresh "[DONE]" string literal. (The CLI chat surface that
  // threaded chatStreamDoneSentinel was removed; the web UI runtime owns that
  // wiring now. The [DONE]-literal scan test below covers every src file.)
  const doneLiteral = /["'`]\[DONE\]["'`]/u;
  assert.equal(
    doneLiteral.test(providerSrc),
    false,
    "provider-adapter.ts must not hardcode \"[DONE]\" (use SSE_DONE_SENTINEL or config sentinel)",
  );
});

test("mechanical: the [DONE] literal is owned only by root-policy.ts", () => {
  const files = listTsFiles(join(process.cwd(), "src"));
  const doneLiteral = /["'`]\[DONE\]["'`]/u;
  const allowed = new Set([
    engineModulePath("root-policy.ts"),
  ]);
  const offenders: string[] = [];
  for (const file of files) {
    if (allowed.has(file)) continue;
    const text = readFileSync(file, "utf8");
    if (doneLiteral.test(text)) {
      offenders.push(file.replace(process.cwd() + "/", ""));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `"[DONE]" literal may only appear in root-policy.ts (the policy authority); sse-parser.ts must derive it. Offenders: ${offenders.join(", ")}`,
  );
});

test("mechanical: sse-parser.ts derives the [DONE] sentinel from root policy", () => {
  // The SSE parser must not hardcode the sentinel. It must derive
  // SSE_DONE_SENTINEL from ROOT_POLICY.contracts.chatStreamDoneSentinel so the
  // runtime default stays linked to the canonical authority (DRY-6).
  const src = readFile("src/runtime/sse-parser.ts");
  assert.ok(
    /SSE_DONE_SENTINEL\s*=\s*ROOT_POLICY\.contracts\.chatStreamDoneSentinel/u.test(src),
    "sse-parser.ts must derive SSE_DONE_SENTINEL from ROOT_POLICY.contracts.chatStreamDoneSentinel",
  );
  // A local literal assignment like SSE_DONE_SENTINEL = "[DONE]" is forbidden.
  const localLiteral = /SSE_DONE_SENTINEL\s*=\s*["'`]\[DONE\]["'`]/u;
  assert.equal(
    localLiteral.test(src),
    false,
    'sse-parser.ts must not hardcode SSE_DONE_SENTINEL = "[DONE]" (derive from ROOT_POLICY)',
  );
});

// ---------------------------------------------------------------------------
// CONF-1..5 / AGN-1: mechanical prevention — the runtime must source
// performance, privacy, memory, tool-iteration, and allowed-command config
// from the central config document, and the eval CLI must not hardcode a
// provider id.
// ---------------------------------------------------------------------------

test("mechanical: interactive-session.ts does not hardcode a module-level MAXIMUM_TOOL_ITERATIONS used directly (CONF-4)", () => {
  const src = readFile("src/runtime/interactive-session.ts");
  assert.ok(/maximumToolIterations/.test(src), "interactive-session.ts must accept a maximumToolIterations option");
  assert.ok(!/const MAXIMUM_TOOL_ITERATIONS\b/.test(src), "interactive-session.ts must not define a hardcoded MAXIMUM_TOOL_ITERATIONS constant");
});

test("mechanical: built-in-tools.ts does not use a module-level ALLOWED_COMMAND_SET directly (CONF-5)", () => {
  const src = readFile("src/tools/built-in-tools.ts");
  assert.ok(/allowedCommands\?/.test(src), "built-in-tools.ts must accept an allowedCommands option");
  assert.ok(!/const ALLOWED_COMMAND_SET\b/.test(src), "built-in-tools.ts must not use a hardcoded ALLOWED_COMMAND_SET");
});

test("mechanical: evaluation/cli.ts does not hardcode MAKORA_PROVIDER_ID (AGN-1)", () => {
  const src = readFile("src/evaluation/cli.ts");
  assert.ok(!/MAKORA_PROVIDER_ID/.test(src), "evaluation/cli.ts must not hardcode MAKORA_PROVIDER_ID");
  assert.ok(/opts\.providerId\s*\?\?\s*runtime\.defaultProvider/.test(src), "evaluation/cli.ts must resolve the provider from --provider or runtime.defaultProvider");
});

test("mechanical: evaluation/semantic-validators.ts does not hardcode CHEP_MODELS for exact_models_only (AGN-4)", () => {
  const src = readFile("src/evaluation/semantic-validators.ts");
  assert.ok(!/CHEP_MODELS/.test(src), "semantic-validators.ts must not import or reference the hardcoded CHEP_MODELS constant");
  assert.ok(/matrix\.models/.test(src), "semantic-validators.ts must validate against the matrix's declared models");
});

// ---------------------------------------------------------------------------
// B1..B10: mechanical prevention — config sections must be consumed by the
// implementations, not just defined in the schema.
// ---------------------------------------------------------------------------

test("mechanical: evaluation/cli.ts passes timeline/evaluation/sseLimits config (B2,B3,B7,B8,B10)", () => {
  const src = readFile("src/evaluation/cli.ts");
  assert.ok(/document\.timeline/.test(src), "evaluation/cli.ts must read document.timeline (B2/B8)");
  assert.ok(/document\.evaluation/.test(src), "evaluation/cli.ts must read document.evaluation (B7)");
  assert.ok(/sseLimits/.test(src), "evaluation/cli.ts must pass sseLimits to the provider adapter (B3)");
  assert.ok(/provider\.baseUrl/.test(src), "evaluation/cli.ts must pass provider.baseUrl as runtimeTarget (B10)");
});

test("mechanical: provider-adapter.ts uses retryableStatusCodes and responsesPath from config (B5)", () => {
  const src = readFile("src/runtime/provider-adapter.ts");
  assert.ok(/retryableStatusCodes/.test(src), "provider-adapter.ts must use retryableStatusCodes from config (B5)");
  // The adapter speaks the Responses API since the migration: its endpoint
  // path is `responsesPath` from config (the Chat Completions path retired).
  assert.ok(/responsesPath/.test(src), "provider-adapter.ts must accept responsesPath from config (B5)");
  assert.ok(!/response\.status\s*===\s*429\s*\|\|\s*response\.status\s*>=\s*500/.test(src), "provider-adapter.ts must not hardcode 429/5xx retry check");
});

test("mechanical: scenario-runner.ts uses providerConfig.id instead of hardcoded makora (B9)", () => {
  const src = readFile("src/evaluation/scenario-runner.ts");
  assert.ok(/request\.providerConfig\.id/.test(src), "scenario-runner.ts must use request.providerConfig.id (B9)");
  assert.ok(!/id:\s*["']makora["']/.test(src), "scenario-runner.ts must not hardcode id: \"makora\" (B9)");
});

// ─────────────────────────────────────────────────────────────────────────────
// A DEFAULT ENDPOINT IS A DEFAULT DESTINATION FOR A CREDENTIAL.
//
// This test used to grep matrix-generator.ts for the STRING
// `provider-not-configured`, which is a guard keyed to a spelling — and the
// spelling moved the moment the sentinel got the single owner it should always
// have had. So the claim is now keyed to the VALUE and to the POPULATION: every
// module in `src/` that carries a default provider address must take it from
// `PROVIDER_NOT_CONFIGURED_BASE_URL`, and no module in `src/` may name a real
// vendor host as one. That covers matrix-generator AND the drift detector, whose
// default was a live vendor endpoint reached by two callers supplying a key and
// inheriting the address.
// ─────────────────────────────────────────────────────────────────────────────

test("mechanical: the not-configured endpoint sentinel is unresolvable and has ONE owner (B10)", () => {
  // RFC 2606 reserves `.invalid`, so this address can never resolve. A sentinel
  // that could resolve is a destination.
  assert.ok(
    PROVIDER_NOT_CONFIGURED_BASE_URL.includes(".invalid"),
    `the sentinel must be in a reserved-and-unresolvable domain, got ${PROVIDER_NOT_CONFIGURED_BASE_URL}`,
  );
  assert.equal(isProviderConfigured(PROVIDER_NOT_CONFIGURED_BASE_URL), false);
  assert.equal(isProviderConfigured(""), false);
  // LIVENESS, the other direction: the predicate is not an off switch.
  assert.equal(isProviderConfigured("https://api.example.com/v1"), true);
  // The literal is written out exactly ONCE in `src/`, where it is declared.
  const declarations: string[] = [];
  for (const file of srcTsFiles()) {
    if (readFileSync(file, "utf8").includes(`"${PROVIDER_NOT_CONFIGURED_BASE_URL}"`)) declarations.push(relativeToRepo(file));
  }
  assert.deepEqual(
    declarations,
    [engineModuleSourceRelative("kernel/contracts.ts")],
    `the sentinel must be spelled once, in its owner. Copies found in: ${declarations.join(", ")}`,
  );
});

// ── The address guard is VALUE-SHAPED, not spelling-keyed ──────────────────
// The previous matcher required one of four FIELD NAMES (`apiBaseUrl`,
// `baseUrl`, `runtimeTarget`, `runtime_target`) before it looked at the
// value, and a planted `apiUrl:` vendor default walked past all of it — a
// guard keyed to spellings certifies only the spellings someone remembered
// (the §25 class). The subject was never the field name: it is AN ABSOLUTE
// http(s) URL LITERAL BEING ASSIGNED IN src/, whatever it is called. So the
// matcher now keys on the value shape alone, and the small set of legitimate
// assignments is admitted by a REASONED allowlist below, each entry carrying
// the mechanism that makes it harmless rather than a name.

/** Matches any assignment (`:` or `=`) of an absolute http(s) URL literal,
 *  in any quote style. The field name is deliberately not consulted. */
const URL_ASSIGNMENT = /[:=]=?\s*["'`](https?:\/\/[^"'`\s]+)["'`]/gu;

/**
 * Why each admitted address cannot be a default destination for a credential:
 *  - the sentinel itself, and any `.invalid` host: RFC 2606 reserves the TLD
 *    and it can NEVER resolve — an unreachable default is a refusal in DNS;
 *  - the other RFC 2606 reservations (`.test`, `.example`, `example.com/net/
 *    org`): equally unresolvable or IANA-held, the documented spelling for
 *    examples — a "vendor" in these domains answers to nobody;
 *  - loopback (`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`): traffic that
 *    cannot leave the machine is not an exfiltration destination;
 *  - `json-schema.org`: the JSON-Schema DIALECT IDENTIFIER (`$schema`) is a
 *    name compared by value, not an address this code ever connects to —
 *    asserted below rather than trusted.
 */
function isAdmittedAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false; // an unparseable "URL" is judged, not excused
  }
  if (url === PROVIDER_NOT_CONFIGURED_BASE_URL) return true;
  if (/\.(?:invalid|test|example)$/u.test(host)) return true;
  if (/(?:^|\.)example\.(?:com|net|org)$/u.test(host)) return true;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0") return true;
  if (host === "json-schema.org") return true;
  return false;
}

test("mechanical: no module in src/ assigns an absolute URL that could be a vendor default (B10)", () => {
  const offenders: string[] = [];
  let matches = 0;
  for (const file of srcTsFiles()) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(URL_ASSIGNMENT)) {
      matches += 1;
      const url = m[1]!;
      if (!isAdmittedAddress(url)) {
        offenders.push(`${relativeToRepo(file)}: ${m[0]}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `a default provider address sends an inherited credential somewhere the caller never named — ` +
    `and the guard keys on the VALUE, so renaming the field does not excuse it. ` +
    `Use PROVIDER_NOT_CONFIGURED_BASE_URL and refuse the incoherent pair (an example belongs ` +
    `in an RFC 2606 domain: .invalid/.test/.example). Offenders: ${offenders.join(" | ")}`,
  );
  // The universe is not empty: the sentinel's own declaration and the two
  // schema-dialect identifiers are real assignments this matcher must see.
  assert.ok(matches >= 3, `the matcher saw only ${matches} URL assignments across src/ — a scan over nothing certifies nothing`);
  // PLANTED VIOLATIONS, entering the same matcher a real file enters. Both
  // are shapes the OLD spelling-keyed matcher walked past:
  //  1. the exact driven escape — a field name outside the four spellings;
  //  2. a bare exported const, no field name at all.
  const plants = [
    `export const C = { apiUrl: "https://api.acme-llm.com/v1", apiKey: "" };`,
    `export const RUNTIME = "https://api.acme-llm.com/v1";`,
  ];
  for (const planted of plants) {
    const hits = [...planted.matchAll(URL_ASSIGNMENT)].map((m) => m[1]!).filter((u) => !isAdmittedAddress(u));
    assert.equal(hits.length, 1, `the matcher must refuse this planted vendor default: ${planted}`);
  }
  // THE EXEMPTIONS CARRY EVIDENCE TOO. Each allowlisted shape is planted and
  // must be ADMITTED — an allowlist entry that never matches anything is a
  // claim nobody checked — and the dialect identifier's harmlessness is a
  // checkable fact: nothing in src/ passes a json-schema.org address to any
  // fetch/request call (the identifier is compared, never dialled).
  const admitted = [
    `const S = { schemaDialect: "https://json-schema.org/draft/2020-12/schema" };`,
    `const L = { baseUrl: "http://localhost:8080/v1" };`,
    `const E = { apiUrl: "https://api.some-vendor.example/v1" };`,
  ];
  for (const planted of admitted) {
    const hits = [...planted.matchAll(URL_ASSIGNMENT)].map((m) => m[1]!);
    assert.equal(hits.length, 1, `the matcher must still SEE the admitted shape: ${planted}`);
    assert.equal(isAdmittedAddress(hits[0]!), true, `this shape is in the reasoned allowlist: ${planted}`);
  }
  for (const file of srcTsFiles()) {
    const src = readFileSync(file, "utf8");
    if (!src.includes("json-schema.org")) continue;
    assert.ok(
      !/\b(?:fetch|request|axios|got)\s*\([^)]*json-schema\.org/u.test(src),
      `${relativeToRepo(file)} appears to DIAL json-schema.org — the allowlist admits it only as an identifier`,
    );
  }
  // And the population is real.
  assert.ok(srcTsFiles().length > 100, `src file population: ${srcTsFiles().length}`);
});

test("mechanical: a drift API key without an address is REFUSED, not addressed at a guess (B10)", () => {
  // The refusal is what a caller meets; the unresolvable default is what stays
  // true if the refusal is ever removed. Both are asserted.
  assert.equal(DEFAULT_DRIFT_CONFIG.apiBaseUrl, PROVIDER_NOT_CONFIGURED_BASE_URL);
  assert.equal(DEFAULT_DRIFT_CONFIG.apiKey, "");
  // THE PARTIAL OVERRIDE — the shape the spread invites, and the one two real
  // callers took: supply the key, inherit the address.
  assert.throws(
    () => createDriftDetector({ apiKey: "sk-a-real-key-the-user-pasted" }),
    (error: unknown) => error instanceof InputError
      && (error as InputError & { code?: string }).code === "drift_api_base_url_missing",
    "a key with an inherited address must be refused by code, not merely by luck",
  );
  // THE SAME TRAP, ONE FIELD OVER: a key with an address but no model used to
  // inherit a vendor's model from the default config — a request this code
  // composed on the caller's behalf. Refused the same way, and the default
  // model is empty so the refusal stays true if it is ever removed.
  assert.equal(DEFAULT_DRIFT_CONFIG.apiModel, "");
  assert.throws(
    () => createDriftDetector({ apiKey: "sk-key", apiBaseUrl: "https://api.example.com/v1" }),
    (error: unknown) => error instanceof InputError
      && (error as InputError & { code?: string }).code === "drift_api_model_missing",
    "a key with an address but an inherited model must be refused",
  );
  // BOTH DIRECTIONS. No key at all is a legitimate state: the deterministic
  // layer alone, which is what an unconfigured install runs.
  assert.equal(createDriftDetector({ apiKey: "" }).config.apiKey, "");
  // And a key WITH its address AND model constructs, so the refusals are not
  // an off switch.
  const configured = createDriftDetector({
    apiKey: "sk-key",
    apiBaseUrl: "https://api.example.com/v1",
    apiModel: "user-chosen-model",
  });
  assert.equal(configured.config.apiBaseUrl, "https://api.example.com/v1");
  assert.equal(configured.config.apiModel, "user-chosen-model");
});

// ---------------------------------------------------------------------------
// Protocol ID order-stability: protocol-projections.ts, event-state.ts, and
// capability-negotiation.ts derive protocol IDs positionally from
// ROOT_POLICY.contracts.protocolIds[N]. The schema is z.array (unordered),
// so reordering the array would silently break the positional indexing.
// These tests pin the exact order and length so a reorder fails mechanically.
// ---------------------------------------------------------------------------

test("config-consistency: ROOT_POLICY.contracts.protocolIds has exactly 3 entries", () => {
  assert.equal(ROOT_POLICY.contracts.protocolIds.length, 3, "protocolIds must have exactly 3 entries");
});

test("config-consistency: ROOT_POLICY.contracts.protocolIds[0] is openai-responses", () => {
  assert.equal(ROOT_POLICY.contracts.protocolIds[0], "openai-responses", "protocolIds[0] must be openai-responses");
});

test("config-consistency: ROOT_POLICY.contracts.protocolIds[1] is openai-chat-completions", () => {
  assert.equal(ROOT_POLICY.contracts.protocolIds[1], "openai-chat-completions", "protocolIds[1] must be openai-chat-completions");
});

test("config-consistency: ROOT_POLICY.contracts.protocolIds[2] is mcp-2025-11-25", () => {
  assert.equal(ROOT_POLICY.contracts.protocolIds[2], "mcp-2025-11-25", "protocolIds[2] must be mcp-2025-11-25");
});

// ---------------------------------------------------------------------------
// MWA Tranche 3: the migrationAuthority section exists in ROOT_POLICY (safety
// ceilings), the config document schema (operator-selectable, bounded), and
// the operational config (bridlewise.config.json). The ROOT_POLICY_HASH is
// fully dynamic (canonicalHash(ROOT_POLICY)), so no hardcoded hash literal
// needs updating; the foundation cascade references the constant.
// ---------------------------------------------------------------------------

test("config-consistency: ROOT_POLICY.migrationAuthority declares immutable ceilings and backend requirements", () => {
  const ma = ROOT_POLICY.migrationAuthority;
  assert.ok(ma, "ROOT_POLICY.migrationAuthority must exist");
  assert.equal(ma.limits.maxLeaseTtlMs, 600_000);
  assert.equal(ma.limits.maxHeartbeatIntervalMs, 30_000);
  assert.equal(ma.limits.maxRenewalCeilingMs, 600_000);
  assert.equal(ma.limits.maxOrphanGraceMs, 300_000);
  assert.equal(ma.limits.maxReconciliationTimeoutMs, 600_000);
  assert.equal(ma.limits.maxResourcesPerLease, 4096);
  assert.equal(ma.limits.maxWaiters, 64);
  assert.equal(ma.limits.maxBusyTimeoutMs, 300_000);
  assert.equal(ma.limits.maxJournalEntriesPerLease, 100_000);
  assert.equal(ma.limits.maxCheckpointCadenceMs, 10_000);
  assert.equal(ma.limits.maxFencingGeneration, "9223372036854775807");
  assert.equal(ma.backend.candidate, "node:sqlite");
  assert.equal(ma.backend.requiredJournalMode, "delete");
  assert.equal(ma.backend.requiredSynchronous, "extra");
  assert.equal(ma.backend.requiredForeignKeys, true);
  assert.equal(ma.backend.requiredDefensive, true);
  assert.equal(ma.backend.walAllowed, false);
  assert.equal(ma.recovery.directionPreferenceDefault, "next");
  assert.equal(ma.recovery.blockedUnknownEffectPolicy, "preserve-journal-and-evidence");
});

test("config-consistency: ROOT_POLICY.workspaceConcurrencyArchitecture declares the MWA builder proving ground", () => {
  assert.equal(
    ROOT_POLICY.workspaceConcurrencyArchitecture.builderProvingGround,
    "migration-write-authority/v1",
    "builderProvingGround must bind the MWA builder authority",
  );
});

test("config-consistency: ROOT_POLICY.paths.migrationAuthorityRoot pins the 0700 private child of the git common dir", () => {
  const mwaRoot = ROOT_POLICY.paths.migrationAuthorityRoot;
  assert.ok(mwaRoot, "ROOT_POLICY.paths.migrationAuthorityRoot must exist");
  assert.equal(mwaRoot.childName, "bridlewise-migration-authority");
  assert.ok(mwaRoot.outsideTrackedCandidateAndGitOwnedNamespaces);
});

test("config-consistency: the operational config carries a migrationAuthority section bounded by the ceilings", () => {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { migrationAuthority?: Record<string, unknown> };
  assert.ok(raw.migrationAuthority, "bridlewise.config.json must have a migrationAuthority section");
  const ma = raw.migrationAuthority!;
  assert.ok(typeof ma.leaseTtlMs === "number" && ma.leaseTtlMs <= ROOT_POLICY.migrationAuthority.limits.maxLeaseTtlMs);
  assert.ok(typeof ma.heartbeatIntervalMs === "number" && ma.heartbeatIntervalMs <= ROOT_POLICY.migrationAuthority.limits.maxHeartbeatIntervalMs);
  assert.ok(typeof ma.busyTimeoutMs === "number" && ma.busyTimeoutMs <= ROOT_POLICY.migrationAuthority.limits.maxBusyTimeoutMs);
  assert.ok(typeof ma.checkpointCadenceMs === "number" && ma.checkpointCadenceMs <= ROOT_POLICY.migrationAuthority.limits.maxCheckpointCadenceMs);
  assert.ok(ma.recoveryDirectionPreference === "previous" || ma.recoveryDirectionPreference === "next");
});

test("config-consistency: ROOT_POLICY_HASH is dynamic and the foundation cascade references the constant (no hardcoded literal)", () => {
  const rootPolicySrc = readFile(engineModuleSourceRelative("root-policy.ts"));
  assert.ok(
    /ROOT_POLICY_HASH\s*=\s*canonicalHash\(ROOT_POLICY\)/u.test(rootPolicySrc),
    "ROOT_POLICY_HASH must be canonicalHash(ROOT_POLICY) (dynamic)",
  );
  // The foundation cascade must reference the constant, not a hardcoded hash string.
  const cascadeSrc = readFile("verification/core/foundation-cascade.ts");
  assert.ok(
    /rootPolicyIdentity:\s*z\.literal\(ROOT_POLICY_HASH\)/u.test(cascadeSrc),
    "foundation-cascade.ts must use z.literal(ROOT_POLICY_HASH) (the constant reference)",
  );
});

// ---------------------------------------------------------------------------
// SSOT: MWA_DEFAULT_ROOT_POLICY must equal the ROOT_POLICY.migrationAuthority
// projection for the fields the backend uses. Two ceiling sources can drift
// silently; this contract test catches any divergence.
// ---------------------------------------------------------------------------

test("config-consistency: MWA_DEFAULT_ROOT_POLICY equals ROOT_POLICY.migrationAuthority projection", () => {
  const ma = ROOT_POLICY.migrationAuthority;
  // The backend view projects only the fields it uses; ROOT_POLICY has extra
  // fields (candidate, maxRenewalCeilingMs, etc.) the backend does not consume.
  assert.equal(MWA_DEFAULT_ROOT_POLICY.backend.requiredJournalMode, ma.backend.requiredJournalMode, "requiredJournalMode must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.backend.requiredSynchronous, ma.backend.requiredSynchronous, "requiredSynchronous must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.backend.requiredForeignKeys, ma.backend.requiredForeignKeys, "requiredForeignKeys must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.backend.requiredDefensive, ma.backend.requiredDefensive, "requiredDefensive must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.backend.walAllowed, ma.backend.walAllowed, "walAllowed must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.limits.maxLeaseTtlMs, ma.limits.maxLeaseTtlMs, "maxLeaseTtlMs must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.limits.maxHeartbeatIntervalMs, ma.limits.maxHeartbeatIntervalMs, "maxHeartbeatIntervalMs must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.limits.maxResourcesPerLease, ma.limits.maxResourcesPerLease, "maxResourcesPerLease must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.limits.maxBusyTimeoutMs, ma.limits.maxBusyTimeoutMs, "maxBusyTimeoutMs must match");
  assert.equal(MWA_DEFAULT_ROOT_POLICY.limits.maxFencingGeneration, ma.limits.maxFencingGeneration, "maxFencingGeneration must match");
});
