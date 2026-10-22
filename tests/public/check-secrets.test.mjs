import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNER = join(ROOT, "scripts/check-secrets.mjs");
const { PUBLICATION_PRIVACY_SIGNALS, SECRET_TEXT_SIGNAL_CATALOG, signalFixture } = await import("../../engine/src/privacy/secret-signals.ts");

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "bridlewise-secret-scan-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function scan(dir) {
  return spawnSync(process.execPath, [SCANNER], { cwd: dir, encoding: "utf8" });
}

/** A clean temp repository with `files` (path → content) tracked. */
function repoWith(files) {
  const dir = makeRepo();
  for (const [path, content] of Object.entries(files)) {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  execFileSync("git", ["add", "-A"], { cwd: dir });
  return dir;
}


test("the scanner passes a clean tracked tree", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "README.md"), "# clean\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /secret scan: clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner fails on a provider-shaped key outside a fixture path", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "config.txt"), `api_key = "sk-${"C".repeat(24)}"\n`);
    execFileSync("git", ["add", "config.txt"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /: token-prefix: /);
    assert.doesNotMatch(result.stderr, /C{24}/, "the scanner must not print the candidate value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner fails on an internal absolute path", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "notes.md"), "see /home/private-user/secret\n");
    execFileSync("git", ["add", "notes.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /: home-path: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner fails on a BARE home directory", () => {
  // The old path rule required `/home/<user>/<segment>/`, so a bare
  // `/home/<user>` — the shape a prose citation uses — matched nothing.
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "notes.md"), "the checkout was /home/private-user\n");
    execFileSync("git", ["add", "notes.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /: home-path: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner accepts a DOCUMENTED home placeholder, bare or with a segment", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "README.md"), "run it in /home/example/fresh-floor or /home/example\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /secret scan: clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the scanner fails on a private-key block outside a fixture path", () => {
  // The old hard-count skipped `private-key-block` entirely, so a tracked
  // key header printed a finding and still certified the tree.
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "config.ts"), 'const key = "-----BEGIN OPENSSH PRIVATE KEY-----";\n');
    execFileSync("git", ["add", "config.ts"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /: private-key: /);
    assert.match(result.stderr, /config\.ts:1/);
    assert.doesNotMatch(result.stderr, /BEGIN OPENSSH PRIVATE KEY/, "the header itself must not be printed");
    assert.doesNotMatch(result.stdout, /secret scan: clean/, "a hard finding cannot print the clean line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an EXAMPLE keyword on the line does not allowlist a provider-shaped key", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "config.ts"), `api_key = "sk-${"Z".repeat(24)}" # EXAMPLE\n`);
    execFileSync("git", ["add", "config.ts"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /: token-prefix: /);
    assert.doesNotMatch(result.stderr, /Z{24}/, "the scanner must not print the candidate value");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a key in a SHIPPED source directory is not a fixture", () => {
  for (const shipped of ["engine/src/privacy/shipped.ts", "engine/src/shared/debug/shipped.ts"]) {
    const dir = makeRepo();
    try {
      const file = join(dir, shipped);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `api_key = "sk-${"Q".repeat(24)}"\n`);
      execFileSync("git", ["add", shipped], { cwd: dir });
      const result = scan(dir);
      assert.equal(result.status, 1, `${shipped} must not be allowlisted: ${result.stderr}`);
      assert.match(result.stderr, /: token-prefix: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a key under docs/ is not a fixture", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs/guide.md"), `api_key = "sk-${"R".repeat(24)}"\n`);
    execFileSync("git", ["add", "docs/guide.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /: token-prefix: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a placeholder-looking key outside the fixture trees is a finding like any other", () => {
  // The scanner once excused seven exact "placeholder" spellings anywhere in
  // the tree; a value is never excused for its spelling.
  const dir = repoWith({ "example.md": `reference: sk-${"A".repeat(24)}\n` });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /example\.md:1: token-prefix: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the secret-file vocabulary has ONE owner ────────────────────────────
//
// The scanner used to keep a hand-written copy of the file list, drifted from
// the engine's `isSecretFile`. Each of these formats was certified clean by
// that copy. The scanner now imports the owner, and the test asserts the two
// answers agree AND that the gate fails.
test("every format the canonical owner calls a secret file fails the scan", async () => {
  const { isSecretFile } = await import("../../engine/src/privacy/secret-files.ts");
  const formats = [
    ["src/deploy.ppk", "PuTTY-User-Key-File-2: ssh-rsa\n"],
    ["src/kubeconfig", "users:\n- name: app\n"],
    ["src/terraform.tfvars", 'db_password = "synthetic-value"\n'],
    ["src/.m2/settings.xml", "<settings><servers/></settings>\n"],
    ["src/credentials.json", '{"refresh_token":"synthetic-value"}\n'],
    ["src/secrets.yml", "db:\n  password: synthetic-value\n"],
    ["src/prod.env", "DB_PASSWORD=synthetic-value\n"],
    ["src/.ENV", "DB_PASSWORD=synthetic-value\n"],
    ["src/.htpasswd", "alice:$apr1$abcdefgh$0123456789abcdefghijk\n"],
  ];
  for (const [path, content] of formats) {
    const dir = repoWith({ [path]: content });
    try {
      assert.equal(isSecretFile(path), true, `${path} must be a secret file to the canonical owner`);
      const result = scan(dir);
      assert.equal(result.status, 1, `${path} certified clean:\n${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /forbidden-file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("ENCRYPTED and PGP private-key headers are both private-key blocks", () => {
  const headers = [
    "-----BEGIN ENCRYPTED PRIVATE KEY-----",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  ];
  for (const header of headers) {
    const dir = repoWith({ "src/key.txt": `${header}\nsynthetic-body\n` });
    try {
      const result = scan(dir);
      assert.equal(result.status, 1, `${header} certified clean:\n${result.stdout}`);
      assert.match(result.stderr, /: private-key: /);
      assert.doesNotMatch(result.stderr, /BEGIN [A-Z ]*PRIVATE KEY/, "the header must not be printed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a text blob named .png is scanned by content, not by extension", () => {
  const dir = repoWith({
    "src/blob.png": "-----BEGIN OPENSSH PRIVATE KEY-----\nsee /home/leakuser/.ssh\n",
  });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /: private-key: /);
    assert.match(result.stderr, /: home-path: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a file above the old 2 MiB cap has its tail scanned", () => {
  const content = `${"a".repeat(2 * 1024 * 1024 + 64)}\n-----BEGIN OPENSSH PRIVATE KEY-----\n`;
  const dir = repoWith({ "src/large.txt": content });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /: private-key: /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a symlink is scanned through its committed target string, never followed", () => {
  const dir = makeRepo();
  try {
    mkdirSync(join(dir, "docs"), { recursive: true });
    symlinkSync("/home/leakuser/.ssh/id_ed25519", join(dir, "docs/profile"));
    execFileSync("git", ["add", "docs/profile"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /: home-path: /);
    assert.match(result.stderr, /docs\/profile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dotted account name is not a documented placeholder", () => {
  // `/home/example.` is the placeholder followed by sentence punctuation;
  // `/home/jane.doe` is a real account whose first component is a placeholder.
  for (const line of ["home: /home/jane.doe/work\n", "home: /home/user.name/work\n"]) {
    const dir = repoWith({ "src/notes.md": line });
    try {
      const result = scan(dir);
      assert.equal(result.status, 1, `${line.trim()} certified clean`);
      assert.match(result.stderr, /: home-path: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const placeholder = repoWith({ "src/notes.md": "home: /home/example.\n" });
  try {
    const result = scan(placeholder);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(placeholder, { recursive: true, force: true });
  }
});

test("repeated slashes and JSON slash escapes name the same forbidden path", () => {
  const lines = [
    "checkout: /home//leakuser/work\n",
    '{"home":"\\/home\\/leakuser\\/work"}\n',
    '{"home":"\\u002fhome\\u002fleakuser\\u002fwork"}\n',
  ];
  for (const line of lines) {
    const dir = repoWith({ "src/config.json": line });
    try {
      const result = scan(dir);
      assert.equal(result.status, 1, `${line.trim()} certified clean:\n${result.stdout}`);
      assert.match(result.stderr, /: home-path: /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a credential shape in a tracked file NAME is a path finding", () => {
  const dir = repoWith({ [`src/ghp_${"Q".repeat(24)}.txt`]: "ordinary notes\n" });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /: github-personal-token: GitHub personal access token in a file path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the scanner reads the ONE catalogue ─────────────────────────────────
//
// Every row of `engine/src/privacy/secret-signals.ts` either is applied by the
// scanner (`treeScan: true`) or says why not; each applied row's own
// fixtures, assembled at runtime, are found and reported BY THE ROW ID, in a
// shipped file and in a file name, while every row's negatives pass.
test("every tree-scanned catalogue row is found by its id; the others say why not", () => {
  const scanned = SECRET_TEXT_SIGNAL_CATALOG.filter((signal) => signal.treeScan === true);
  assert.ok(scanned.length >= 12, `only ${String(scanned.length)} rows are tree-scanned`);
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG) {
    if (signal.treeScan !== true) {
      assert.ok(signal.treeScan.reason.length > 20, `${signal.id} skips the tree scan without a reason`);
      continue;
    }
    signal.fixtures.positive.forEach((_parts, index) => {
      const value = signalFixture(signal.id, index);
      const dir = repoWith({ "src/shipped.ts": `const value = ${JSON.stringify(value)};\n` });
      try {
        const result = scan(dir);
        assert.equal(result.status, 1, `${signal.id}[${String(index)}] certified clean:\n${result.stdout}`);
        assert.match(result.stderr, new RegExp(`src/shipped\\.ts:1: ${signal.id}: `, "u"), `${signal.id}[${String(index)}]`);
        assert.ok(!result.stderr.includes(value), `${signal.id}: the scanner printed the value`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  const negatives = SECRET_TEXT_SIGNAL_CATALOG.flatMap((signal) => signal.fixtures.negative);
  const clean = repoWith({ "src/near-misses.ts": `${negatives.map((value) => JSON.stringify(value)).join("\n")}\n` });
  try {
    const result = scan(clean);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
});

test("a 520-character installation token with dots is found by its row id, outside and inside a fixture tree", () => {
  const token = signalFixture("github-installation-token", 0);
  assert.equal(token.length, 520);
  assert.equal(token.split(".").length, 3, "the fixture is a three-part JWT");
  const dir = repoWith({ "docs/run.log": `GITHUB_TOKEN ${token}.\n`, "tests/fixture.txt": `${token}\n` });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /docs\/run\.log:1: github-installation-token: GitHub App installation token/);
    assert.doesNotMatch(result.stderr, /tests\/fixture\.txt/, "a fixture tree is still allowlisted until P0.6 removes it");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each publication-privacy row is reported by its id; database state by file name", () => {
  const planted = {
    "home-path": "see /home/private-user/work\n",
    "internal-git-host": "remote: https://git.localserver.ca/x.git\n",
    "internal-provider-host": "base: https://api.neuralwatt.com/v1\n",
    "internal-scratch-path": "scratch: /tmp/opencode/run\n",
    "local-evidence-state": "state: ~/.local/state/code-harness.fresh-evidence/x\n",
  };
  const textRows = PUBLICATION_PRIVACY_SIGNALS.filter((signal) => signal.appliesTo === "text").map((signal) => signal.id);
  assert.deepEqual(Object.keys(planted).sort(), [...textRows].sort(), "every text privacy row has a planted case");
  for (const [id, line] of Object.entries(planted)) {
    const dir = repoWith({ "src/notes.md": line });
    try {
      const result = scan(dir);
      assert.equal(result.status, 1, `${id} certified clean`);
      assert.match(result.stderr, new RegExp(`src/notes\\.md:1: ${id}: `, "u"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const name of ["data/state.db", "data/app.sqlite", "data/app.sqlite3-wal", "data/.db"]) {
    const dir = repoWith({ [name]: "x\n" });
    try {
      const result = scan(dir);
      assert.equal(result.status, 1, `${name} certified clean`);
      assert.match(result.stderr, /forbidden-file: database state/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const nearMiss = repoWith({ "src/db.ts": "export const db = 1;\n", "docs/sqlite.md": "# SQLite\n" });
  try {
    assert.equal(scan(nearMiss).status, 0);
  } finally {
    rmSync(nearMiss, { recursive: true, force: true });
  }
});

/**
 * THE ROWS THIS CATALOGUE MUST HOLD, pinned by id (github-only §8.2): each is
 * present, applied by the repository scan, and projected to GitHub as the
 * named native secret type or a custom pattern. Deleting or demoting any one
 * of them reds here — the generic checks above iterate whatever rows exist,
 * so they cannot see a row disappear.
 */
const REQUIRED_ROWS = Object.freeze({
  "github-personal-token": { kind: "provider", secretType: "github_personal_access_token" },
  "github-installation-token": { kind: "provider", secretType: "github_app_installation_access_token" },
  "github-oauth-token": { kind: "provider", secretType: "github_oauth_access_token" },
  "github-user-to-server-token": { kind: "custom" },
  "github-refresh-token": { kind: "provider", secretType: "github_refresh_token" },
  "neuralwatt-key": { kind: "custom" },
});

test("every required row is present, scanned over the tree, and projected to GitHub", () => {
  const files = {};
  for (const [id, expected] of Object.entries(REQUIRED_ROWS)) {
    const row = SECRET_TEXT_SIGNAL_CATALOG.find((signal) => signal.id === id);
    assert.ok(row !== undefined, `the catalogue lost the required row ${id}`);
    assert.equal(row.treeScan, true, `${id} is not applied by the repository scan`);
    assert.equal(row.github.kind, expected.kind, `${id} is projected to GitHub as ${String(row.github.kind)}`);
    if (expected.kind === "provider") {
      assert.ok(row.github.secretTypes.includes(expected.secretType), `${id} is not projected to GitHub's ${expected.secretType}`);
    } else {
      assert.ok(new RegExp(row.github.pattern, "u").test(signalFixture(id)), `${id}: the GitHub custom pattern misses the row's fixture`);
    }
    files[`plants/${id}.txt`] = `value = ${signalFixture(id)}\n`;
  }
  const dir = repoWith(files);
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, "the scanner passed a tree planted with every required row");
    for (const id of Object.keys(REQUIRED_ROWS)) {
      assert.match(result.stderr, new RegExp(`plants/${id}\\.txt:1: ${id}: `, "u"), `the tree scan did not report ${id} in its plant`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
