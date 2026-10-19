import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { fixFileBytes, harnessFormat } from "../../src/workflow/format-command.ts";
import { createTempDir } from "../support/temp-dir.ts";

test("format-command: fixFileBytes strips excess trailing newlines", () => {
  const { bytes, fixes } = fixFileBytes(Buffer.from("export const x = 1;\n\n"));
  assert.equal(bytes.toString("utf8"), "export const x = 1;\n");
  assert.equal(fixes.includes("excess-final-newline"), true);
});

test("format-command: fixFileBytes adds a missing final newline", () => {
  const { bytes, fixes } = fixFileBytes(Buffer.from("export const x = 1;"));
  assert.equal(bytes.toString("utf8"), "export const x = 1;\n");
  assert.equal(fixes.includes("missing-final-newline"), true);
});

test("format-command: fixFileBytes strips trailing whitespace from each line", () => {
  const { bytes, fixes } = fixFileBytes(Buffer.from("const a = 1;   \nconst b = 2;\t\n"));
  assert.equal(bytes.toString("utf8"), "const a = 1;\nconst b = 2;\n");
  assert.equal(fixes.includes("trailing-whitespace"), true);
});

test("format-command: fixFileBytes normalizes CRLF to LF", () => {
  const { bytes, fixes } = fixFileBytes(Buffer.from("export const x = 1;\r\n"));
  assert.equal(bytes.toString("utf8"), "export const x = 1;\n");
  assert.equal(fixes.includes("carriage-return"), true);
});

test("format-command: fixFileBytes strips a UTF-8 BOM", () => {
  const { bytes, fixes } = fixFileBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const x = 1;\n")]));
  assert.equal(bytes.toString("utf8"), "export const x = 1;\n");
  assert.equal(fixes.includes("byte-order-mark"), true);
});

test("format-command: fixFileBytes returns no fixes for an already-clean file (idempotent)", () => {
  const { bytes, fixes } = fixFileBytes(Buffer.from("export const x = 1;\n"));
  assert.equal(bytes.toString("utf8"), "export const x = 1;\n");
  assert.equal(fixes.length, 0);
});

test("format-command: fixFileBytes handles multiple issues at once", () => {
  const input = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("const a = 1;   \r\nconst b = 2;\n\n\n")]);
  const { bytes, fixes } = fixFileBytes(input);
  assert.equal(bytes.toString("utf8"), "const a = 1;\nconst b = 2;\n");
  assert.equal(fixes.length >= 3, true, `expected at least 3 fixes, got ${fixes.length}`);
});

test("format-command: harnessFormat writes fixes and is idempotent on a temp tree", () => {
  const tmp = createTempDir("harness-format-test-");
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "a.ts"), "export const a = 1;\n\n");
    writeFileSync(join(tmp, "src", "b.ts"), "export const b = 2;   \n");
    writeFileSync(join(tmp, "src", "c.ts"), "export const c = 3;\n");
    const first = harnessFormat(tmp, { write: true });
    assert.equal(first.scanned, 3);
    assert.equal(first.fixed, 2, "a.ts (excess newline) + b.ts (trailing ws) must be fixed");
    assert.equal(readFileSync(join(tmp, "src", "a.ts"), "utf8"), "export const a = 1;\n");
    assert.equal(readFileSync(join(tmp, "src", "b.ts"), "utf8"), "export const b = 2;\n");
    assert.equal(readFileSync(join(tmp, "src", "c.ts"), "utf8"), "export const c = 3;\n", "clean file must be unchanged");
    const second = harnessFormat(tmp, { write: true });
    assert.equal(second.fixed, 0, "re-run must find nothing to fix (idempotent)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("format-command: harnessFormat --check (write=false) reports without mutating", () => {
  const tmp = createTempDir("harness-format-check-");
  try {
    mkdirSync(join(tmp, "src"), { recursive: true });
    writeFileSync(join(tmp, "src", "a.ts"), "export const a = 1;\n\n");
    const before = readFileSync(join(tmp, "src", "a.ts"), "utf8");
    const result = harnessFormat(tmp, { write: false });
    assert.equal(result.fixed, 1, "must detect the excess newline");
    assert.equal(result.write, false);
    assert.equal(readFileSync(join(tmp, "src", "a.ts"), "utf8"), before, "write=false must NOT mutate the file");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
