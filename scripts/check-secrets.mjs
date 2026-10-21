#!/usr/bin/env node
/**
 * Public-snapshot secret and privacy gate.
 *
 * Scans tracked files (or the working tree before the first commit) for
 * credential shapes, private-key blocks, database/key artifacts, and internal
 * paths that must never appear in a public repository.
 *
 * Findings print the file, line, and rule. The matched value is never printed.
 * Test fixtures under the allowlisted trees do not fail the gate; GitHub
 * secret scanning remains the independent second gate.
 *
 * ── ONE OWNER FOR "IS THIS A SECRET FILE?" ──
 *
 * The names, extensions and credential-store layouts are owned by the
 * engine's `isSecretFile` (`engine/src/privacy/secret-files.ts`), the same
 * function every model-facing read consults. This script used to keep a
 * hand-written second list, and it had drifted in the direction that matters:
 * `.ppk`, `kubeconfig`, `terraform.tfvars`, `.m2/settings.xml`,
 * `credentials.json`, `secrets.yml`, `prod.env`, `.ENV` and `.htpasswd`
 * certified clean. Node >= 24 strips the types natively, so the scanner
 * imports the owner instead of copying it.
 *
 * ── CONTENT, NOT EXTENSIONS ──
 *
 * A tracked blob is read as bytes and decoded as text whatever its name says:
 * a `.png` that is really a PEM file is scanned, and a NUL byte does not make
 * a file invisible. Files above the in-memory threshold are streamed line by
 * line, so no tail is skipped silently; a blob above the absolute scan cap is
 * reported as an explicit unread-tail finding (never "clean"), and an
 * unreadable path is reported the same way. A symbolic link is not followed:
 * its committed blob is the link target string, and that string is scanned.
 */
import { execFileSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
} from "node:fs";
import { relative, resolve } from "node:path";
import { createInterface } from "node:readline";

// The canonical owner of the secret-file vocabulary. See the module comment:
// the import is the point, not a convenience.
import { isSecretFile } from "../engine/src/privacy/secret-files.ts";

const ROOT = resolve(process.cwd());
// At or below this size a file is read in one pass. Above it, it is streamed
// line by line so a large file is not skipped (the old size cap certified a
// 2 MiB tail clean without reading it).
const STREAM_THRESHOLD_BYTES = 2 * 1024 * 1024;
// Above this size the scanner refuses to certify the file instead of reading
// unbounded data: the prefix is scanned and an `unread-tail` finding is
// reported, because "we did not look" must never print "clean".
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

// Documented placeholders for a user's home directory. The path rule below
// matches `/home/<name>` BARE or followed by a segment, so prose that cites
// the checkout root is covered without naming a real account. A placeholder
// must be a whole segment: a documented name followed by a sentence period is
// still the placeholder; a dotted account (`jane.doe`) or a name merely
// BEGINNING with a placeholder (`example123`) is not.
const HOME_PATH_PLACEHOLDERS = [
  "example", "user", "runner", "bridlewise", "ubuntu", "node", "app",
  "workspace", "demo", "x", "u", "me", "alice", "bob", "jane", "jdoe",
  "username", "test", "foo", "bar", "baz",
];
const HOME_PLACEHOLDER_GUARD = `(?!(?:${HOME_PATH_PLACEHOLDERS.join("|")})(?![A-Za-z0-9_-])(?!\\.[A-Za-z0-9]))`;

const FORBIDDEN_PATH = [
  [new RegExp(`\\/home\\/${HOME_PLACEHOLDER_GUARD}[A-Za-z0-9._-]+`, "u"), "absolute home path"],
  [/git\.localserver\.ca\b/, "internal Git host"],
  [/api\.neuralwatt\.com\b/, "internal provider host"],
  [/\/tmp\/opencode\b/, "internal scratch path"],
  [/\bcode-harness\.fresh-evidence\b/, "local evidence state directory"],
];

// A database or SQLite state file is not a credential file, but it is a local
// data blob that must not be published either. The secret-file vocabulary
// itself comes from the engine owner above.
const DATABASE_STATE = [/(^|\/)\.(db|sqlite|sqlite3)(-|$)/i, "database state"];

const CONTENT_RULES = [
  {
    // Valid PKCS#8 may say ENCRYPTED and a PGP key ends with ` BLOCK`; the
    // engine's own private-key signal already accepts the whole
    // `[A-Z0-9 ]*` vocabulary, and the scanner had drifted narrower.
    id: "private-key-block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/u,
    detail: "private key header",
  },
  {
    id: "provider-token-shape",
    pattern: /\b(?:sk|rk|pk|ghp|github_pat)[_-][A-Za-z0-9_-]{20,}\b/u,
    detail: "provider-token shape",
  },
  {
    id: "aws-access-key-shape",
    pattern: /\bAKIA[0-9A-Z]{16}\b/u,
    detail: "AWS access-key shape",
  },
];

// The ONLY content allowlist is a set of EXACT placeholder values. A keyword
// anywhere on the line ("EXAMPLE", "PLANT", "placeholder") is not evidence
// that a token is synthetic: a real key pasted beside the word that was meant
// to excuse it must still fail.
const PLACEHOLDER_TOKENS = new Set([
  "AKIAIOSFODNN7EXAMPLE",
  "sk-...",
  "sk-AAAAAAAAAAAAAAAAAAAAAAAA",
  "ghp_AAAAAAAAAAAAAAAAAAAAAAAA",
  "sk_abcdefghijklmnopqrstuvwx",
  "ghp_abcdefghijklmnopqrstuvwx",
  "sk-abcdefghijklmnopqrstuvwxyz123456",
]);

// `String#matchAll` needs a global pattern; the catalogue stays non-global so
// the same entry can be used for a plain `test` elsewhere.
const CONTENT_MATCHERS = CONTENT_RULES.map((rule) => ({
  ...rule,
  pattern: new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`),
}));

// Test and benchmark fixtures may plant credentials; shipped source and
// documentation may not. `.gitleaks.toml` is SHIPPED CONFIGURATION, not a
// fixture: a real key pasted there is published like one pasted anywhere
// else. Its legitimate content is covered value-exactly by
// PLACEHOLDER_TOKENS, so it needs no path entry.
const SAFE_FIXTURE_PATHS = [
  /^engine\/test\//,
  /^tests\//,
  /^bench\//,
];

function isSafeFixture(path) {
  return SAFE_FIXTURE_PATHS.some((re) => re.test(path));
}

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter(Boolean);
  } catch {
    return walk(".");
  }
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(relative(ROOT, path));
  }
  return out;
}

/**
 * The spellings one filesystem location can be published under, reduced to
 * one: repeated slashes and `.` segments both name the same place to every
 * consumer of the text. Matching the raw line missed the first.
 *
 * JSON-escaped slashes (`\/`, `\u002f`) are NOT decoded here, because that
 * would rewrite ordinary source code (a regex literal spelling a path) into a
 * path and flag the scanner's own rule table. They are decoded the honest
 * way: a file whose whole content parses as JSON has every string value
 * scanned below, where the escape is already resolved.
 */
function normalizePathText(text) {
  return text
    .replace(/\/{2,}/gu, "/")
    .replace(/\/\.\//gu, "/");
}

const findings = [];

function report(path, line, rule, detail, fixture) {
  findings.push({ path, line, rule, detail, fixture });
}

/** The line a literal spelling appears on, or 0 when the text was escaped. */
function lineOf(text, needle) {
  const index = text.indexOf(needle);
  return index === -1 ? 0 : text.slice(0, index).split("\n").length;
}

/** Every string value in a parsed JSON document, keys included. */
function jsonStrings(value, out = []) {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) jsonStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      jsonStrings(item, out);
    }
  }
  return out;
}

/**
 * Scan the DECODED string values of a JSON document as well as its raw lines.
 * `{"home":"\/home\/leakuser\/work"}` and the `\u002f` spelling name the
 * same path as the plain form, but the raw bytes never look like one.
 */
function scanJsonDocument(path, text, fixture) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  for (const value of jsonStrings(parsed)) {
    // A value that appears literally in the file was already covered by the
    // raw line pass; only an ESCAPED value (which no raw line contains) needs
    // this decoded pass. Reporting both was a duplicate finding for one path.
    if (lineOf(text, value) !== 0) continue;
    scanText(path, 0, value, fixture);
  }
}

/** Run the path rules and the content rules over one line of text. */
function scanText(path, lineNumber, line, fixture) {
  const normalizedLine = normalizePathText(line);
  for (const [re, detail] of FORBIDDEN_PATH) {
    re.lastIndex = 0;
    if (re.test(normalizedLine)) report(path, lineNumber, "forbidden-path", detail, fixture);
  }
  for (const rule of CONTENT_MATCHERS) {
    rule.pattern.lastIndex = 0;
    for (const match of line.matchAll(rule.pattern)) {
      // Value-exact allowlisting: only the placeholder spelling above is
      // synthetic, never a line that happens to contain a keyword.
      if (PLACEHOLDER_TOKENS.has(match[0])) continue;
      report(path, lineNumber, rule.id, rule.detail, fixture);
    }
  }
}

/**
 * The rules over a tracked PATH. A credential pasted into a file NAME is
 * published in the same commit as one pasted into its body, so the matchers
 * run over the normalized path too (including every directory component).
 */
function scanPath(path, fixture) {
  const normalized = normalizePathText(path.split("\\").join("/"));
  for (const [re, detail] of FORBIDDEN_PATH) {
    re.lastIndex = 0;
    if (re.test(normalized)) report(normalized, 0, "forbidden-path", detail, fixture);
  }
  for (const rule of CONTENT_MATCHERS) {
    rule.pattern.lastIndex = 0;
    for (const match of normalized.matchAll(rule.pattern)) {
      if (PLACEHOLDER_TOKENS.has(match[0])) continue;
      report(normalized, 0, "path-content", `${rule.detail} in a file path`, fixture);
    }
  }
  // A file whose NAME says it holds credentials is a finding even when its
  // content looks ordinary (`isSecretFile` is the engine's single owner).
  // Never allowlisted: a fixture path does not make a private key publishable.
  if (isSecretFile(normalized)) {
    report(normalized, 0, "forbidden-file", "secret file", false);
    return;
  }
  if (DATABASE_STATE[0].test(normalized)) {
    report(normalized, 0, "forbidden-file", DATABASE_STATE[1], false);
  }
}

function readFailure(path, err) {
  const detail = err instanceof Error ? err.message : String(err);
  report(path, 0, "unreadable-file", `the scanner could not read this file (${detail}); it is not certified clean`, false);
}

/** A symlink's committed blob IS its target string; scan that, never follow it. */
function scanSymlink(path, fixture) {
  let target;
  try {
    target = readlinkSync(path);
  } catch (err) {
    readFailure(path, err);
    return;
  }
  scanText(path, 1, target, fixture);
}

/** Scan the first `MAX_SCAN_BYTES` and REFUSE to call the unread tail clean. */
function scanCappedPrefix(path, fixture) {
  let text;
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_SCAN_BYTES);
    const read = readSync(fd, buffer, 0, MAX_SCAN_BYTES, 0);
    text = buffer.subarray(0, read).toString("utf8");
  } catch (err) {
    readFailure(path, err);
    return;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const lastNewline = text.lastIndexOf("\n");
  const complete = lastNewline === -1 ? "" : text.slice(0, lastNewline);
  complete.split("\n").forEach((line, index) => scanText(path, index + 1, line, fixture));
  report(
    path,
    0,
    "unread-tail",
    `file exceeds the ${MAX_SCAN_BYTES}-byte scan cap; the tail was not read and is not certified clean`,
    false,
  );
}

async function scanStreamed(path, fixture) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      scanText(path, lineNumber, line, fixture);
    }
  } catch (err) {
    readFailure(path, err);
  } finally {
    input.destroy();
    lines.close();
  }
}

async function scanRegularFile(path, fixture) {
  let size;
  try {
    size = statSync(path).size;
  } catch (err) {
    readFailure(path, err);
    return;
  }
  if (size > MAX_SCAN_BYTES) {
    scanCappedPrefix(path, fixture);
    return;
  }
  if (size > STREAM_THRESHOLD_BYTES) {
    await scanStreamed(path, fixture);
    return;
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    readFailure(path, err);
    return;
  }
  text.split(/\r?\n/u).forEach((line, index) => scanText(path, index + 1, line, fixture));
  scanJsonDocument(path, text, fixture);
}

for (const path of trackedFiles()) {
  const normalized = normalizePathText(path.split("\\").join("/"));
  const fixture = isSafeFixture(normalized);
  scanPath(normalized, fixture);

  let stats;
  try {
    stats = lstatSync(path);
  } catch (err) {
    readFailure(normalized, err);
    continue;
  }
  if (stats.isSymbolicLink()) {
    scanSymlink(path, fixture);
  } else if (stats.isFile()) {
    await scanRegularFile(path, fixture);
  } else {
    report(normalized, 0, "unreadable-file", "not a regular file; it is not certified clean", false);
  }
}

if (findings.length === 0) {
  console.log("secret scan: clean");
  process.exit(0);
}

let hard = 0;
let allowlisted = 0;
for (const f of findings) {
  if (f.fixture && f.rule !== "forbidden-file") {
    allowlisted += 1;
    continue;
  }
  const location = f.line > 0 ? `${f.path}:${f.line}` : f.path;
  console.error(`${location}: ${f.rule}: ${f.detail}`);
  // EVERY non-fixture finding is hard. The `fixture` early-continue above is
  // the only allowlisting decision; a rule may not carve out a second one —
  // that is how a private-key block outside a fixture certified a tree.
  hard += 1;
}

if (hard === 0) {
  console.log(`secret scan: clean (${allowlisted} synthetic fixture reference(s) allowlisted)`);
  process.exit(0);
}

console.error(`\nsecret scan: ${hard} finding(s) outside fixture paths`);
process.exit(1);
