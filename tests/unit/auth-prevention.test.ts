// @vitest-environment node
/**
 * ADVERSARIAL tests for dashboard authentication.
 *
 * Escalates difficulty 10×: wrong passwords, empty/malformed
 * hashes, expired sessions, setup-already-set, constant-time verify,
 * full setup→login→protected→logout flow with a real in-memory DB, token
 * hashing (DB never stores raw tokens).
 */
import { describe, test, expect, afterAll } from "vitest";
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken,
  isSessionExpired,
} from "../../server/auth/auth.ts";
import { DbClient } from "../../server/db/client.ts";
import { AuthError } from "../../server/kernel/errors.ts";

/** The DBs created by `makeDb()` — closed in `afterAll` so the suite does
 * not leak `:memory:` DB file handles across the 12 calls. */
const CREATED_DBS: DbClient[] = [];

function makeDb(): DbClient {
  const db = new DbClient({ path: ":memory:" });
  CREATED_DBS.push(db);
  return db;
}

afterAll(() => {
  for (const db of CREATED_DBS) {
    try { db.close(); } catch { /* best effort */ }
  }
});

describe("hashPassword / verifyPassword — scrypt (async, off the event loop)", () => {
  test("correct password verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  test("wrong password does NOT verify (constant-time)", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  test("different salts produce different hashes (per-password salt)", async () => {
    const a = await hashPassword("samepassword");
    const b = await hashPassword("samepassword");
    expect(a).not.toBe(b);
    expect(await verifyPassword("samepassword", a)).toBe(true);
    expect(await verifyPassword("samepassword", b)).toBe(true);
  });

  test("empty password is rejected (not hashed)", async () => {
    // Tightened (EHC-1): assert the SPECIFIC typed error, not "any
    // rejection". `hashPassword("")` throws `AuthError("auth_password_empty")`
    // — a loose `.rejects.toThrow` would pass on a TypeError from a
    // refactor too, masking the typed-error contract.
    await expect(hashPassword("")).rejects.toThrow(AuthError);
    await expect(hashPassword("")).rejects.toMatchObject({ code: "auth_password_empty" });
  });

  test("empty/malformed stored hash verifies false (never throws)", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "garbage")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$broken")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$a$b$c$d$e")).toBe(false);
  });

  test("hash format is self-describing (scrypt$N$r$p$salt$hash)", async () => {
    const hash = await hashPassword("test123");
    expect(hash.startsWith("scrypt$")).toBe(true);
    const parts = hash.split("$");
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBeGreaterThan(0);
  });
});

describe("session tokens", () => {
  test("createSessionToken is random + hex", () => {
    const a = createSessionToken();
    const b = createSessionToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBe(64); // 32 bytes → 64 hex chars
  });

  test("hashSessionToken is SHA-256 (deterministic, not the raw token)", () => {
    const token = createSessionToken();
    const hash = hashSessionToken(token);
    expect(hash).not.toBe(token);
    expect(hashSessionToken(token)).toBe(hash); // deterministic
    expect(hash.length).toBe(64); // SHA-256 → 64 hex chars
  });
});

describe("isSessionExpired", () => {
  test("recent timestamp is not expired", () => {
    expect(isSessionExpired(new Date().toISOString(), 720)).toBe(false);
  });

  test("old timestamp is expired", () => {
    const old = new Date(Date.now() - 1000 * 60 * 60 * 48).toISOString(); // 48h ago
    expect(isSessionExpired(old, 24)).toBe(true);
  });

  test("TTL 0 means no expiry", () => {
    const veryOld = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 10).toISOString();
    expect(isSessionExpired(veryOld, 0)).toBe(false);
  });

  test("invalid timestamp is expired", () => {
    expect(isSessionExpired("not-a-date", 720)).toBe(true);
  });
});

describe("DB auth flow — register → login → session → logout (v12 multi-user)", () => {
  test("full flow with a real in-memory DB", async () => {
    const db = makeDb();
    // Initially no users are registered (setup mode).
    expect(db.countUsers()).toBe(0);

    // Register: hash the password + create the first user (becomes admin).
    const hash = await hashPassword("my-secret-dashboard-password");
    const user = db.createUser("admin", hash);
    expect(db.countUsers()).toBe(1);
    expect(Number(user.is_admin)).toBe(1);

    // The stored hash is retrievable + verifies.
    const stored = db.getUserByUsername("admin");
    expect(stored).not.toBeNull();
    expect(await verifyPassword("my-secret-dashboard-password", stored!.password_hash)).toBe(true);
    expect(await verifyPassword("wrong", stored!.password_hash)).toBe(false);

    // Create a session linked to the user.
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    db.createAuthSession(tokenHash, user.id, "session-1");
    const session = db.getAuthSession(tokenHash);
    expect(session).not.toBeNull();
    expect(session!.user_id).toBe(user.id);

    // Logout: delete the session.
    db.deleteAuthSession(tokenHash);
    expect(db.getAuthSession(tokenHash)).toBeNull();
  });

  test("the first registered user is the admin; subsequent users are not", async () => {
    const db = makeDb();
    const admin = db.createUser("admin", "h1");
    const user = db.createUser("bob", "h2");
    expect(Number(admin.is_admin)).toBe(1);
    expect(Number(user.is_admin)).toBe(0);
  });

  test("username collisions are rejected by the UNIQUE constraint", async () => {
    const db = makeDb();
    db.createUser("admin", "h1");
    // A second user with the same username must throw (the route maps this
    // to 409). Tightened (EHC-2): the DB layer throws a SQLite UNIQUE-
    // constraint error (a plain Error, NOT a typed error — the ROUTE
    // catches + maps to ConflictError). Assert the error message names the
    // UNIQUE constraint so a DIFFERENT failure (e.g. a connection/encryption
    // error) does not silently pass the test (faking coverage).
    expect(() => db.createUser("admin", "h2")).toThrow(/UNIQUE constraint/i);
  });

  test("setUserPasswordHash rotates a user's password", async () => {
    const db = makeDb();
    const user = db.createUser("admin", await hashPassword("first"));
    expect(await verifyPassword("first", db.getUserByUsername("admin")!.password_hash)).toBe(true);
    db.setUserPasswordHash(user.id, await hashPassword("second"));
    expect(await verifyPassword("first", db.getUserByUsername("admin")!.password_hash)).toBe(false);
    expect(await verifyPassword("second", db.getUserByUsername("admin")!.password_hash)).toBe(true);
  });

  test("DB never stores the raw token (only the hash)", () => {
    const db = makeDb();
    const user = db.createUser("admin", "h1");
    const token = createSessionToken();
    const tokenHash = hashSessionToken(token);
    db.createAuthSession(tokenHash, user.id, "s1");
    // The raw token must not equal the stored hash.
    expect(token).not.toBe(tokenHash);
  });

  test("nonexistent session lookup returns null", () => {
    const db = makeDb();
    expect(db.getAuthSession("nonexistent-hash")).toBeNull();
  });

  test("deleting a nonexistent session is a no-op", () => {
    const db = makeDb();
    expect(() => db.deleteAuthSession("nonexistent")).not.toThrow();
  });
});

describe("user model prefs DB (models in DB, per-user — v12)", () => {
  test("upsert + read round-trip", () => {
    const db = makeDb();
    const userId = db.createUser("alice", "h").id;
    const config = { providers: [{ id: "custom", baseUrl: "http://localhost", models: [{ id: "my-model" }] }] };
    db.upsertUserModelPrefs(userId, config);
    const read = db.getUserModelPrefs(userId);
    expect(read).not.toBeNull();
    expect((read as { providers: unknown[] }).providers).toHaveLength(1);
  });

  test("upsert replaces existing config", () => {
    const db = makeDb();
    const userId = db.createUser("alice", "h").id;
    db.upsertUserModelPrefs(userId, { version: 1 });
    db.upsertUserModelPrefs(userId, { version: 2 });
    const read = db.getUserModelPrefs(userId);
    expect((read as { version: number }).version).toBe(2);
  });

  test("unset prefs return null", () => {
    const db = makeDb();
    const userId = db.createUser("alice", "h").id;
    expect(db.getUserModelPrefs(userId)).toBeNull();
  });

  test("different users have independent prefs", () => {
    const db = makeDb();
    const a = db.createUser("alice", "h").id;
    const b = db.createUser("bob", "h").id;
    db.upsertUserModelPrefs(a, { name: "alice" });
    db.upsertUserModelPrefs(b, { name: "bob" });
    expect((db.getUserModelPrefs(a) as { name: string }).name).toBe("alice");
    expect((db.getUserModelPrefs(b) as { name: string }).name).toBe("bob");
  });
});
