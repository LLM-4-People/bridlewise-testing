#!/usr/bin/env node
/**
 * Public-snapshot secret and privacy gate.
 *
 * Scans tracked files (or the working tree before the first commit) for
 * credential shapes, private-key blocks, database/key artifacts, and internal
 * paths that must never appear in a public repository.
 *
 * Findings print the file, line, and rule. The matched value is never printed.
 * No path is exempt, test trees included: a test assembles a credential at
 * runtime (the catalogue's `signalFixture`, or a split literal), so the tree
 * holds none and push protection never needs a bypass. GitHub
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
 * ── ONE CATALOGUE FOR "IS THIS TEXT A SECRET, OR PRIVATE?" ──
 *
 * The credential shapes and the publication-privacy rules are owned by the
 * engine's catalogue (`engine/src/privacy/secret-signals.ts`): the rows
 * whose `treeScan` is `true`, plus `PUBLICATION_PRIVACY_SIGNALS`. This
 * script used to keep its own content-rule regex list, its own home-path
 * and internal-host list, and a `.gitleaks.toml` was a third copy; they had drifted
 * (no GitHub token but `ghp_`, no installation token at all). A finding names
 * the catalogue row id, never the matched value.
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

// The canonical owner of the secret-file vocabulary. See the module comment:
// the import is the point, not a convenience.
import { isSecretFile } from "../engine/src/privacy/secret-files.ts";
import { publicationPrivacyFindings, treeScannedSignals } from "../engine/src/privacy/secret-signals.ts";
// The licence boundary over the tree (no GPL-licensed bytes committed): the
// same walk asks it about every line, and its reviewed allowlist is the only
// admission.
import { createGplReader, REVIEWED_GPL_TEXT, staleReviewedEntries } from "../engine/scripts/verification/licence-boundary.ts";
// The one line definition (\r\n, a lone \r, \n) for every read: whole, streamed and capped.
import { createLineSplitter, textLines } from "../engine/scripts/verification/text-lines.ts";

const ROOT = resolve(process.cwd());
// At or below this size a file is read in one pass. Above it, it is streamed
// line by line so a large file is not skipped (the old size cap certified a
// 2 MiB tail clean without reading it).
const STREAM_THRESHOLD_BYTES = 2 * 1024 * 1024;
// Above this size the scanner refuses to certify the file instead of reading
// unbounded data: the prefix is scanned and an `unread-tail` finding is
// reported, because "we did not look" must never print "clean".
const MAX_SCAN_BYTES = 64 * 1024 * 1024;

// `String#matchAll` needs a global pattern; the catalogue stays non-global so
// the same entry can be used for a plain `test` elsewhere.
function globalOf(pattern) {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}

const CONTENT_MATCHERS = treeScannedSignals().map((signal) => ({
  id: signal.id,
  detail: signal.description,
  pattern: globalOf(signal.admission),
}));



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

function report(path, line, rule, detail) {
  findings.push({ path, line, rule, detail });
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
function scanJsonDocument(path, text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  // A string spelled with no escape was already covered by the raw line pass;
  // only an ESCAPED string (whose decoded value no raw line contains) needs
  // this decoded pass. Reporting both was a duplicate finding for one path.
  // The literal spellings are read in ONE linear pass over the raw string
  // tokens: searching the whole text once per value (the old `lineOf`, which
  // also split the prefix into lines) was quadratic in a large document (#301).
  const literal = new Set();
  for (const token of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/gu)) {
    if (!token[1].includes("\\")) literal.add(token[1]);
  }
  for (const value of jsonStrings(parsed)) {
    if (literal.has(value)) continue;
    scanText(path, 0, value);
  }
}

/** Paths whose text carried a GPL-licence marker (for the allowlist's staleness check). */
const gplCarriers = new Set();
// One GPL reader per file, in line order (a notice can span lines): a new
// path starts a new reader.
let gplReading = { path: undefined, reader: undefined };

/** Run the path rules and the content rules over one line of text. */
function scanText(path, lineNumber, line) {
  if (gplReading.path !== path) gplReading = { path, reader: createGplReader() };
  for (const marker of gplReading.reader.push(line)) {
    gplCarriers.add(path);
    // No tree is exempt: a test tree may not carry GPL text either.
    if (!REVIEWED_GPL_TEXT.has(path)) report(path, lineNumber, "gpl-licence-text", `GPL-licensed text (${marker.marker}: ${marker.text}); this AGPL tree carries no GPL bytes — fetch it for testing (the corpus) or add a reviewed entry to engine/scripts/verification/licence-boundary.ts`);
  }
  const normalizedLine = normalizePathText(line);
  for (const signal of publicationPrivacyFindings(normalizedLine, "text")) {
    report(path, lineNumber, signal.id, signal.description);
  }
  for (const rule of CONTENT_MATCHERS) {
    rule.pattern.lastIndex = 0;
    for (const _match of line.matchAll(rule.pattern)) {
      report(path, lineNumber, rule.id, rule.detail);
    }
  }
}

/**
 * The rules over a tracked PATH. A credential pasted into a file NAME is
 * published in the same commit as one pasted into its body, so the matchers
 * run over the normalized path too (including every directory component).
 */
function scanPath(path) {
  const normalized = normalizePathText(path.split("\\").join("/"));
  for (const signal of publicationPrivacyFindings(normalized, "text")) {
    report(normalized, 0, signal.id, `${signal.description} in a file path`);
  }
  for (const rule of CONTENT_MATCHERS) {
    rule.pattern.lastIndex = 0;
    for (const _match of normalized.matchAll(rule.pattern)) {
      report(normalized, 0, rule.id, `${rule.detail} in a file path`);
    }
  }
  // A file whose NAME says it holds credentials is a finding even when its
  // content looks ordinary (`isSecretFile` is the engine's single owner).
  if (isSecretFile(normalized)) {
    report(normalized, 0, "forbidden-file", "secret file");
    return;
  }
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  for (const signal of publicationPrivacyFindings(name, "file-name")) {
    report(normalized, 0, "forbidden-file", signal.description);
  }
}

function readFailure(path, err) {
  const detail = err instanceof Error ? err.message : String(err);
  report(path, 0, "unreadable-file", `the scanner could not read this file (${detail}); it is not certified clean`, false);
}

/** A symlink's committed blob IS its target string; scan that, never follow it. */
function scanSymlink(path) {
  let target;
  try {
    target = readlinkSync(path);
  } catch (err) {
    readFailure(path, err);
    return;
  }
  scanText(path, 1, target);
}

/** Scan the first `MAX_SCAN_BYTES` and REFUSE to call the unread tail clean. */
function scanCappedPrefix(path) {
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
  // The one line definition; the line the cap cut is incomplete, so it is not read (the tail is reported unread).
  createLineSplitter().push(text).forEach((line, index) => scanText(path, index + 1, line));
  report(
    path,
    0,
    "unread-tail",
    `file exceeds the ${MAX_SCAN_BYTES}-byte scan cap; the tail was not read and is not certified clean`,
    false,
  );
}

async function scanStreamed(path) {
  const input = createReadStream(path, { encoding: "utf8" });
  // The one line definition, fed chunk by chunk (a CR that ends a chunk waits for the next).
  const splitter = createLineSplitter();
  let lineNumber = 0;
  try {
    for await (const chunk of input) {
      for (const line of splitter.push(chunk)) scanText(path, (lineNumber += 1), line);
    }
    const last = splitter.rest();
    if (last.length > 0) scanText(path, (lineNumber += 1), last);
  } catch (err) {
    readFailure(path, err);
  } finally {
    input.destroy();
  }
}

async function scanRegularFile(path) {
  let size;
  try {
    size = statSync(path).size;
  } catch (err) {
    readFailure(path, err);
    return;
  }
  if (size > MAX_SCAN_BYTES) {
    scanCappedPrefix(path);
    return;
  }
  if (size > STREAM_THRESHOLD_BYTES) {
    await scanStreamed(path);
    return;
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    readFailure(path, err);
    return;
  }
  textLines(text).forEach((line, index) => scanText(path, index + 1, line));
  scanJsonDocument(path, text);
}

for (const path of trackedFiles()) {
  const normalized = normalizePathText(path.split("\\").join("/"));
  scanPath(normalized);

  let stats;
  try {
    stats = lstatSync(path);
  } catch (err) {
    readFailure(normalized, err);
    continue;
  }
  if (stats.isSymbolicLink()) {
    scanSymlink(path);
  } else if (stats.isFile()) {
    await scanRegularFile(path);
  } else {
    report(normalized, 0, "unreadable-file", "not a regular file; it is not certified clean", false);
  }
}

for (const path of staleReviewedEntries(gplCarriers)) {
  report(path, 0, "gpl-allowlist-stale", "a reviewed GPL-text entry whose file carries no GPL-licence text: remove the entry");
}

// The process ends by draining (process.exit can deadlock at shutdown: Node #54918, #351).
if (findings.length === 0) {
  console.log("secret scan: clean");
} else {
  for (const f of findings) {
    const location = f.line > 0 ? `${f.path}:${f.line}` : f.path;
    console.error(`${location}: ${f.rule}: ${f.detail}`);
  }
  console.error(`\nsecret scan: ${findings.length} finding(s)`);
  process.exitCode = 1;
}
