// @vitest-environment node
/**
 * NO RAW NUL BYTE IN A TRACKED TEXT FILE.
 *
 * Seven tracked text files (a findings record, a component comment, a
 * sanitizer comment, four test fixtures) held a literal U+0000 byte. `grep`
 * treats such a file as BINARY and prints "Binary file matches" instead of
 * the line, so every text search, review diff and scanner that decodes line
 * by line silently skipped their contents. A fixture that NEEDS the character
 * spells it as an escape (`\u0000`), which is the same string at runtime.
 * The population is every tracked file the repository owns with a text
 * extension (the one ownership reader), never a list.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { trackedFiles } from "../../engine/src/git/repository-ownership.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const TEXT = /\.(?:md|ts|mts|cts|js|mjs|cjs|svelte|json|css|html|txt|ya?ml|sh|c|h|tsv|csv)$/u;

describe("tracked text files hold no raw NUL byte", () => {
  test("every tracked text file decodes as text", () => {
    const files = (trackedFiles(ROOT) ?? []).filter((path) => TEXT.test(path));
    expect(files.length, "the scan saw no tracked text files").toBeGreaterThan(1000);
    const offending = files.filter((path) => {
      try {
        return readFileSync(join(ROOT, path)).includes(0);
      } catch {
        // A tracked path deleted from the disk (an unstaged deletion) has no bytes to judge.
        return false;
      }
    });
    expect(offending, "spell the character as an escape (\\u0000) instead of a raw byte").toEqual([]);
  });
});
