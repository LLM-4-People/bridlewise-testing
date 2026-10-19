// @vitest-environment node
/**
 * Prevention test: the quality snapshot the server computes arrives at the
 * client INTACT.
 *
 * ── The defect ──
 *
 * The server computes a fourteen-field `QualityIndicator` after every run
 * (complexity distribution, clone statistics, type-annotation coverage,
 * file/function/module/LOC counts …) and emits all of it on the `quality`
 * SSE event. The client's handler copied five fields into the shared store
 * and dropped the other nine on the floor. The expensive part — an
 * off-thread awareness pass plus a repository-map build over the whole
 * codebase — ran on every single run and then had most of its result
 * discarded at the very last step, where nothing logged it and nothing
 * could notice.
 *
 * ── What is verified ──
 *
 * The expected field set is DISCOVERED from the server's own
 * `QualityIndicator` declaration, not from a list written here. Add a
 * fifteenth field to the server type and forget the client, and this test
 * fails — which is the only way a "carry everything through" rule stays
 * true a year from now.
 *
 * A. Discovery works (the parse finds a plausible field set).
 * B. Every server-declared field survives the wire into `qualitySnapshot`.
 * C. Absent stays absent: the failure payload (`error`/`message`, no
 *    figures) must not be padded with invented zeroes — a quality report
 *    showing "0 issues" for a run whose quality check FAILED would be
 *    fabricated data.
 *
 * ── Mutation-verified ──
 * Deleting any carried field from the client's `setQualitySnapshot` call
 * makes B FAIL, naming the dropped field. Replacing the conditional
 * spreads with unconditional `?? 0` defaults makes C FAIL.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

import { read, stripCommentsOnly } from "../helpers/source-scan.ts";
import { SSE_EVENT_TYPES } from "../../shared/constants.ts";
import { openRunStream } from "../../src/client";
import { qualitySnapshot, resetQuality } from "../../src/state/quality";

import { modulePath } from "../helpers/module-resolver.ts";
/**
 * Discover the server's quality payload shape from the `QualityIndicator`
 * declaration itself. Returns the top-level field names paired with their
 * declared type text (nested braces are skipped, so only depth-1 fields
 * are returned — which is exactly the wire's top level).
 */
function discoverQualityFields(): { name: string; type: string }[] {
  const src = stripCommentsOnly(read(modulePath("quality-bridge.ts")));
  const start = src.indexOf("export type QualityIndicator");
  if (start === -1) return [];
  const open = src.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (; end < src.length; end += 1) {
    if (src[end] === "{") depth += 1;
    else if (src[end] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const body = src.slice(open + 1, end);
  const fields: { name: string; type: string }[] = [];
  let bufferDepth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "<") bufferDepth += 1;
    if (ch === "}" || ch === ")" || ch === ">") bufferDepth -= 1;
    if (ch === ";" && bufferDepth === 0) {
      const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(current);
      if (m !== null) fields.push({ name: m[1]!, type: m[2]!.trim() });
      current = "";
      continue;
    }
    current += ch;
  }
  return fields;
}

/** A wire value shaped like the declared type, so nothing is dropped for
 * being the wrong kind rather than for being unwired. */
function sampleFor(type: string): unknown {
  if (/\[\]\s*$/.test(type)) return [];
  if (type.startsWith("string")) return "sample";
  if (type.startsWith("number")) return 42;
  if (type.includes("{")) return { sampled: true };
  return null;
}

const originalEventSource = globalThis.EventSource;

type Listener = (e: unknown) => void;

class MockEventSource {
  static lastInstance: MockEventSource | null = null;
  static readonly CLOSED = 2;
  readyState = 1;
  readonly url: string;
  private listeners = new Map<string, Set<Listener>>();
  constructor(url: string) {
    this.url = url;
    MockEventSource.lastInstance = this;
  }
  addEventListener(name: string, handler: Listener): void {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(handler);
  }
  removeEventListener(name: string, handler: Listener): void {
    this.listeners.get(name)?.delete(handler);
  }
  emitFrame(name: string, data: unknown): void {
    for (const h of this.listeners.get(name) ?? []) h({ data: JSON.stringify(data) });
  }
  close(): void {
    this.readyState = MockEventSource.CLOSED;
  }
}

beforeEach(() => {
  MockEventSource.lastInstance = null;
  globalThis.EventSource = MockEventSource as unknown as typeof EventSource;
  resetQuality();
});

afterEach(() => {
  globalThis.EventSource = originalEventSource;
  vi.restoreAllMocks();
});

describe("A. the server's quality shape is discovered, not hardcoded here", () => {
  test("QualityIndicator's fields are parsed from server/quality-bridge.ts", () => {
    const fields = discoverQualityFields();
    expect(
      fields.length,
      "could not parse QualityIndicator — a broken parse would make this guard vacuous",
    ).toBeGreaterThan(8);
    // Anchors: a rename of these would be a deliberate contract change, and
    // their absence means the parse grabbed the wrong block.
    const names = fields.map((f) => f.name);
    expect(names).toContain("overallScore");
    expect(names).toContain("recommendations");
  });
});

describe("B. every field the server sends reaches the shared store", () => {
  test("no field of the quality payload is discarded in transit", () => {
    const fields = discoverQualityFields();
    const payload: Record<string, unknown> = { runId: "run-q" };
    for (const f of fields) payload[f.name] = sampleFor(f.type);

    openRunStream("run-q", {});
    MockEventSource.lastInstance!.emitFrame(SSE_EVENT_TYPES.quality, payload);

    const snap = qualitySnapshot.get();
    expect(snap, "the quality event must populate the shared store").not.toBeNull();
    const dropped = fields.filter((f) => !(f.name in (snap as Record<string, unknown>)));
    expect(
      dropped.map((f) => f.name),
      "the server computes these on every run and the client is throwing them away",
    ).toEqual([]);
  });
});

describe("C. a failed quality check is not padded with invented figures", () => {
  test("the error payload carries no fabricated zeroes for fields the server never sent", () => {
    openRunStream("run-q", {});
    MockEventSource.lastInstance!.emitFrame(SSE_EVENT_TYPES.quality, {
      runId: "run-q",
      error: "quality_unavailable",
      message: "the awareness worker failed",
    });

    const snap = qualitySnapshot.get() as Record<string, unknown> | null;
    expect(snap).not.toBeNull();
    expect(snap!["error"]).toBe("quality_unavailable");
    for (const field of ["complexity", "cloneStats", "typeLevel", "fileCount", "totalLoc"]) {
      expect(
        field in snap!,
        `"${field}" was never sent — reporting a value for it would be fabricated data`,
      ).toBe(false);
    }
  });
});
