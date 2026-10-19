import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";

import { createTempDir } from "../support/temp-dir.ts";
import {
  HARNESS_RUNTIME_LEDGER_ID,
  initializeHarnessRuntime,
  resetHarnessRuntimeForTesting,
} from "../../src/runtime/harness-bootstrap.ts";
// The effect-timing document name has ONE owner: the shared wire-literals
// file both ledgers' writers and readers consume (the harness runtime's sink
// and the web bridge's alike).
import { TIMELINE_EFFECT_TIMING_DOCUMENT, TIMELINE_EFFECT_ARGS_DOCUMENT } from "../../../shared/constants.ts";
import {
  hasEffectSink,
  recordEffect,
  recordRequiredEffectAsync,
  requireRecordedEffect,
  setEffectSink,
  type EffectRecord,
} from "../../src/timeline/recorded-effect.ts";
import { UNATTRIBUTED, withRecordingContext } from "../../src/timeline/recording-context.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { recordProviderStream } from "../../src/timeline/provider-recording.ts";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_MAXIMUM_DOCUMENT_BYTES } from "../../src/timeline/timeline-config.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { snapshotExposure } from "../../src/shared/exposure/index.ts";
import { registerAllExposure } from "../../src/shared/exposure/registrations/index.ts";
import { walk } from "../../scripts/verification/source-walk.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";


/**
 * PREVENTION — every production entry point must make the harness's own
 * recording machinery live, exactly once.
 *
 * THE MEASURED DEFECT: `registerAllExposure`, `withRecordingContext` and
 * `setEffectSink` had ZERO production call sites in this repo — they were
 * exercised only by tests and by the sibling web server (which wires its own
 * sink in `server/timeline-bridge.ts`). Every process driven through the
 * harness directly (the CLI main, the direct `harness-commands` main, `runCli`
 * imported as the package API) ran with an EMPTY exposure catalog and an
 * unset effect sink: correct machinery attached to nothing.
 *
 * DYNAMIC DISCOVERY — entry points are enumerated from the code on every run:
 * (a) every `src/**​/*.ts` file carrying the `import.meta.url` main-module
 * guard, and (b) every module named by `package.json` (`exports`, `bin`, the
 * `start` script). No hardcoded entry list: adding a new main can never
 * silently bypass this guard.
 *
 * Each discovered entry must call `initializeHarnessRuntime(` (exposure
 * catalog + ledger sink, idempotent) and `withRecordingContext(` (a recording
 * boundary with a REAL actor). The behavioral tests below then prove the
 * exactly-once properties: repeated initialization is a no-op, an embedder's
 * pre-installed sink is never clobbered, no effect is ever recorded twice,
 * and an out-of-boundary record stays honestly `unattributed`.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** The main-module guard idiom used by every executable module in `src/`. */
const MAIN_GUARD = "isEntryPoint(import.meta.url)";

/** Wiring both halves of the runtime: catalog+sink, and an attributed boundary. */
const REQUIRED_WIRING = ["initializeHarnessRuntime(", "withRecordingContext("] as const;

/**
 * Strip comments before matching: a wiring CALL must exist in executable
 * code. Without this, a commented-out `initializeHarnessRuntime();` (or prose
 * mentioning it) satisfied the check — verified by mutation: commenting the
 * real call out of `src/cli.ts` passed the raw-text version of this guard.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^[ \t]*\/\/.*$/gmu, "");
}

function isEntrySource(source: string): boolean {
  return stripComments(source).includes(MAIN_GUARD);
}

/** The required wiring calls missing from one entry-point source. */
function wiringViolations(source: string): readonly string[] {
  const code = stripComments(source);
  return REQUIRED_WIRING.filter((token) => !code.includes(token));
}

function listFiles(dir: string, suffix: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [suffix] })) {
    if (file.endsWith(suffix)) acc.push(file);
  }
  return acc;
}

/** Every string leaf in a package.json `exports`/`bin` style value. */
function collectStringLeaves(value: unknown, acc: string[] = []): string[] {
  if (typeof value === "string") acc.push(value);
  else if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStringLeaves(nested, acc);
    }
  }
  return acc;
}

/**
 * Enumerate production entry points FROM THE CODE: main-guarded src modules
 * plus everything package.json exposes as an executable/importable surface.
 */
function discoverEntryFiles(): readonly string[] {
  const entries = new Set<string>();
  for (const file of listFiles(SRC, ".ts")) {
    if (isEntrySource(readFileSync(file, "utf8"))) entries.add(file);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    exports?: unknown;
    bin?: unknown;
    scripts?: Record<string, string>;
  };
  for (const leaf of [...collectStringLeaves(pkg.exports), ...collectStringLeaves(pkg.bin)]) {
    const candidate = resolve(ROOT, leaf);
    if (candidate.endsWith(".ts") && existsSync(candidate)) entries.add(candidate);
  }
  const start = pkg.scripts?.["start"];
  const startModule = start?.match(/node\s+(\S+\.(?:ts|mjs))/u)?.[1];
  if (startModule !== undefined) {
    const candidate = resolve(ROOT, startModule);
    if (existsSync(candidate)) entries.add(candidate);
  }
  return [...entries].toSorted();
}

test("entry discovery is live: it finds the known production mains", () => {
  const entries = discoverEntryFiles().map((file) => relative(ROOT, file));
  assert.ok(entries.includes(join("src", "cli.ts")), `discovery lost src/cli.ts — found: ${entries.join(", ")}`);
  assert.ok(
    entries.includes(join("src", "workflow", "harness-commands.ts")),
    `discovery lost the direct harness-commands main — found: ${entries.join(", ")}`,
  );
  assert.ok(entries.length >= 2, "discovery must enumerate at least the two known mains");
});

test("every production entry point initializes exposure + recording (dynamically discovered, no list)", () => {
  const failures: string[] = [];
  for (const file of discoverEntryFiles()) {
    const missing = wiringViolations(readFileSync(file, "utf8"));
    if (missing.length > 0) {
      failures.push(`${relative(ROOT, file)}: missing ${missing.join(" and ")}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `production entry point(s) run with an empty exposure catalog and no recording boundary — wire initializeHarnessRuntime() and withRecordingContext(...) at the dispatch choke point:\n${failures.join("\n")}`,
  );
});

test("argv-dispatching .mjs utilities stay outside the harness module graph, or must be wired", () => {
  const failures: string[] = [];
  for (const file of listFiles(SRC, ".mjs")) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("process.argv")) continue;
    // A file with no local imports cannot reach the recording machinery (or
    // any harness code), so there is nothing to wire — mechanically verified,
    // not allowlisted. The moment it imports harness modules, it becomes a
    // production entry and must carry the same wiring as the .ts mains.
    const importsLocalModules = /from\s+["']\.{1,2}\//u.test(source);
    if (importsLocalModules && wiringViolations(source).length > 0) {
      failures.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(failures, [], `argv-dispatching .mjs file(s) import harness modules without runtime wiring: ${failures.join(", ")}`);
});

test("MUTATION: removing a wire from an entry source is detected; wired source passes", () => {
  const unwired = [
    "async function main() { return 0; }",
    "if (isEntryPoint(import.meta.url)) {",
    "  process.exitCode = await main();",
    "}",
  ].join("\n");
  assert.ok(isEntrySource(unwired), "the synthetic main must be discovered as an entry");
  assert.deepEqual(wiringViolations(unwired), [...REQUIRED_WIRING], "an unwired main must report BOTH missing wires");

  const halfWired = `${unwired}\ninitializeHarnessRuntime();`;
  assert.deepEqual(wiringViolations(halfWired), ["withRecordingContext("], "a catalog-only main still lacks its recording boundary");

  const wired = `${halfWired}\nwithRecordingContext({ actor }, main);`;
  assert.deepEqual(wiringViolations(wired), [], "a fully wired main must pass");

  // Wiring that only exists in comments is not wiring. This exact bypass was
  // observed live: commenting the real call out of cli.ts passed the raw-text
  // version of this guard.
  const commentedOut = `${unwired}\n// initializeHarnessRuntime();\n/* withRecordingContext({ actor }, main); */`;
  assert.deepEqual(wiringViolations(commentedOut), [...REQUIRED_WIRING], "commented-out wiring must not satisfy the guard");
});

test("initializeHarnessRuntime: idempotent, honest attribution, one sink, nothing recorded twice", () => {
  const stateDir = createTempDir("harness-bootstrap-guard-");
  const ledgerPath = join(stateDir, "state", "timeline.db");
  resetHarnessRuntimeForTesting();
  setEffectSink(undefined);

  const first = initializeHarnessRuntime({ ledgerPath });
  assert.equal(first.performed, true, "first call must perform initialization");
  assert.equal(first.sinkInstalled, true, "first call must install the ledger sink");
  assert.equal(first.sinkAlreadyPresent, false);
  assert.equal(hasEffectSink(), true);

  const catalog = snapshotExposure();
  assert.ok(catalog.signals.length > 0, "exposure catalog must hold signals after initialization");
  assert.ok(catalog.actions.length > 0, "exposure catalog must hold actions after initialization");

  const second = initializeHarnessRuntime({ ledgerPath });
  assert.equal(second.performed, false, "re-initialization must be a no-op");
  assert.equal(second.sinkInstalled, false, "re-initialization must never install a second sink");
  assert.equal(second.sinkAlreadyPresent, true);

  // The registration entry itself is idempotent too: calling it again must
  // not grow (or duplicate) the catalog.
  registerAllExposure();
  const catalogAgain = snapshotExposure();
  assert.equal(catalogAgain.signals.length, catalog.signals.length, "registerAllExposure must not double-register signals");
  assert.equal(catalogAgain.actions.length, catalog.actions.length, "registerAllExposure must not double-register actions");
  assert.equal(catalogAgain.customizations.length, catalog.customizations.length, "registerAllExposure must not double-register customizations");

  const boundaryActor = { kind: "test-suite", id: "entrypoint-guard" } as const;
  const value = withRecordingContext({ actor: boundaryActor }, () =>
    recordEffect("tool", "attributed-probe", () => 42),
  );
  assert.equal(value, 42, "the wrapper must return the work's result unchanged");

  // A third initialization between effects: if it ever stacked another sink,
  // the ledger below would hold MORE events than effects performed.
  initializeHarnessRuntime({ ledgerPath });
  withRecordingContext({ actor: boundaryActor }, () => recordEffect("git", "second-probe", () => "ok"));

  // Outside any boundary the record must stay HONESTLY unattributed — never
  // silently attributed to a plausible hardcoded default.
  recordEffect("process", "unattributed-probe", () => 1);

  resetHarnessRuntimeForTesting();

  const store = createTimelineStore({ path: ledgerPath, ledgerId: HARNESS_RUNTIME_LEDGER_ID });
  try {
    const events = store.query({ ledgerId: HARNESS_RUNTIME_LEDGER_ID });
    assert.equal(
      events.length,
      3,
      `three effects must yield exactly three ledger events (a doubled sink doubles them): ${events.map((event) => event.description).join(", ")}`,
    );
    const byDescription = new Map(events.map((event) => [event.description, event]));
    const attributed = byDescription.get("tool:attributed-probe");
    assert.equal(attributed?.eventType, "tool");
    assert.equal(attributed?.actorKind, boundaryActor.kind);
    assert.equal(attributed?.actorId, boundaryActor.id);
    assert.equal(attributed?.outcome, "succeeded");
    // The wrapper's duration measurement must survive into the ledger, under
    // the shared document vocabulary the web bridge also uses.
    const timing = attributed?.documents.find((document) => document.name === TIMELINE_EFFECT_TIMING_DOCUMENT);
    assert.ok(timing !== undefined, "the effect-timing document must be attached to recorded effects");
    assert.ok(
      typeof JSON.parse(timing.contentJson ?? "{}").durationMs === "number",
      "the timing document must carry the measured durationMs",
    );
    assert.equal(byDescription.get("git:second-probe")?.eventType, "git");
    const unattributed = byDescription.get("process:unattributed-probe");
    assert.equal(unattributed?.actorKind, UNATTRIBUTED.kind, "out-of-boundary records must carry the visible unattributed marker");
    assert.equal(unattributed?.actorId, UNATTRIBUTED.id);
  } finally {
    store.close();
  }
});

test("an embedder's pre-installed sink is never clobbered (web-drives-harness path)", () => {
  resetHarnessRuntimeForTesting();
  const seen: EffectRecord[] = [];
  setEffectSink((record) => {
    seen.push(record);
  });
  const stateDir = createTempDir("harness-bootstrap-noclobber-");
  const ledgerPath = join(stateDir, "timeline.db");

  const init = initializeHarnessRuntime({ ledgerPath });
  assert.equal(init.performed, true);
  assert.equal(init.sinkInstalled, false, "initialization must respect the embedder's sink");
  assert.equal(init.sinkAlreadyPresent, true);

  withRecordingContext({ actor: { kind: "test-suite", id: "entrypoint-guard" } }, () =>
    recordEffect("tool", "embedded-probe", () => 1),
  );
  assert.equal(seen.length, 1, "the effect must reach the embedder's sink exactly once");
  assert.equal(existsSync(ledgerPath), false, "no shadow harness ledger may be created behind the embedder's back");

  setEffectSink(undefined);
  resetHarnessRuntimeForTesting();
});

test("bootstrap required receipt reopens exact args and bounded provider documents in one row", async () => {
  const ledgerPath = join(createTempDir("bootstrap-documents-"), "timeline.db");
  resetHarnessRuntimeForTesting();
  setEffectSink(undefined);
  initializeHarnessRuntime({ ledgerPath });
  const contentJson = JSON.stringify({ response: "safe terminal response" });
  const maximumBytes = loadPinnedConfigSnapshot().document.timeline?.maxDocumentBytes ?? DEFAULT_MAXIMUM_DOCUMENT_BYTES;
  const full = JSON.stringify({ output: "界".repeat(Math.ceil(maximumBytes / 3) + 1) });
  const args = { operation: "native", input: ["safe input"] };
  let receipt;
  try {
    receipt = requireRecordedEffect(await recordRequiredEffectAsync("llm", "documents", async () => "done", {
      argsOf: () => args,
      documentsOf: () => [
        { name: "provider-response", contentJson, contentDigest: sha256(contentJson) },
        { name: "provider-large", contentJson: full, contentDigest: sha256(full) },
      ],
    })).receipt;
  } finally { resetHarnessRuntimeForTesting(); }
  const store = createTimelineStore({ path: ledgerPath, ledgerId: HARNESS_RUNTIME_LEDGER_ID });
  try {
    const events = store.query({ ledgerId: HARNESS_RUNTIME_LEDGER_ID });
    assert.equal(events.length, 1);
    const row = store.getEvent(receipt.eventId)!;
    assert.equal(row.eventId, events[0]?.eventId);
    assert.equal(row.chainHash, receipt.chainHash);
    const docs = new Map(row.documents.map((doc) => [doc.name, doc]));
    assert.equal(docs.has(TIMELINE_EFFECT_ARGS_DOCUMENT), true, "bootstrap must persist the actual invocation arguments");
    assert.equal(docs.has("provider-response"), true, "bootstrap must persist supplied provider evidence");
    assert.equal(docs.has("provider-large"), true, "oversize evidence must have an explicit bounded projection");
    assert.deepEqual(JSON.parse(docs.get(TIMELINE_EFFECT_ARGS_DOCUMENT)!.contentJson!), args);
    assert.equal(docs.get("provider-response")?.contentJson, contentJson);
    const large = docs.get("provider-large")!;
    assert.ok(Buffer.byteLength(large.contentJson!, "utf8") <= maximumBytes);
    const envelope = JSON.parse(large.contentJson!);
    assert.equal(envelope.truncated, true);
    assert.equal(full.startsWith(envelope.preview), true, "preview must be an exact UTF-8 prefix");
    assert.equal(envelope.fullPayloadDigest, sha256(full));
    assert.equal(envelope.fullPayloadBytes, Buffer.byteLength(full, "utf8"));
    for (const doc of row.documents) assert.equal(doc.contentDigest, sha256(doc.contentJson!));
  } finally { store.close(); }
});


test("bootstrap paired capability is lazy and reopens exactly one intent plus terminal", async () => {
  const ledgerPath = join(createTempDir("bootstrap-paired-"), "timeline.db");
  resetHarnessRuntimeForTesting();
  setEffectSink(undefined);
  initializeHarnessRuntime({ ledgerPath });
  let factories = 0;
  const factory = () => {
    factories++;
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    try {
      const rows = db.prepare("SELECT record_kind FROM event_log WHERE ledger_id = ? ORDER BY sequence").all(HARNESS_RUNTIME_LEDGER_ID);
      assert.deepEqual(rows.map((row) => row.record_kind), ["intent"]);
    } finally { db.close(); }
    return (async function* () { yield "progress"; })();
  };
  const document = { name: "provider-request", contentJson: "{}", contentDigest: sha256("{}") };
  const options = { name: "paired", intent: { args: { request: "safe" }, documents: [document] }, capture: () => ({ outcome: "succeeded" as const, documents: [document] }) };
  const unstarted = recordProviderStream(factory, options);
  await unstarted.stream.return();
  assert.equal(existsSync(ledgerPath), false);
  const recorded = recordProviderStream(factory, options);
  try {
    assert.equal(existsSync(ledgerPath), false);
    assert.equal((await recorded.stream.next()).value, "progress");
    await recorded.stream.next();
    assert.equal(factories, 1);
  } finally { resetHarnessRuntimeForTesting(); }
  const store = createTimelineStore({ path: ledgerPath, ledgerId: HARNESS_RUNTIME_LEDGER_ID });
  try {
    const rows = store.query({ ledgerId: HARNESS_RUNTIME_LEDGER_ID });
    assert.deepEqual(rows.map((row) => row.recordKind), ["intent", "terminal"]);
    assert.equal(rows[0]?.effectId, rows[1]?.effectId);
    const result = recorded.settlement!;
    assert.equal(result.intent?.status, "recorded");
    assert.equal(result.recording.status, "recorded");
    if (result.intent?.status !== "recorded" || result.recording.status !== "recorded") assert.fail("actual receipts required");
    assert.equal(rows[0]?.eventId, result.intent.receipt.eventId);
    assert.equal(rows[1]?.eventId, result.recording.receipt.eventId);
    for (const row of rows) assert.equal(row.documents.find((doc) => doc.name === document.name)?.contentJson, document.contentJson);
  } finally { store.close(); }
});
