/**
 * A REPRODUCTION SHIM (`harness flake reproduce --preload`, the FLAKE-REPRO
 * decision) for the Apps page token test: every `randomBytes` answer of the
 * process ends in a byte whose low half is zero, so every hex token it makes
 * ends in "0". It recreates, deterministically, the one draw in sixteen that
 * made the token test's near miss (the real token with its last character
 * replaced by "0") EQUAL to the real token. The page and the test are
 * untouched: only the draw is fixed.
 *
 * Preloaded into every test file's process of a reproduction run (`node
 * --test --import`); never imported by a test.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const crypto = require("node:crypto") as { randomBytes: (size: number) => Buffer };
const draw = crypto.randomBytes;

crypto.randomBytes = function endsInZero(size: number): Buffer {
  const bytes = draw(size);
  if (bytes.length > 0) bytes[bytes.length - 1] = bytes[bytes.length - 1]! & 0xf0;
  return bytes;
};
syncBuiltinESMExports();
