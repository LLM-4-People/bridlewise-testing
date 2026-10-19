/**
 * ONE PERCENT DECODER IN THE ENGINE, CHECKED ON THE SYNTAX TREE.
 *
 * `safePercentDecode` (`src/privacy/data-policy.ts`) is the engine's one
 * percent decoder: it decodes every run of `%XX` escapes that is valid UTF-8
 * and keeps everything else as written (the WHATWG percent-decode). A second
 * `try { decodeURIComponent(x) } catch { return x }` is all-or-nothing — one
 * invalid escape and the whole text comes back undecoded — which is how a
 * URL password written `a%40b%ZZ` was never held in the `a@b%ZZ` spelling a
 * message echoes (verify/a2-correctness §2), and how the concealment grew its
 * own copy again (secret-parts.ts, SEC-e).
 *
 * Refused outside the owner: any REFERENCE to `decodeURIComponent` or
 * `decodeURI` (a call, an alias, a value) in the engine's `src/` and
 * `scripts/`. A mention in a string or a comment (a denylist of global names,
 * a doc sentence) is not a reference. Planted cases prove the rule sees each
 * spelling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";
import { parseSourceModule, walkAst } from "../../src/quality-packs/prevention/ast-helpers.ts";

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OWNER = "src/privacy/data-policy.ts";
const DECODERS: ReadonlySet<string> = new Set(["decodeURIComponent", "decodeURI"]);
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];

/** Every reference to a platform percent decoder in one file (line numbers). */
export function decoderReferences(path: string, source: string): readonly number[] {
  const program = parseSourceModule(path, source, { errorRecovery: true });
  const lines: number[] = [];
  walkAst(program, (node) => {
    if (node.type === "Identifier" && DECODERS.has(String(node.name))) {
      lines.push((node.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 0);
    }
  });
  return lines;
}

test("percent decoder owner: the syntax tree sees every spelling, and not a mention", () => {
  for (const planted of [
    "const x = decodeURIComponent(value);",
    "try { return decodeURIComponent(text); } catch { return text; }",
    "const decode = decodeURIComponent; decode(v);",
    "const y = decodeURI(v);",
    "const z = globalThis.decodeURIComponent(v);",
  ]) {
    assert.ok(decoderReferences("planted.ts", planted).length > 0, planted);
  }
  for (const mention of [
    "const names = [\"decodeURIComponent\", \"encodeURI\"];",
    "// decodeURIComponent(x) is not used here\n/* decodeURI(y) */",
  ]) {
    assert.deepEqual(decoderReferences("mention.ts", mention), [], mention);
  }
});

test("percent decoder owner: nothing in the engine decodes percent-encoding but the one owner", () => {
  const excludeExperiments = experimentExclusion(ENGINE_ROOT);
  const files = [
    ...walk(join(ENGINE_ROOT, "src"), { exts: SOURCE_EXTENSIONS }),
    ...walk(join(ENGINE_ROOT, "scripts"), { exts: SOURCE_EXTENSIONS, exclude: excludeExperiments }),
  ];
  assert.ok(files.length > 300, `the population must be the engine's real source (${files.length})`);
  const offenders: string[] = [];
  let ownerSeen = false;
  for (const file of files) {
    const path = relative(ENGINE_ROOT, file).split("\\").join("/");
    const references = decoderReferences(path, readFileSync(file, "utf8"));
    if (path === OWNER) {
      ownerSeen = references.length > 0;
      continue;
    }
    for (const line of references) offenders.push(`${path}:${line}`);
  }
  assert.ok(ownerSeen, `liveness: the owner ${OWNER} must itself hold the decoder`);
  assert.deepEqual(offenders, [], `use safePercentDecode (${OWNER}) instead of a second percent decoder:\n${offenders.join("\n")}`);
});
