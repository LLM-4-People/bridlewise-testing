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
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, relative, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const MAX_BYTES = 2 * 1024 * 1024;

// Documented placeholders for a user's home directory. The path rule below
// matches `/home/<name>` BARE or followed by a segment, so prose that cites
// the checkout root is covered without naming a real account. A placeholder
// must be a whole segment: `/home/example.` (sentence punctuation) is still
// the documented placeholder; a segment that merely BEGINS with a placeholder
// is not.
const HOME_PATH_PLACEHOLDERS = [
  "example", "user", "runner", "bridlewise", "ubuntu", "node", "app",
  "workspace", "demo", "x", "u", "me", "alice", "bob", "jane", "jdoe",
  "username", "test", "foo", "bar", "baz",
];
const HOME_PLACEHOLDER_GUARD = `(?!(?:${HOME_PATH_PLACEHOLDERS.join("|")})(?![A-Za-z0-9_-]))`;

const FORBIDDEN_PATH = [
  [new RegExp(`\\/home\\/${HOME_PLACEHOLDER_GUARD}[A-Za-z0-9._-]+`, "u"), "absolute home path"],
  [/git\.localserver\.ca\b/, "internal Git host"],
  [/api\.neuralwatt\.com\b/, "internal provider host"],
  [/\/tmp\/opencode\b/, "internal scratch path"],
  [/\bcode-harness\.fresh-evidence\b/, "local evidence state directory"],
];

const FORBIDDEN_FILE = [
  [/(^|\/)\.env($|\.)/, "environment file"],
  [/(^|\/)\.npmrc$/, "npm credentials file"],
  [/(^|\/)\.netrc$/, "netrc credentials file"],
  [/(^|\/)(db-key|id_rsa|id_ed25519)$/, "key material"],
  [/\.(pem|key|p12|pfx)$/i, "key material"],
  [/\.(db|sqlite|sqlite3)(-|$)/i, "database state"],
];

const CONTENT_RULES = [
  {
    id: "private-key-block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    detail: "private key header",
  },
  {
    id: "provider-token-shape",
    pattern: /\b(?:sk|rk|pk|ghp|github_pat)[_-][A-Za-z0-9_-]{20,}\b/,
    detail: "provider-token shape",
  },
  {
    id: "aws-access-key-shape",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
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
// documentation may not. `.gitleaks.toml` is configuration that carries the
// placeholder vocabulary itself.
const SAFE_FIXTURE_PATHS = [
  /^engine\/test\//,
  /^tests\//,
  /^bench\//,
  /^\.gitleaks\.toml$/,
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
    else if (entry.isFile()) out.push(relative(ROOT, path));
  }
  return out;
}

function isText(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) return false;
    const extension = extname(path).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".pdf", ".zip", ".gz"].includes(extension)) return false;
    return true;
  } catch {
    return false;
  }
}

const findings = [];
for (const path of trackedFiles()) {
  const normalized = path.split("\\").join("/");
  for (const [re, detail] of FORBIDDEN_FILE) {
    if (re.test(normalized) && !normalized.endsWith(".env.example")) {
      findings.push({ path: normalized, line: 0, rule: "forbidden-file", detail });
    }
  }
  if (!isText(path)) continue;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    continue;
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const [re, detail] of FORBIDDEN_PATH) {
      if (re.test(line)) findings.push({ path: normalized, line: i + 1, rule: "forbidden-path", detail, fixture: isSafeFixture(normalized) });
    }
    for (const rule of CONTENT_MATCHERS) {
      rule.pattern.lastIndex = 0;
      for (const match of line.matchAll(rule.pattern)) {
        // Value-exact allowlisting: only the placeholder spelling above is
        // synthetic, never a line that happens to contain a keyword.
        if (PLACEHOLDER_TOKENS.has(match[0])) continue;
        findings.push({
          path: normalized,
          line: i + 1,
          rule: rule.id,
          detail: rule.detail,
          fixture: isSafeFixture(normalized),
        });
      }
    }
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
