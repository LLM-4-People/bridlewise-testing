import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
