/**
 * Prevention: the timeline records what it measured, and reads all of it back.
 *
 * Each test here corresponds to a place where a measured fact existed and was
 * dropped one step before it could be used. They are source-level guards
 * because the seams are wiring — a sink callback, a route boundary, a build
 * configuration — and wiring is exactly what unit tests of the surrounding
 * functions do not cover.
 *
 * The tsconfig test uses DYNAMIC DISCOVERY: it reads the alias table rather
 * than naming aliases, so a new `@harness/*` alias is covered the moment it is
 * added.
 */

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// The shared source-scan owner: reading a repo file and stripping comments are
// solved once for every prevention test, not re-solved here.
import { read, stripCommentsOnly } from "../helpers/source-scan";
import { bodyBinds, functionArgumentsOf, functionBody } from "../helpers/function-scope.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
/** Vitest runs from the repo root, so `read` takes repo-relative paths. */
const REPO_ROOT = process.cwd();

/**
 * Source with comments removed. A guard that matches a word in a COMMENT
 * passes while the code does the wrong thing — verified by mutation: deleting
 * the `errorOf` argument left the word in its own explanatory comment and the
 * guard stayed green.
 */
function readCode(relPath: string): string {
  return stripCommentsOnly(read(relPath));
}

/** The effect-sink callback body in the timeline bridge. */
function effectSinkBody(): string {
  const source = read(modulePath("timeline-bridge.ts"));
  const start = source.indexOf("setEffectSink(");
  expect(start, "setEffectSink is no longer installed in timeline-bridge").toBeGreaterThan(-1);
  return source.slice(start);
}

function effectDocumentsBody(): string {
  const sink = effectSinkBody();
  expect(sink).toContain("createTimelineEffectSink(");
  expect(readCode(modulePath("effect-sink.ts"))).toContain("projectEffectDocuments(");
  expect(sink).toContain("maxDocumentBytes");
  expect(readCode(modulePath("canonical.ts"))).toContain("timelineEffectSink");
  return readCode(modulePath("effect-documents.ts"));
}

describe("effect sink carries every measured field", () => {
  // The wrapper measures seven things about an effect. The sink was
  // forwarding three and dropping the rest, which is not a downstream loss —
  // the dropped ones are never written anywhere at all.
  it("forwards the failure detail as ONE nested error value", () => {
    // The shape matters, not just the words: the sink once spread FLAT
    // `errorCategory`/`errorCode`/... fields that `recordEvent`'s input type
    // does not have — the conditional-spread bypassed excess-property
    // checking, the recorder ignored all four, and every failed effect landed
    // with NULL error columns while this guard (matching the field NAMES)
    // stayed green. `recordEvent` accepts failure detail only as `error:
    // { category, code, message, retryable }`. The behavioural proof that the
    // detail reaches the real ledger lives in effect-kind-recording.test.ts.
    const body = readCode(modulePath("effect-sink.ts"));
    expect(body).toMatch(/error:\s*\{/);
    expect(body).toMatch(/category:/);
    expect(body).toMatch(/code:/);
    expect(body).toMatch(/message:/);
    expect(body).toMatch(/retryable:/);
    expect(body).toMatch(/record\.error|const error = record\.error/);
  });

  it("forwards the measured duration", () => {
    const body = effectDocumentsBody();
    expect(body).toContain("record.durationMs");
    expect(body).toContain("TIMELINE_EFFECT_TIMING_DOCUMENT");
  });

  it("forwards the measured resource deltas into the ONE timing document, behind the config gate", () => {
    // The wrapper measures what the work COST the process (CPU + heap) beside
    // its duration. The sink must fold those readings into the SAME timing
    // document (a second timing document would be a second vocabulary for one
    // fact), and the gate it honours is the config contract's
    // `performance.resourceDeltas.enabled` — read through the config accessor
    // owner, never restated here.
    const body = effectDocumentsBody();
    expect(body).toContain("record.cpuMs");
    expect(body).toContain("record.heapDeltaBytes");
    expect(effectSinkBody()).toContain("performanceResourceDeltasEnabled");
  });

  it("writes the effect's redacted arguments as their own document under the shared name", () => {
    // The args document is a SECOND document on the same event, named by the
    // shared constant so a reader can find it without guessing the literal.
    const body = effectDocumentsBody();
    expect(body).toContain("TIMELINE_EFFECT_ARGS_DOCUMENT");
    expect(body).toContain("record.args");
    expect(read("shared/constants.ts")).toContain(
      "export const TIMELINE_EFFECT_ARGS_DOCUMENT",
    );
  });

  it("bounds every document it writes through the same fitting path", () => {
    // The timing document, the args document and the effect's own captures
    // all pass through `boundEffectDocument` — a document that skipped the
    // fitting would be the one the store refuses, losing the WHOLE event.
    const body = effectDocumentsBody();
    expect(body).toMatch(/documents\.map\(\(document\) => boundEffectDocument\(document, maximumBytes\)\)/);
  });

  it("names an unmapped effect kind at runtime instead of silently re-routing it", () => {
    // THE DISPLAY FLOOR IS WHAT MAKES AN UNMAPPED KIND SILENT: an effect kind
    // with no entry in the ONE mapping table lands in the `resource` lane — a
    // category nobody is looking at — with no signal that it was re-routed.
    // The choke-point guard reds at CI for a PRODUCED kind with no entry;
    // this runtime witness covers everything that slips past the scan (a
    // dynamically-built kind, a producer wired without the guard). The sink
    // must (a) consult the shared table, (b) warn through the debug-bridge
    // owner naming the kind — zero-overhead when debug is off, the detail
    // thunk is never evaluated — and (c) keep the floor through the owner's
    // `eventTypeForEffectKind`, never a private `?? "resource"` literal.
    const body = readCode(modulePath("effect-sink.ts"));
    expect(body).toMatch(/EFFECT_KIND_EVENT_TYPES\[record\.kind\]/);
    expect(effectSinkBody()).toMatch(/webWarn\(/);
    expect(body).toMatch(/eventTypeForEffectKind\(record\.kind\)/);
    expect(
      body,
      "the floor must come from the mapping owner, not a literal restated beside the sink",
    ).not.toMatch(/\?\?\s*"resource"/);
  });

  it("seeds the bounded-document fitting from the NAMED envelope constant, not an inline literal", () => {
    // The fitting loop reserves a byte budget for the truncation envelope's
    // own JSON overhead. That seed was an inline `256` — a protocol constant
    // of the wrapper format with no owner and no explanation. It now lives
    // beside the document-format defaults (`TRUNCATION_ENVELOPE_OVERHEAD_BYTES`)
    // and the fitting must consume THAT: an inline literal here is a second
    // source of truth that can drift from the named one.
    const bridge = effectDocumentsBody();
    expect(bridge).toContain("TRUNCATION_ENVELOPE_OVERHEAD_BYTES");
    expect(
      /maxDocumentBytes\s*-\s*\d/.test(bridge),
      "the fitting seed is an inline number again — consume the named constant",
    ).toBe(false);
    expect(read(modulePath("timeline-config.ts"))).toContain(
      "export const TRUNCATION_ENVELOPE_OVERHEAD_BYTES",
    );
  });

  it("writes the duration under the name the timeline reads", () => {
    // Writer and reader are on opposite sides of the client/server boundary;
    // a duplicated literal would produce events whose duration is never found.
    expect(effectDocumentsBody()).toContain(
      'TIMELINE_EFFECT_TIMING_DOCUMENT',
    );
    // (The old horizontal-timeline-layout reader died with the old tree.)
    expect(read("shared/constants.ts")).toContain(
      'export const TIMELINE_EFFECT_TIMING_DOCUMENT',
    );
  });

  it("suppresses each shared sink transition without wrapping the asynchronous work", () => {
    expect(effectSinkBody()).toMatch(/transition:\s*withoutEngineSpans/);
    const source = readCode(modulePath("effect-sink.ts"));
    expect(source).toMatch(/const sink: EffectSink = \(record\) => transition\(/);
    expect(source).toMatch(/begin\(record: EffectIntentRecord\)\s*\{\s*return transition\(/);
    expect(source).toMatch(/return inScope\(\(\) => transition\(/);
    expect(source).toContain("recorder.beginEffect(");
    expect(source).toContain("recorder.endEffect(");
  });});

// (The "never fabricates a duration" class died with the old layout module;
// the server bridge's timing-document pin above is the surviving half.)

describe("the run boundary stamps the run onto the recording context", () => {
  it("enters a recording context carrying the runId", () => {
    // Without this, every effect event lands with run_id NULL and no
    // run/chat/project-scoped view can show a tool call — measured: 404 of 404
    // tool events had no run id.
    const run = runPathSource();
    expect(run).toContain("withRecordingContext");
    expect(run).toMatch(/withRecordingContext\(\s*\{[^}]*runId\s*[,}]/s);
  });

  it("carries the caller's identity rather than replacing it", () => {
    // `withRecordingContext` REPLACES the actor. Passing a default here would
    // overwrite the authenticated user the router already established.
    expect(runPathSource()).toMatch(/actor:\s*currentActor\(\)/);
  });

  it("rides the request's trace id on the EXISTING metadata frame", () => {
    // The client learns the request's trace id from the SSE `metadata` frame
    // — the frame that already exists for out-of-band correlation facts. A
    // PARALLEL frame shape would be a second vocabulary for the same fact;
    // extending the existing one is the whole point. The id is READ from the
    // ambient recording context (the router minted it) — never re-derived,
    // and absence is preserved (no key when there is no context) so a
    // synthesised id can never point at nothing in the ledger.
    //
    // Stripped of comments, and matched on the actual SPREAD — a guard that
    // a comment mentioning "traceId" can satisfy is a guard measuring prose
    // (measured: this exact arm passed while the frame field was deleted,
    // because the mutation's own explanatory comment matched).
    const run = stripCommentsOnly(runPathSource());
    const at = run.indexOf("SSE_EVENT_TYPES.metadata");
    expect(at, "the metadata frame publish moved — re-point this guard").toBeGreaterThan(-1);
    const frame = run.slice(at, run.indexOf("});", at));
    expect(frame).toMatch(/traceId:\s*ambientTraceId/);
    expect(run).toMatch(/currentRecordingContext\s*\(\s*\)\s*\?\.\s*traceId/);
  });
});

describe("the web ledger opens with the CONFIG FILE's timeline limits", () => {
  it("the timeline bridge hands the config section to createTimelineStore", () => {
    // The bridge used to open the store WITHOUT `timelineConfig`, so the web
    // ledger silently ran on the engine's inline 1 MiB / 32-document
    // defaults while `bridlewise.config.json` declared 16 MiB / 1,000,000 —
    // a config the operator set and this bridge never read. The section must
    // come from the config accessor owner and reach the store verbatim (the
    // store owns its defaults for absent fields; none are restated here).
    const bridge = readCode(modulePath("timeline-bridge.ts"));
    expect(bridge).toMatch(/getTimelineConfig\s*\(/);
    const open = bridge.indexOf("createTimelineStore(");
    expect(open, "createTimelineStore moved out of the bridge — re-point this guard").toBeGreaterThan(-1);
    const call = bridge.slice(open, bridge.indexOf("});", open));
    expect(call).toMatch(/timelineConfig\s*:/);
    expect(call).toMatch(/maxDocumentBytes/);
    expect(call).toMatch(/maxDocuments/);
  });
});

describe("a tool failure records why it failed", () => {
  it("the executor supplies the failure detail to the wrapper", () => {
    // `failedWhen` answers WHETHER; without `errorOf` the ledger held
    // outcome="failed" with NULL error columns.
    const executor = readCode(modulePath("tool-executor.ts"));
    expect(executor).toMatch(/failedWhen:/);
    expect(executor).toMatch(/errorOf:/);
  });
});

describe("the timeline query is paginated, not truncated", () => {
  it("the route accepts a cursor", () => {
    // Disambiguated by fragment: an exposure registration also named
    // `timeline.ts` exists now, and the resolver refuses bare-name guessing.
    expect(read(modulePathMatching("server/routes/timeline.ts"))).toMatch(/cursor:\s*z\.string\(\)/);
  });

  it("the client can fetch the next page", () => {
    const client = read(modulePathMatching("src/client.ts"));
    expect(client).toContain("loadMoreTimeline");
    expect(client).toContain("nextCursor");
    expect(client).toContain("appendResults");
  });

  // (The TimelineTab pager probe died with the old tree; the client
  //  cursor semantics below are the surviving half.)

  it("a refresh starts a new walk instead of resuming the old cursor", () => {
    // Bounded by the function's own body rather than by 600 bytes: the file
    // has other cursor-carrying calls, and a window cannot tell which one it
    // matched.
    expect(
      // The BINDING, not the bytes. `cursor: _cursor` is a destructuring
      // rename, and `bodyBinds` reads it from the parser — so the same claim
      // holds however the code is spaced, and a `cursor:` in a neighbouring
      // object literal outside this body cannot answer it.
      bodyBinds(functionBody(read(modulePathMatching("src/client.ts")), "refreshTimeline"), "cursor", "_cursor"),
      "a refresh must send the reset cursor, not the one it was holding",
    ).toBe(true);
  });
});

describe("the documented document vocabulary is the shipped one", () => {
  // docs/debugging/README.md restates the ledger's recurring document names
  // in a table. A name restated by hand rots silently: a document added to
  // the wire-literals owner leaves the docs claiming a vocabulary the ledger
  // no longer has, and a name renamed here leaves the docs naming a document
  // nothing writes. The contract is held in BOTH directions against the ONE
  // owner — the names are DERIVED from shared/constants.ts (the wire
  // literals every writer and reader joins on), never listed here.
  const documentedNames = (): Set<string> => {
    const readme = read("docs/debugging/README.md");
    const sectionStart = readme.indexOf("## The ledger's document vocabulary");
    expect(sectionStart, "the README's document-vocabulary section moved — re-point this guard").toBeGreaterThan(-1);
    const section = readme.slice(sectionStart, readme.indexOf("\n## ", sectionStart + 1));
    const names = [...section.matchAll(/^\| `([^`]+)` \|/gmu)].map((m) => m[1]!);
    expect(names.length, "no table rows parsed — the scan is blind, not the docs empty").toBeGreaterThan(0);
    return new Set(names);
  };
  const shippedNames = (): Set<string> => {
    const constants = read("shared/constants.ts");
    const names = [...constants.matchAll(/^export const (TIMELINE_[A-Z_]+_DOCUMENT) = "([^"]+)";/gmu)]
      .map((m) => m[2]!);
    // WITNESS: the derivation really read the owner, and the owner really
    // declares the recurring set (fewer would mean the regex went blind).
    expect(names.length, `only ${names.length} document names parsed from shared/constants.ts`).toBeGreaterThanOrEqual(8);
    return new Set(names);
  };

  it("every shipped document name is documented, and every documented name is shipped", () => {
    const shipped = shippedNames();
    const documented = documentedNames();
    const undocumented = [...shipped].filter((n) => !documented.has(n));
    const unshipped = [...documented].filter((n) => !shipped.has(n));
    expect(
      undocumented,
      `document names the README does not explain: ${undocumented.join(", ")}. A vocabulary\n` +
        `the docs do not describe is undocumented the day it ships — add the row.`,
    ).toEqual([]);
    expect(
      unshipped,
      `README rows naming documents nothing owns: ${unshipped.join(", ")}. A documented name\n` +
        `without a constant is a second source of truth for the wire vocabulary.`,
    ).toEqual([]);
  });
});

describe("both sides of the seam compile against the same harness source", () => {
  it("every @harness alias resolves into the tree the server imports", () => {
    // The client's contracts once resolved `@harness/*` to a DIFFERENT
    // checkout than the one `server/canonical.ts` imports, and the two had
    // already drifted (one had an event type the other lacked; one had a query
    // filter field the other lacked). A shared contract compiled against two
    // sources is not a shared contract.
    const tsconfig = JSON.parse(
      read("tsconfig.json").replace(/^\s*\/\/.*$/gm, ""),
    ) as { compilerOptions: { paths: Record<string, string[]> } };
    const paths = tsconfig.compilerOptions.paths;
    const aliases = Object.keys(paths).filter((a) => a.startsWith("@harness/"));
    expect(aliases.length, "no @harness aliases found — did the table move?").toBeGreaterThan(0);

    const serverImportRoot = (() => {
      // `integration/src` until the monorepo assembly; `engine/src` since.
      const match = /from "((?:\.\.\/)[^"]*engine\/src)\//.exec(read(modulePath("canonical.ts")));
      expect(match, "server/canonical.ts no longer imports from an engine/src tree").not.toBeNull();
      // Resolve against the canonical file's own directory (server/kernel/),
      // not a fixed depth, so the fold cannot silently mis-point the root.
      return resolve(REPO_ROOT, "server", "kernel", match![1]!);
    })();

    for (const alias of aliases) {
      const target = paths[alias]?.[0];
      expect(target, `${alias} has no target`).toBeDefined();
      const resolved = resolve(REPO_ROOT, target!);
      expect(
        resolved.startsWith(serverImportRoot),
        `${alias} → ${target} resolves outside the harness tree the server imports (${serverImportRoot})`,
      ).toBe(true);
      expect(existsSync(resolved), `${alias} → ${target} does not exist`).toBe(true);
    }
  });
});

describe("the safety gate's liveness claim is true", () => {
  // The claim: a per-user tool toggle is honoured DURING a run, not frozen at
  // run start. The callback originally closed over a Map built once per run,
  // so the claim was false while the comment asserted it.
  //
  // The mechanism moved when the data layer went async, and this guard moved
  // with it — carefully, because the shape of the fix is exactly the shape of
  // a regression. `getDefinitions` is called from inside `executeToolCall`,
  // which is synchronous all the way down into the canonical gate, so the
  // callback CANNOT await. It reads a snapshot instead, and the snapshot is
  // refreshed in the async frame immediately before each tool call. That is
  // equivalent ONLY because no `await` runs between the refresh and the
  // check — so that adjacency is what is asserted, not merely the existence
  // of a refresh somewhere.
  it("the gate reads a snapshot rather than a Map captured at run start", () => {
    // THE CALLBACK ITSELF, not 1,200 bytes from the call. This file already
    // converted one window off a pattern and left this one built out of
    // arithmetic sixty-five lines away — which is why the estate scan now reads
    // both universes: deleting the pattern door does not reach a window written
    // as a subtraction.
    const run = runPathSource();
    const [callback] = functionArgumentsOf(run, "createRunSafetyGate", [], "the run path");
    expect(callback, "createRunSafetyGate must be given a callback to scope").toBeDefined();
    expect(
      bodyBinds(callback!, "toolSettingsSnapshot", "active.toolSettingsSnapshot")
        || callback!.body.includes("active.toolSettingsSnapshot"),
      `the gate callback must read the live snapshot, not close over a Map — its body is ${JSON.stringify(callback!.body.slice(0, 200))}`,
    ).toBe(true);
  });

  // ── THE ADJACENCY NOW HAS TWO HALVES, BECAUSE THE EXECUTOR IS ASYNC ──
  //
  // `executeToolCall` returns a promise now (its subprocess spawn moved off
  // the event loop). The liveness claim survives that, but ONLY because of a
  // property of `async function` that is easy to lose and invisible when
  // lost: everything up to the FIRST `await` runs synchronously, in the
  // caller's own frame. So `gate.check` still sees the snapshot the route
  // just wrote — provided nothing awaits before it.
  //
  // That splits the guard in two, and the second half is the one that now
  // carries the guarantee:
  //
  //   (a) in the ROUTE — no yield between the refresh and the call;
  //   (b) in the EXECUTOR — no yield between entry and `gate.check`.
  //
  // (a) alone would pass while (b) was broken, and the route would still read
  // perfectly. That is precisely the shape of a regression that looks live.
  //
  // Both halves strip comments first. A guard that a COMMENT can break is a
  // guard measuring prose, and this one broke exactly that way when the word
  // "await" was written in an explanatory note beside the call.

  /** Source with comments removed — only real code can trip these scans. */
  const codeOf = (rel: string): string =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("(a) the route refreshes the snapshot immediately before the executor, with no await between", () => {
    const run = codeOf(modulePath("run-executor.ts"));
    const refresh = run.lastIndexOf("active.toolSettingsSnapshot = await readToolSettingsSnapshot");
    expect(refresh, "the per-call refresh is gone — the gate now reads a stale snapshot").toBeGreaterThan(-1);
    const exec = run.indexOf("executeToolCall(", refresh);
    expect(exec, "the refresh must precede the executor call it feeds").toBeGreaterThan(refresh);
    // Everything between them, with the refresh's own await removed. Any
    // REMAINING await is a yield point, and a yield point between the read and
    // the check is what makes the snapshot stale — the exact failure the
    // original callback had, reintroduced in a form that still looks live.
    // The executor's OWN `await` is not a yield before the gate: awaiting a
    // call does not delay the callee's synchronous prologue.
    const between = run
      .slice(refresh, exec)
      .replace("await readToolSettingsSnapshot", "")
      .replace(/await\s*$/, "");
    expect(
      /\bawait\b/.test(between),
      "an await between the snapshot refresh and executeToolCall makes the gate's " +
        "value stale again — refresh immediately before the call, or make the " +
        "gate itself async",
    ).toBe(false);
  });

  it("(b) the executor reaches the gate BEFORE its first await", () => {
    const src = codeOf(modulePath("tool-executor.ts"));
    const fnStart = src.indexOf("async function executeToolCallInner");
    expect(
      fnStart,
      "executeToolCallInner is gone or renamed — this guard cannot see the gate any more",
    ).toBeGreaterThan(-1);

    const gate = src.indexOf("ctx.gate.check(", fnStart);
    expect(gate, "the safety gate's check is no longer inside the executor").toBeGreaterThan(fnStart);

    const firstAwait = src.slice(fnStart, gate).search(/\bawait\b/);
    expect(
      firstAwait,
      "an `await` runs BEFORE the safety gate's check. Everything up to an async " +
        "function's first await runs in the caller's frame, which is the ONLY reason " +
        "the route's snapshot refresh is still adjacent to the check. Yield before " +
        "the gate and the snapshot can be replaced by another request in between — " +
        "the gate then reads a value that was live when it was written and is not " +
        "any more, while every line still looks correct.",
    ).toBe(-1);
  });
});

// Fresh native processes exercise the bridge's cached identity and real SQLite
// independently of Vitest's module cache. No provider or application server runs.
const IDENTITY_PROBE = `
import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module'; import {spawnSync} from 'node:child_process';
const sidecar = process.env.IDENTITY_SIDECAR;
// The identity is published by the one exclusive writer: a complete private file LINKED under its name.
const publishing = (target) => String(target).endsWith('/timeline-ledger-id');
let seenIdentity; const read = fs.readFileSync; fs.readFileSync = (path, ...args) => { const value = read(path, ...args); if (String(path) === sidecar) seenIdentity = String(value).trim(); return value; }; syncBuiltinESMExports();
if (process.env.IDENTITY_RACE === 'yes') {
  // A contender runs to completion at the last moment before this opener's publication.
  const link = fs.linkSync; fs.linkSync = (existing, target) => {
    if (publishing(target)) {
      const contender = spawnSync(process.execPath, process.execArgv, {env:{...process.env,IDENTITY_RACE:'no'},encoding:'utf8',timeout:10000});
      console.log('CONTENDER '+JSON.stringify({status:contender.status,stdout:contender.stdout,stderr:contender.stderr}));
    }
    return link(existing, target);
  }; syncBuiltinESMExports();
}
if (process.env.IDENTITY_FAIL_WRITE === 'yes') {
  const link = fs.linkSync; fs.linkSync = (existing, target) => {
    if (publishing(target)) throw Object.assign(new Error('PRIVATE-identity-path'), {code:'EACCES'});
    return link(existing, target);
  }; syncBuiltinESMExports();
}
const {getTimelineStore, getTimelineRecorder} = await import(process.env.IDENTITY_OWNER);
if (process.env.IDENTITY_BARRIER === 'yes') { console.log('READY'); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause(); }
try {
  const store = getTimelineStore();
  if (process.env.IDENTITY_RECORD === 'yes') getTimelineRecorder().recordEvent({eventType:'error', description:'policy', correlation:{runId:'identity-policy-run'},error:{category:'provider',code:'llm_misalignment_policy_violation',message:'review',retryable:false}});
  console.log(JSON.stringify({ledgerId:store.ledgerId,count:store.querySummaries({runIds:['identity-policy-run'],errorCode:'llm_misalignment_policy_violation',limit:1}).length})); store.close();
} catch(error) { console.log(JSON.stringify({code:error.code,message:error.message,seenIdentity})); }
`;
function identityEnv(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, HARNESS_WEB_TIMELINE_DB_PATH: resolve(dir, "timeline.db"), IDENTITY_SIDECAR: resolve(dir, "timeline-ledger-id"),
    IDENTITY_OWNER: pathToFileURL(resolve(modulePath("timeline-bridge.ts"))).href, ...extra };
}
function identityProbe(dir: string, extra: Record<string, string> = {}): { ledgerId?: string; count?: number; code?: string; message?: string } {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", IDENTITY_PROBE], { env: identityEnv(dir, extra), encoding: "utf8", timeout: 20_000 });
  expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!);
}

describe("timeline bridge identity admission across native processes", () => {
  it("retains recorded policy on a legitimate fresh open and process restart", () => {
    const dir = createTempDir("timeline-identity-");
    const first = identityProbe(dir, { IDENTITY_RECORD: "yes" });
    expect(first.ledgerId).toMatch(/^ledger-/); expect(first.count).toBe(1);
    expect(identityProbe(dir)).toEqual(first);
    expect(readFileSync(resolve(dir, "timeline-ledger-id"), "utf8")).toBe(first.ledgerId);
  });
  it.each(["invalid", "partial", "unreadable", "missing", "publication"])("refuses %s identity without creating another ledger", (kind) => {
    const dir = createTempDir("timeline-identity-");
    const sidecar = resolve(dir, "timeline-ledger-id");
    if (kind === "invalid" || kind === "partial") writeFileSync(sidecar, kind === "partial" ? "ledger-134d5379" : "invalid");
    if (kind === "unreadable") mkdirSync(sidecar);
    if (kind === "missing") { identityProbe(dir, { IDENTITY_RECORD: "yes" }); rmSync(sidecar); }
    const result = identityProbe(dir, kind === "publication" ? { IDENTITY_FAIL_WRITE: "yes" } : {});
    expect(result.code).toBe(kind === "invalid" || kind === "partial" ? "timeline_ledger_identity_invalid" : kind === "missing" ? "timeline_ledger_identity_missing" : "timeline_ledger_identity_unavailable");
    expect(result.message).not.toContain("PRIVATE"); expect(result.ledgerId).toBeUndefined();
    if (kind !== "missing") expect(existsSync(resolve(dir, "timeline.db"))).toBe(false);
    if (kind === "missing") expect(existsSync(sidecar)).toBe(false);
  });
  it("a contender that publishes first wins: the late opener adopts its identity, never a prefix and never a second one", () => {
    const dir = createTempDir("timeline-identity-");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", IDENTITY_PROBE], { env: identityEnv(dir, { IDENTITY_RACE: "yes" }), encoding: "utf8", timeout: 20_000 });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    const lines = child.stdout.trim().split("\n"); const contender = JSON.parse(lines.find(line => line.startsWith("CONTENDER "))!.slice(10));
    expect(contender.status, contender.stderr).toBe(0);
    const first = JSON.parse(contender.stdout.trim().split("\n").at(-1)!); expect(first.ledgerId).toMatch(/^ledger-/);
    const late = JSON.parse(lines.at(-1)!); expect(late.ledgerId, "the late opener adopts the published identity").toBe(first.ledgerId);
    expect(readFileSync(resolve(dir, "timeline-ledger-id"), "utf8")).toBe(first.ledgerId); expect(identityProbe(dir).ledgerId).toBe(first.ledgerId);
  });
  it("concurrent first opens never replace the winning identity", async () => {
    const dir = createTempDir("timeline-identity-");
    const children = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", IDENTITY_PROBE], { env: identityEnv(dir, { IDENTITY_BARRIER: "yes" }), stdio: ["pipe", "pipe", "pipe"] });
      const ready = Promise.withResolvers<void>(); let stdout = "", stderr = "";
      child.stdout.on("data", data => { stdout += String(data); if (stdout.includes("READY\n")) ready.resolve(); });
      child.stderr.on("data", data => { stderr += String(data); });
      const exited = new Promise<void>((resolveExit, reject) => { child.once("error", reject); child.once("exit", (code, signal) => { ready.reject(new Error("identity child exited before readiness")); if (code === 0 && signal === null) resolveExit(); else reject(new Error(`identity child ${code}/${signal}: ${stderr}`)); }); });
      void ready.promise.catch(() => {}); void exited.catch(() => {});
      return { child, ready: ready.promise, exited, result: () => JSON.parse(stdout.trim().split("\n").at(-1)!) as {ledgerId?: string; code?: string; seenIdentity?: string} };
    });
    const watchdog = setTimeout(() => { for (const { child } of children) child.kill("SIGKILL"); }, 20_000);
    try {
      await Promise.all(children.map(child => child.ready));
      for (const { child } of children) child.stdin.end("go\n");
      await Promise.all(children.map(child => child.exited));
      const results = children.map(child => child.result());
      const identity = readFileSync(resolve(dir, "timeline-ledger-id"), "utf8");
      expect(results.some(result => result.ledgerId === identity)).toBe(true);
      // Every opener STARTS: the identity is published whole or not at all,
      // an opener that finds the ledger just created re-reads the identity,
      // and WAL establishment and migrations wait for the other opener.
      for (const result of results) expect(result, JSON.stringify(result)).toMatchObject({ ledgerId: identity });
      expect(identityProbe(dir).ledgerId).toBe(identity);
    } finally {
      clearTimeout(watchdog); for (const { child } of children) if (child.exitCode === null) child.kill("SIGKILL");
      await Promise.allSettled(children.map(child => child.exited));
    }
  });
});
