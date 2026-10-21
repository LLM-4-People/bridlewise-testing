import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCANNER = join(ROOT, "scripts/check-secrets.mjs");

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
    assert.match(result.stderr, /provider-token-shape/);
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
    assert.match(result.stderr, /forbidden-path/);
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
    assert.match(result.stderr, /forbidden-path/);
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
    assert.match(result.stderr, /private-key-block/);
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
    assert.match(result.stderr, /provider-token-shape/);
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
      assert.match(result.stderr, /provider-token-shape/);
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
    assert.match(result.stderr, /provider-token-shape/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an EXACT placeholder token is allowlisted without a keyword", () => {
  const dir = makeRepo();
  try {
    writeFileSync(join(dir, "example.md"), "reference: sk-AAAAAAAAAAAAAAAAAAAAAAAA\n");
    execFileSync("git", ["add", "example.md"], { cwd: dir });
    const result = scan(dir);
    assert.equal(result.status, 0, result.stderr);
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

test("a key pasted into .gitleaks.toml fails like a key anywhere else", () => {
  // `.gitleaks.toml` is shipped configuration, not a fixture. It used to be in
  // the fixture allowlist, so a real key there was counted synthetic.
  const dir = repoWith({ ".gitleaks.toml": `regexes = ["sk-${"Z".repeat(24)}"]\n` });
  try {
    const result = scan(dir);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, /provider-token-shape/);
    assert.doesNotMatch(result.stderr, /Z{24}/, "the scanner must not print the candidate value");
    assert.doesNotMatch(result.stdout, /secret scan: clean/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
      assert.match(result.stderr, /private-key-block/);
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
    assert.match(result.stderr, /private-key-block/);
    assert.match(result.stderr, /forbidden-path/);
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
    assert.match(result.stderr, /private-key-block/);
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
    assert.match(result.stderr, /forbidden-path/);
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
      assert.match(result.stderr, /forbidden-path/);
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
      assert.match(result.stderr, /forbidden-path/);
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
    assert.match(result.stderr, /path-content/);
    assert.match(result.stderr, /provider-token shape in a file path/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
