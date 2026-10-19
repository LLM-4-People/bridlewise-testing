/**
 * "IS THE WASM THERE?" IS A QUESTION, NEVER A FAILURE
 * (`src/intelligence/tree-sitter-backend.ts`).
 *
 * wf1b-correctness §1f: the backend probed each candidate wasm directory,
 * and each language's wasm, as a failed best-effort operation when absent.
 * In the repository-map extract workers — processes whose debug system is
 * unconfigured — every such "failure" printed the terminal fallback line:
 * 156 "[debug] diagnostic unavailable" lines per project registration. Driven
 * in a child process with an unconfigured debug system, started from a
 * folder where most candidates are absent, with real languages and one that
 * has no wasm: the backend initializes and stderr is silent. (Only a few real
 * languages: web-tree-sitter 0.22 refuses a 21st grammar in one process —
 * a separate, recorded finding.)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { createTempDir } from "../support/temp-dir.ts";

const BACKEND = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "intelligence", "tree-sitter-backend.ts")).href;

test("an unconfigured process initializes the tree-sitter backend with every candidate and language probed, and prints nothing", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
    `const { initTreeSitterBackend } = await import(${JSON.stringify(BACKEND)});`,
    `const { isLanguageReady } = await import(${JSON.stringify(BACKEND)});`,
    "await initTreeSitterBackend(['javascript', 'python', 'no-such-language']);",
    "process.stdout.write(JSON.stringify([isLanguageReady('javascript'), isLanguageReady('python'), isLanguageReady('no-such-language')]));",
  ].join("\n")], { cwd: createTempDir("tree-sitter-absence-"), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [true, true, false], "the real languages must load, the unknown one must not");
  assert.doesNotMatch(child.stderr, /diagnostic unavailable/u, "an absent candidate or wasm was reported as a failure");
});
