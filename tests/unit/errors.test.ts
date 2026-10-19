// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";

import {
  errors,
  errorCount,
  latestError,
  errorsByKind,
  pushError,
  dismissError,
  clearErrors,
  appendError,
  MAX_ERROR_ENTRIES,
  ERROR_KINDS,
  type ErrorKind,
} from "../../src/state/errors";

describe("errors store", () => {
  beforeEach(() => clearErrors());

  test("pushError adds an entry and returns its id", () => {
    const id = pushError("stream", "stream_closed", "SSE closed");
    const list = errors.get();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(id);
    expect(list[0]!.kind).toBe("stream");
    expect(list[0]!.code).toBe("stream_closed");
    expect(list[0]!.message).toBe("SSE closed");
    expect(errorCount.get()).toBe(1);
  });

  test("latestError reflects the most recent entry", () => {
    pushError("network", "net1", "first");
    pushError("timeout", "timeout1", "second");
    expect(latestError.get()?.code).toBe("timeout1");
  });

  test("latestError is null when empty", () => {
    expect(latestError.get()).toBeNull();
  });

  test("dismissError removes the entry by id", () => {
    const id = pushError("parse", "bad_json", "oops");
    dismissError(id);
    expect(errors.get()).toHaveLength(0);
  });

  test("dismissError on a non-existent id is a no-op", () => {
    pushError("parse", "bad_json", "oops");
    dismissError("nonexistent");
    expect(errors.get()).toHaveLength(1);
  });

  test("clearErrors empties the store", () => {
    pushError("network", "net1", "a");
    pushError("timeout", "t1", "b");
    clearErrors();
    expect(errors.get()).toHaveLength(0);
    expect(errorCount.get()).toBe(0);
  });

  test("entries are capped at MAX_ERROR_ENTRIES (oldest dropped)", () => {
    for (let i = 0; i < MAX_ERROR_ENTRIES + 5; i++) {
      pushError("network", `code_${i}`, `msg_${i}`);
    }
    const list = errors.get();
    expect(list).toHaveLength(MAX_ERROR_ENTRIES);
    // The oldest 5 should be gone; the first remaining should be code_5.
    expect(list[0]!.code).toBe("code_5");
    // The latest should be the last pushed.
    expect(list[list.length - 1]!.code).toBe(`code_${MAX_ERROR_ENTRIES + 4}`);
  });

  test("ids are unique", () => {
    const a = pushError("network", "c1", "m1");
    const b = pushError("network", "c2", "m2");
    expect(a).not.toBe(b);
  });

  test("statusCode is optional", () => {
    pushError("http", "http_500", "server error", 500);
    pushError("network", "net_err", "offline");
    const list = errors.get();
    expect(list[0]!.statusCode).toBe(500);
    expect(list[1]!.statusCode).toBeUndefined();
  });

  test("appendError wrapper uses kind-first arg order with optional code", () => {
    const id = appendError("parse", "bad JSON", "bad_json");
    const entry = errors.get()[0]!;
    expect(entry.id).toBe(id);
    expect(entry.kind).toBe("parse");
    expect(entry.code).toBe("bad_json");
    expect(entry.message).toBe("bad JSON");
  });

  test("appendError defaults code to unknown_<kind> when omitted", () => {
    appendError("stream", "stream closed");
    const entry = errors.get()[0]!;
    expect(entry.code).toBe("unknown_stream");
  });

  test("errorsByKind groups entries by kind", () => {
    pushError("stream", "s1", "a");
    pushError("stream", "s2", "b");
    pushError("parse", "p1", "c");
    const grouped = errorsByKind.get();
    expect(grouped.stream).toHaveLength(2);
    expect(grouped.parse).toHaveLength(1);
    expect(grouped.network).toHaveLength(0);
  });

  test("all ErrorKind values are present in errorsByKind grouping", () => {
    const grouped = errorsByKind.get();
    // TWO INSTRUMENTS, NEITHER OF THEM THIS TEST.
    //
    // `ERROR_KINDS` is the vocabulary the `ErrorKind` type is derived from;
    // `Object.keys(grouped)` is what the store actually built, from an object
    // the compiler types `Record<ErrorKind, …>` and therefore cannot leave
    // partial. Comparing them asserts the ANSWER rather than the declaration
    // — the compiler guarantees the shape, and this checks that the shape
    // survived into the value a consumer reads.
    //
    // It used to be a hand-written `const kinds: ErrorKind[] = [...seven...]`
    // under the title "all ErrorKind values". A subset is assignable to
    // `ErrorKind[]`, so an eighth kind would have left this test asserting
    // "all" over seven of eight and passing — the test named the property it
    // could not check. Deriving the list from `grouped` alone would have been
    // worse still: it would compare the grouping against itself.
    const kinds: readonly ErrorKind[] = ERROR_KINDS;
    expect(
      kinds.length,
      "the error-kind vocabulary is empty — a completeness check over nothing agrees with everything",
    ).toBeGreaterThan(0);
    expect(
      Object.keys(grouped).sort(),
      "every declared ErrorKind must be a key of errorsByKind, and errorsByKind must invent none",
    ).toEqual([...kinds].sort());
    for (const k of kinds) {
      expect(grouped[k]).toBeDefined();
      expect(Array.isArray(grouped[k])).toBe(true);
    }
  });
});
