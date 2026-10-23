import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNER = join(ROOT, "scripts/check-secrets.mjs");
// Private paths and hosts this file plants are assembled at runtime, so the
// scan of THIS tree (which exempts no path) stays clean.
const HOME = "/ho" + "me/";
const LEAK = `${HOME}leakuser`;
const { readRunCpu } = await import("../../engine/src/shared/run-cpu.ts");
const { REVIEWED_GPL_TEXT, createGplReader, isGplFamily, spdxLicences, staleReviewedEntries } = await import("../../engine/scripts/verification/licence-boundary.ts");
const { PUBLICATION_PRIVACY_SIGNALS, SECRET_TEXT_SIGNAL_CATALOG, createPrivacyMatcher, signalFixture } = await import("../../engine/src/privacy/secret-signals.ts");

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

test("the scanner fails on a provider-shaped key in a plain file", () => {
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
    writeFileSync(join(dir, "notes.md"), `see ${HOME}private-user/secret\n`);
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
    writeFileSync(join(dir, "notes.md"), `the checkout was ${HOME}private-user\n`);
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

test("the scanner fails on a private-key block in shipped source", () => {
  // The old hard-count skipped `private-key-block` entirely, so a tracked
  // key header printed a finding and still certified the tree.
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "config.ts"), ('const key = "--' + '---BEGIN OPENSSH PRIVATE KEY-----";\n'));
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

test("a placeholder-looking key is a finding like any other", () => {
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
    ("--" + "---BEGIN ENCRYPTED PRIVATE KEY-----"),
    ("--" + "---BEGIN PGP PRIVATE KEY BLOCK-----"),
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
    "src/blob.png": ("--" + "---BEGIN OPENSSH PRIVATE KEY-----\nsee " + LEAK + "/.ssh\n"),
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
  const content = `${"a".repeat(2 * 1024 * 1024 + 64)}\n--${""}---BEGIN OPENSSH PRIVATE KEY-----\n`;
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
    symlinkSync(`${LEAK}/.ssh/id_ed25519`, join(dir, "docs/profile"));
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
  // `/home/jane` + `.doe` is a real account whose first component is a placeholder.
  for (const line of [`home: ${HOME}jane.doe/work\n`, `home: ${HOME}user.name/work\n`]) {
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
    `checkout: ${HOME}/leakuser/work\n`,
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

test("a 520-character installation token with dots is found by its row id, in docs and in a test tree", () => {
  const token = signalFixture("github-installation-token", 0);
  assert.equal(token.length, 520);
  assert.equal(token.split(".").length, 3, "the fixture is a three-part JWT");
  const dir = repoWith({ "docs/run.log": `GITHUB_TOKEN ${token}.\n`, "tests/fixture.txt": `${token}\n` });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /docs\/run\.log:1: github-installation-token: GitHub App installation token/);
    assert.match(result.stderr, /tests\/fixture\.txt:1: github-installation-token: /, "no tree is exempt: a test tree is scanned like any other");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each publication-privacy row is reported by its id; database state by file name", () => {
  // A NAME row never spells its name (this repository is public), so it
  // cannot be planted here; the one matcher it runs through is driven with a
  // synthetic row below. The SHAPE rows are planted end to end.
  // THE EXACT SET of privacy rows, ids and pins: removing a row, or changing
  // a name row's digest, reds here (the per-kind checks below iterate whatever
  // rows exist, so they cannot see one disappear).
  assert.deepEqual(PUBLICATION_PRIVACY_SIGNALS.map((signal) => signal.id).sort(),
    ["database-state", "home-path", "internal-git-host", "internal-provider-host", "internal-scratch-path", "local-evidence-state"]);
  const NAME_ROWS = {
    "internal-git-host": { names: "dotted", digests: [{ length: 18, sha256: "64228b8af389331cee6e7dba27c81450a7181c1f719e7a133e37128c6a4309e5" }] },
    "internal-provider-host": { names: "dotted", digests: [{ length: 18, sha256: "c565b621df0b9302f8b7e6881dd58353a803981a9fe69ef0542009f1ad9c76d1" }] },
    "internal-scratch-path": { names: "scratch-path", digests: [{ length: 13, sha256: "736a4cae0826a534c3de9b47542cbe9dd50ec8b8714e1d42aa45f4afc0799c0d" }] },
    "local-evidence-state": { names: "dotted", digests: [{ length: 27, sha256: "3bcb2fbbb43fef9d40e18b6e1858d5ca761166d8710552ae03d89b3ae9e6de8b" }] },
  };
  assert.deepEqual(
    Object.fromEntries(PUBLICATION_PRIVACY_SIGNALS.filter((row) => !("pattern" in row)).map((row) => [row.id, { names: row.names, digests: row.digests }])),
    NAME_ROWS,
  );
  const shapeRows = PUBLICATION_PRIVACY_SIGNALS.filter((signal) => "pattern" in signal).map((signal) => signal.id);
  assert.deepEqual([...shapeRows].sort(), ["database-state", "home-path"],
    "a new pattern row must not spell a protected name: give it `names` and `digests` instead");
  for (const signal of PUBLICATION_PRIVACY_SIGNALS.filter((row) => !("pattern" in row))) {
    assert.ok(signal.digests.length > 0 && signal.digests.every((pin) => /^[0-9a-f]{64}$/u.test(pin.sha256) && Number.isSafeInteger(pin.length) && pin.length > 0),
      `${signal.id} carries no SHA-256 digest with its name's length`);
  }
  const planted = { "home-path": `see ${HOME}private-user/work\n` };
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

// ── NO TREE IS EXEMPT ───────────────────────────────────────────────────
//
// The scanner used to allowlist engine/test/, tests/ and bench/, so a test
// could hold a real-format credential and GitHub's push protection raised an
// alert on every push. Every credential a test needs is now assembled at
// runtime; the planted ones below are found in every test tree, and the
// runtime-assembled spellings (the catalogue fixture, a split literal, a
// template hole, a regex with an empty group) are not credentials in source.
test("a credential literal is a finding in every test tree; runtime-assembled ones are not", () => {
  const token = signalFixture("token-prefix", 0);
  const key = signalFixture("private-key", 0);
  const planted = repoWith({
    "engine/test/privacy/planted.test.ts": `const key = "${token}";\n`,
    "tests/unit/planted.test.ts": `const block = \`${key}\`;\n`,
    "bench/planted.ts": `const literal = /${token}/;\n`,
  });
  try {
    const result = scan(planted);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /engine\/test\/privacy\/planted\.test\.ts:1: token-prefix: /);
    assert.match(result.stderr, /tests\/unit\/planted\.test\.ts:1: private-key: /);
    assert.match(result.stderr, /bench\/planted\.ts:1: token-prefix: /);
  } finally {
    rmSync(planted, { recursive: true, force: true });
  }
  const [head, tail] = [token.slice(0, 2), token.slice(2)];
  const assembled = repoWith({
    "engine/test/privacy/assembled.test.ts": [
      'import { signalFixture } from "../../src/privacy/secret-signals.ts";',
      'const fromCatalogue = signalFixture("token-prefix");',
      `const split = ("${head}" + "${tail}");`,
      `const hole = \`${head}\${""}${tail}\`;`,
      `const pattern = /${head}(?:)${tail}/;`,
    ].join("\n") + "\n",
    "tests/unit/assembled.test.ts": `const value = ["${head}", "${tail}"].join("");\n`,
  });
  try {
    const result = scan(assembled);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(assembled, { recursive: true, force: true });
  }
});

test("a name row matches by digest: whole labels, any case, as a subdomain or a prefix; never inside a label", () => {
  // Synthetic protected names (RFC 2606 `.invalid`), through the same matcher
  // every privacy row runs through.
  const pin = (name) => ({ length: name.length, sha256: createHash("sha256").update(name).digest("hex") });
  const match = createPrivacyMatcher([
    { id: "host", names: "dotted", digests: [pin("probe.internal.invalid")] },
    { id: "other", names: "dotted", digests: [pin("other.example.invalid")] },
    { id: "scratch", names: "scratch-path", digests: [pin("/tmp/probescratch")] },
  ]);
  for (const text of [
    "remote: https://probe.internal.invalid/x.git",
    "base: https://api.probe.internal.invalid/v1",
    "PROBE.Internal.INVALID",
    "probe.internal.invalid.example:443",
    // A long dotted run stays linear (the scanner reads multi-megabyte lines).
    `${"a.".repeat(200_000)}probe.internal.invalid`,
  ]) assert.deepEqual(match(text), ["host"], text.slice(0, 60));
  for (const text of ["xprobe.internal.invalid", "x-probe.internal.invalid", "probe.internal.invalidx", "probe-internal-invalid", "probe.internal", "probe..internal.invalid"]) {
    assert.deepEqual(match(text), [], text);
  }
  // Several name rows in one text, judged in one cut, reported in row order.
  assert.deepEqual(match("other.example.invalid then probe.internal.invalid in /tmp/probescratch/x"), ["host", "other", "scratch"]);
  assert.deepEqual(match("scratch: /tmp/probescratch-2/run"), ["scratch"], "a word boundary ends the directory, as before");
  assert.deepEqual(match("scratch: /tmp/probescratchx"), []);
  assert.deepEqual(match("scratch: /var/tmp/other"), []);
  // The scanner applies every privacy row through this matcher (one door).
  assert.match(readFileSync(SCANNER, "utf8"), /publicationPrivacyFindings\(normalizedLine, "text"\)/u);
});

test("the privacy matcher's CPU work is bounded: one cut per text, only length-matching windows hashed", () => {
  // CPU WORK, never wall time (process.cpuUsage, best of three): the matcher
  // over lines dense with dotted names, against the irreducible cost of cutting
  // the same lines into name runs once. The previous design (each name row
  // re-cut the text and hashed every window) is planted and must break the
  // same budget, so the bound is shown to see the regression it guards.
  const pin = (name) => ({ length: name.length, sha256: createHash("sha256").update(name).digest("hex") });
  const rows = [
    { id: "a", names: "dotted", digests: [pin("probe.internal.invalid")] },
    { id: "b", names: "dotted", digests: [pin("other.host.invalid")] },
    { id: "c", names: "dotted", digests: [pin("state-dir.local-evidence.ex")] },
    { id: "d", names: "scratch-path", digests: [pin("/tmp/probescrat")] },
  ];
  const match = createPrivacyMatcher(rows);
  const lines = Array.from({ length: 20_000 }, (_, index) =>
    `import { x${index} } from "./src/module-${index}.helpers.ts"; // https://docs.example.org/api/v1.2.${index}/index.html a.b.c.d.e.f.g.h /tmp/build${index}`);
  const cpu = (work) => {
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3; round += 1) {
      const start = process.cpuUsage();
      work();
      const used = process.cpuUsage(start);
      best = Math.min(best, used.user + used.system);
    }
    return best;
  };
  const cut = cpu(() => {
    for (const line of lines) for (const run of line.matchAll(/[A-Za-z0-9_.-]+/gu)) void run;
  });
  const BUDGET = 10;
  const matcher = cpu(() => {
    for (const line of lines) match(line);
  });
  assert.ok(matcher <= BUDGET * cut, `the privacy matcher used ${String(matcher)} µs CPU, over ${String(BUDGET)}× the ${String(cut)} µs cut`);
  const perRow = (text) => {
    const found = [];
    for (const row of rows) {
      const candidates = [];
      if (row.names === "scratch-path") {
        for (const hit of text.matchAll(/\/tmp\/\w+/gu)) candidates.push(hit[0]);
      } else {
        for (const hit of text.matchAll(/[A-Za-z0-9_.-]+/gu)) {
          const labels = hit[0].split(".");
          for (let first = 0; first < labels.length - 1; first += 1) {
            for (let last = first + 2; last <= Math.min(labels.length, first + 6); last += 1) candidates.push(labels.slice(first, last).join("."));
          }
        }
      }
      for (const candidate of candidates) {
        const digest = createHash("sha256").update(candidate.toLowerCase()).digest("hex");
        if (row.digests.some((entry) => entry.sha256 === digest)) found.push(row.id);
      }
    }
    return found;
  };
  const planted = cpu(() => {
    for (const line of lines) perRow(line);
  });
  assert.ok(planted > BUDGET * cut, `the planted per-row design (${String(planted)} µs) did not break the budget: the bound sees nothing`);
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

test("a large JSON document costs the scanner about what its raw lines do: no per-value search of the whole text (#301)", () => {
  // CPU WORK of the scanner child (procfs, the engine's one CPU reader), never
  // wall time. The same document is scanned as valid JSON (raw lines plus the
  // decoded-string pass, which any file that parses as JSON gets) and with one
  // leading byte that stops it parsing (raw lines only); the decoded pass used
  // to search the whole document once per string value (`lineOf`, which also
  // split the prefix into lines), which made the JSON scan quadratic.
  const values = Array.from({ length: 8_000 }, (_, index) => ({ id: `entry-${index}`, path: `docs/section-${index}/page.md`, note: `plain value ${index}` }));
  const text = `${JSON.stringify(values, null, 1)}\n`;
  const childCpu = (files) => {
    const dir = repoWith(files);
    try {
      let best = Number.POSITIVE_INFINITY;
      for (let round = 0; round < 2; round += 1) {
        const before = readRunCpu();
        const result = scan(dir);
        const after = readRunCpu();
        assert.equal(result.status, 0, result.stderr);
        assert.ok(before !== null && after !== null, "this host cannot measure child CPU (no procfs)");
        best = Math.min(best, after.childCpuMs - before.childCpuMs);
      }
      return best;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const asText = childCpu({ "data/values.txt": `#${text}` });
  const asJson = childCpu({ "data/values.json": text });
  assert.ok(asJson <= 2.5 * asText, `the JSON scan used ${String(asJson)} ms CPU against ${String(asText)} ms for the same bytes as text`);
});

// ── THE LICENCE BOUNDARY: no GPL-licensed bytes in the tree ────────────────
// The GPL spellings are assembled at runtime, so this file carries none.
const GPL_SPDX = "SPDX-License-" + "Identifier: GPL-2.0-only";
const LGPL_TITLE = "GNU LESSER GENERAL " + "PUBLIC LICENSE";
// The licence's noun, never adjacent to its notice in this source (the scan reads words across lines).
const L_WORD = ["Lic", "ense"].join("");
const GPL_NOTICE = ` * it under the terms of the GNU General Public ${L_WORD} as published by\n * the Free Software Foundation.`;

test("GPL-licensed text is refused in every tree, by its SPDX id, licence title or notice", () => {
  const dir = repoWith({
    "engine/test/fixtures/vendored.c": `/* ${GPL_SPDX} */\nint main(void) { return 0; }\n`,
    "docs/notices/lgpl.txt": `${LGPL_TITLE}\n`,
    "src/lib/notice.ts": `/*\n${GPL_NOTICE}\n */\nexport {};\n`,
    // The canonical LGPL-2.1 notice split across lines, read through the file's one reader.
    "src/lib/split.c": [
      "/*",
      " * This library is free software; you can redistribute it and/or",
      " * modify it under the terms of the GNU Lesser General",
      ` * Public ${L_WORD} as published by the Free Software Foundation.`,
      " */",
    ].join("\n") + "\n",
  });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /engine\/test\/fixtures\/vendored\.c:1: gpl-licence-text: GPL-licensed text \(spdx: GPL-2\.0-only\)/u, "a test tree is not exempt");
    assert.match(result.stderr, /docs\/notices\/lgpl\.txt:1: gpl-licence-text: GPL-licensed text \(title: /u);
    assert.match(result.stderr, /src\/lib\/notice\.ts:2: gpl-licence-text: GPL-licensed text \(notice: /u);
    assert.match(result.stderr, /src\/lib\/split\.c:4: gpl-licence-text: GPL-licensed text \(notice: /u, "a notice split across lines is one notice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the project's own AGPL text and prose naming a GPL licence pass", () => {
  const dir = repoWith({
    "LICENSE": "                    GNU AFFERO GENERAL " + "PUBLIC LICENSE\n under the terms of the GNU Affero General Public License as published by\n",
    "src/own.ts": "// SPDX-License-" + "Identifier: AGPL-3.0-only\nexport {};\n",
    "docs/corpus.md": "git's path.c is GPL-2.0-only, fetched for testing and never vendored.\n",
    "data/manifest.json": "{ \"spdx\": \"GPL-2.0-only\" }\n",
  });
  try {
    const result = scan(dir);
    assert.equal(result.status, 0, result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the reviewed GPL-text allowlist is explicit, and an entry with no GPL text is stale", () => {
  assert.equal(REVIEWED_GPL_TEXT.size, 0, "the tree carries no reviewed GPL text; an entry needs a reason and a review");
  const reviewed = new Map([["vendor/a.c", "reviewed: a reason"], ["vendor/b.c", "reviewed: another"]]);
  assert.deepEqual(staleReviewedEntries(new Set(["vendor/a.c"]), reviewed), ["vendor/b.c"]);
  assert.deepEqual(staleReviewedEntries(new Set(["vendor/a.c", "vendor/b.c"]), reviewed), []);
});

test("real GPL variants are read: split notices, title variants, lower-case and compound SPDX expressions", () => {
  // Every spelling is assembled at runtime (this file carries none).
  const G = "General " + "Public License";
  const SPDX_ID = "SPDX-License-" + "Identifier:";
  const markers = (lines) => {
    const reader = createGplReader();
    return lines.flatMap((line, index) => reader.push(line).map((found) => `${String(index + 1)}:${found.marker}:${found.text}`));
  };
  // (1) The canonical LGPL-2.1 notice, split across four comment lines: one notice, at the line that completes it.
  assert.deepEqual(markers([
    " * This library is free software; you can redistribute it and/or",
    ` * modify it under the terms of the GNU Lesser ${G.split(" ")[0]} ${G.split(" ")[1]}`,
    ` * ${G.split(" ")[2]} as published by the Free Software Foundation; either`,
    " * version 2.1 of the License, or (at your option) any later version.",
  ]), ["3:notice:the GNU General Public License notice"]);
  // (2) Title variants: a heading leader, title case, the version on the same line, and the library form.
  for (const title of [`# GNU ${G.toUpperCase()}`, `GNU ${G}`, `GNU ${G.toUpperCase()} Version 2, June 1991`, `   GNU LIBRARY ${G.toUpperCase()}`, `## GNU Lesser ${G}, version 2.1`]) {
    assert.deepEqual(markers([title]).map((found) => found.split(":")[1]), ["title"], title);
  }
  // (3) Lower-case and compound SPDX expressions.
  for (const [line, ids] of [
    [`// ${SPDX_ID} gpl-2.0-only`, ["gpl-2.0-only"]],
    [`# ${SPDX_ID} MIT AND GPL-2.0-only`, ["GPL-2.0-only"]],
    [`/* ${SPDX_ID} (MIT OR GPL-2.0-or-later) */`, ["GPL-2.0-or-later"]],
    [`${SPDX_ID} GPL-2.0-only WITH Linux-syscall-note`, ["GPL-2.0-only"]],
    [`${SPDX_ID} LGPL-2.1+`, ["LGPL-2.1+"]],
  ]) {
    assert.deepEqual(markers([line]).map((found) => found.split(":").slice(2).join(":")), ids, line);
  }
  // (4) A lower-case notice on one line.
  assert.deepEqual(markers([`it under the terms of the gnu ${G.toLowerCase()} as published by the foundation`]).map((found) => found.split(":")[1]), ["notice"]);
  // (5) The GPL-3.0 notice re-wrapped at 20, 26 and 32 columns: the completing
  // line ("published by the …") carries no trigger word of its own.
  const notice = ["This program is free software: you can redistribute it and/or modify it under the terms of the GNU", G, "as published by the Free Software Foundation, either version 3 of the", L_WORD, "or (at your option) any later version."].join(" ");
  const wrap = (text, columns) => {
    const lines = [];
    let current = "";
    for (const word of text.split(" ")) {
      if (current.length > 0 && current.length + 1 + word.length > columns) { lines.push(current); current = word; } else current = current.length > 0 ? `${current} ${word}` : word;
    }
    return [...lines, current];
  };
  for (const columns of [20, 26, 32]) {
    const found = markers(wrap(notice, columns).map((line) => `# ${line}`));
    assert.deepEqual(found.map((entry) => entry.split(":")[1]), ["notice"], `re-wrapped at ${String(columns)} columns: ${JSON.stringify(found)}`);
  }
  // Near misses: the project's own AGPL, permissive expressions, an exception name, prose.
  for (const line of [
    `${SPDX_ID} AGPL-3.0-only`, `${SPDX_ID} MIT OR Apache-2.0`, `${SPDX_ID} Apache-2.0 WITH LLVM-exception`,
    `GNU AFFERO ${G.toUpperCase()}`, `under the terms of the GNU Affero ${G} as published by`,
    "git's path.c is GPL-2.0-only, fetched for testing", "the GNU project", `see the GNU ${G} for details`,
  ]) {
    assert.deepEqual(markers([line]), [], line);
  }
  assert.deepEqual(spdxLicences("(MIT OR GPL-2.0-only) AND Apache-2.0 WITH LLVM-exception"), ["MIT", "GPL-2.0-only", "Apache-2.0"]);
  assert.equal(isGplFamily("gpl-3.0-or-later"), true);
  assert.equal(isGplFamily("AGPL-3.0-only"), false);
});
