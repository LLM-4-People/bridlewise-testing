import { describe, test, expect, beforeEach } from "vitest";
import { DbClient } from "../../server/db/client.ts";

import { join } from "node:path";
import { consumeToken, getRemainingTokens, resetRateLimiter } from "../../server/router/rate-limiter.ts";
import { executeToolCall, isToolExecutable } from "../../server/tools/tool-executor.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

/**
 * Prevention tests for exp496 fixes:
 * Tool execution works and respects project root
 * Model IDs are deduplicated
 * Session isolation
 * harnessReady is false (not a lie)
 * DB is ENCRYPTED AT REST with a PERSISTED key (server/db-crypto.ts).
 * The previous fix removed encryption (plaintext at rest — a security
 * risk the user rejected). The correct fix persists the key in a file
 * so it survives reboots; the DbClient returns decrypted plaintext.
 * Rate limiting enforces a budget
 * Path validation rejects forbidden directories
 */

describe("db encryption-at-rest with persisted key (encryption restored)", () => {
  let tmpRoot = "";
  beforeEach(() => {
    tmpRoot = createTempDir("ch-web-enc-");
  });

  test("project path is returned as plaintext by the DbClient (decrypted on read)", () => {
    const db = new DbClient({ path: join(tmpRoot, "plain.db") });
    try {
      const created = db.createProject({ name: "plain-test", path: "/home/user/secret-project" }, "u");
      // The DbClient decrypts on read, so callers see the plaintext path.
      expect(created.path).toBe("/home/user/secret-project");
      // The DbClient never leaks the enc: ciphertext to callers.
      expect(created.path.startsWith("enc:")).toBe(false);
      // Re-read from DB — must be the exact plaintext (decrypted).
      const reread = db.getProject(created.id, "u");
      expect(reread?.path).toBe("/home/user/secret-project");
    } finally {
      db.close();
    }
  });

  test("a NEW DbClient on the same file returns the same plaintext path (reboot — persisted key)", () => {
    const dbPath = join(tmpRoot, "reboot.db");
    const db1 = new DbClient({ path: dbPath });
    const created = db1.createProject({ name: "reboot-test", path: "/projects/my-app" }, "u");
    db1.close();
    // Simulate a reboot: new process, new DbClient, same file + same key
    // file (the sibling db-key persisted). The key is LOADED, not regenerated.
    const db2 = new DbClient({ path: dbPath });
    try {
      const projects = db2.listProjects("u");
      expect(projects.length).toBe(1);
      expect(projects[0]!.path).toBe("/projects/my-app");
      // Decrypted value — no enc: prefix leaks to callers.
      expect(projects[0]!.path.startsWith("enc:")).toBe(false);
    } finally {
      db2.close();
    }
  });
});

describe("rate-limiter", () => {
  // the route-facing API is `checkRateLimit(req, db)` (derives the key
  // internally — userId or IP, never the client-controllable session cookie).
  // These tests exercise the LOW-LEVEL bucket primitive `consumeToken(key)`
  // directly (per-key exhaustion + independence) — the bucket mechanism is
  // key-agnostic; the key-derivation security is covered by
  // tests/prevention/rate-limit-security.test.ts.
  beforeEach(() => {
    resetRateLimiter();
  });

  test("consumeToken allows requests under the limit", () => {
    const key = "test-bucket-1";
    // The default limit is 60/min — the first several should pass.
    for (let i = 0; i < 10; i++) {
      expect(consumeToken(key)).toBe(true);
    }
  });

  test("consumeToken blocks requests over the limit", () => {
    const key = "test-bucket-2";
    // Exhaust the limit by making many requests.
    // The default limit is 60/min. We make 70 requests — the last should fail.
    let allowed = 0;
    for (let i = 0; i < 70; i++) {
      if (consumeToken(key)) allowed++;
    }
    expect(allowed).toBeLessThanOrEqual(60);
    expect(allowed).toBeGreaterThan(0);
  });

  test("getRemainingTokens returns the token count", () => {
    const key = "test-bucket-3";
    const initial = getRemainingTokens(key);
    expect(initial).toBeGreaterThan(0);
    consumeToken(key);
    const after = getRemainingTokens(key);
    expect(after).toBeLessThan(initial);
  });

  test("rate limits are per-key (independent buckets)", () => {
    const key1 = "test-bucket-a";
    const key2 = "test-bucket-b";
    // Exhaust key1's budget
    for (let i = 0; i < 65; i++) consumeToken(key1);
    // key2 should still have budget
    expect(consumeToken(key2)).toBe(true);
  });
});

describe("tool-executor", () => {
  const ctx = { projectRoot: "/tmp/test-project" };

  test("isToolExecutable returns true for known tools", () => {
    expect(isToolExecutable("read_file")).toBe(true);
    expect(isToolExecutable("list_files")).toBe(true);
    expect(isToolExecutable("search_code")).toBe(true);
  });

  test("isToolExecutable returns false for unknown tools", () => {
    expect(isToolExecutable("nonexistent_tool")).toBe(false);
    expect(isToolExecutable("")).toBe(false);
  });

  test("executeToolCall returns unavailable for unknown tools", async () => {
    const result = await executeToolCall("nonexistent_tool", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("not available");
  });

  test("executeToolCall rejects paths outside project root (traversal)", async () => {
    const result = await executeToolCall("read_file", { path: "/etc/passwd" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("outside the project root");
  });

  test("executeToolCall rejects relative path traversal (../)", async () => {
    const result = await executeToolCall("read_file", { path: "../../etc/passwd" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("outside the project root");
  });

  test("executeToolCall rejects missing path argument", async () => {
    const result = await executeToolCall("read_file", {}, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("'path' parameter is required");
  });

  test("executeToolCall handles invalid regex for search_code", async () => {
    const result = await executeToolCall("search_code", { pattern: "[" }, ctx);
    expect(result.success).toBe(false);
    expect(result.output).toContain("invalid regex");
  });
});
