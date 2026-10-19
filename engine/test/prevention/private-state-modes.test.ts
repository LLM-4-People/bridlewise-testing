/**
 * GUARD SUBJECT: harness state directories are created private by ONE creator, and the private modes are spelled only by the root policy
 * GUARD OWNS: src/filesystem/private-state.ts (ensurePrivateStateDirectory, the two mode exports) and every engine source that would otherwise spell 0o700/0o600
 * GUARD PLANT: create a state directory with `mkdirSync(dir, { recursive: true, mode: 0o700 })`, or give the generic atomic writer a directory mode
 * GUARD DRIVEN: the creator under umask 002 on a fresh chain; the atomic writer's directories stay at the umask mode (atomic-write.test.ts)
 * GUARD LIVENESS: the literal scan flags a planted 0o700 before the universe is judged, and the universe holds the policy owner
 *
 * THE CLASS. The immutable receipt owner refuses a parent chain that is not
 * private (`receipt_parent_unsafe`). On a fresh checkout the first writer to
 * create `.bridlewise/state/...` decided the whole chain's mode, and seven
 * writers each created their own — some at the umask default. A1's fix made
 * the GENERIC atomic writer create 0700 directories, which also made every
 * directory the editor creates inside a user's project private. The rule now:
 * state creators call `ensurePrivateStateDirectory`; the modes come from
 * `ROOT_POLICY.filesystemInfrastructure.privateState`, and no other engine
 * source spells them.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { ensurePrivateStateDirectory, PRIVATE_STATE_DIRECTORY_MODE } from "../../src/filesystem/private-state.ts";
import { sourceViewOf } from "../../scripts/verification/source-view.ts";
import { walk } from "../../scripts/verification/source-walk.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const POLICY_OWNER = "src/kernel/root-policy.ts";
const PRIVATE_MODE_LITERAL = /(?<![\w$.])0o[67]00(?![\w$])/u;

export function privateModeLiterals(path: string, text: string): readonly string[] {
  return sourceViewOf(text, path).code().split("\n").flatMap((line, index) =>
    PRIVATE_MODE_LITERAL.test(line) ? [`${path}:${index + 1}: ${line.trim()}`] : []);
}

test("private state: the creator makes the whole missing chain private under a permissive umask", () => {
  const root = createTempDir("private-state-");
  const previousUmask = process.umask(0o002);
  try {
    mkdirSync(join(root, "existing"), { mode: 0o755 });
    const created = ensurePrivateStateDirectory(join(root, "existing", "state", "test-results"));
    assert.equal(created, join(root, "existing", "state", "test-results"));
    assert.equal(statSync(join(root, "existing", "state")).mode & 0o7777, PRIVATE_STATE_DIRECTORY_MODE);
    assert.equal(statSync(created).mode & 0o7777, PRIVATE_STATE_DIRECTORY_MODE);
    assert.equal(statSync(join(root, "existing")).mode & 0o7777, 0o755, "an existing directory is never re-permissioned");
  } finally {
    process.umask(previousUmask);
  }
});

test("private state: the literal scan sees a planted mode and ignores prose", () => {
  assert.equal(privateModeLiterals("planted.ts", "mkdirSync(dir, { recursive: true, mode: 0o700 });\n").length, 1);
  assert.equal(privateModeLiterals("planted.ts", "writeFileSync(p, b, { mode: 0o600 });\n").length, 1);
  assert.equal(privateModeLiterals("planted.ts", "// the 0o700 mode is owned by the policy\nconst x = \"0o600\";\n").length, 0);
});

test("private state: no engine source outside the root policy spells a private mode", () => {
  const files = ["src", "scripts"].flatMap((root) => walk(join(ENGINE_ROOT, root), { exts: [".ts", ".mts", ".mjs"] }));
  const paths = files.map((file) => relative(ENGINE_ROOT, file).split("\\").join("/"));
  assert.ok(paths.includes(POLICY_OWNER), "the scan no longer reaches the policy owner");
  const hits = files.flatMap((file, index) =>
    paths[index] === POLICY_OWNER ? [] : privateModeLiterals(paths[index]!, readFileSync(file, "utf8")));
  assert.deepEqual(hits, [], "take the mode from src/filesystem/private-state.ts (ROOT_POLICY), never spell it");
});
