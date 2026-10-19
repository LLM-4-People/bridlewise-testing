// @vitest-environment node
/**
 * Mechanical enforcement: the Single-Party-Owner principle for DATABASE
 * ACCESS ("DB: a single `DbClient` party that handles ALL
 * reads + writes... No route or service writes SQL directly; all go
 * through `DbClient` methods that enforce the gates").
 *
 * The single owner is `server/db/client.ts` (DbClient) + `server/db/
 * migrations.ts` (the migration runner — the only other place raw SQL is
 * permitted, since DDL must run before DbClient methods exist). Every
 * other server module MUST go through DbClient methods — never prepare
 * SQL, never instantiate a DatabaseSync, never import the sqlite driver.
 *
 * This test scans the ENTIRE `server/` tree EXCLUDING `server/db/` for the
 * mechanisms that execute/instantiate SQL directly:
 * `db.prepare(` / `db.exec(` — the node:sqlite statement API
 * `new DatabaseSync(` — direct DB handle instantiation
 * `from "node:sqlite"` — importing the sqlite driver
 * `better-sqlite3` — an alternate driver (forbidden)
 * SQL DML keywords as string literals (`INSERT INTO`, `DELETE FROM`,
 * `SELECT... FROM`, `UPDATE <table> SET`) — catches SQL built as a
 * string and passed to any path, not only the `db.` API.
 *
 * It skips comment lines (so a doc comment mentioning "INSERT INTO" does
 * not trip it) and test files are OUT of scope (tests legitimately use raw
 * SQL to verify DbClient mechanics — they live under tests/, not server/).
 *
 * If a route or service ever needs a query DbClient does not provide, the
 * fix is to ADD a method to DbClient (with the gates: user_id scoping,
 * encryption, validation) — NOT to write SQL in the route. This test makes
 * that the only path: a raw-SQL bypass fails the suite.
 */
import { describe, test, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { walk, SOURCE_EXTS, stripCommentsAndStringsFor } from "../helpers/source-scan.ts";

const SERVER_ROOT = join(process.cwd(), "server");
const DB_OWNER_DIR = join(SERVER_ROOT, "db");

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..");
}

// Files inside server/db/ are the DB owner (client.ts, migrations.ts,
// schema.ts, index.ts) — they are the ONLY server files permitted to use
// raw SQL / the sqlite driver. Everything else must go through DbClient.
// SOURCE_EXTS (the shared owner of the extension set) covers .ts + .svelte
// + .mjs/.cjs/.js so a future non-TS route with raw SQL is auto-caught
// (deny-by-default — no bypass can hide in an unscanned extension).
const files = walk(SERVER_ROOT, { exts: SOURCE_EXTS }).filter((f) => !isWithin(f, DB_OWNER_DIR));

// API-level signals: the actual mechanisms to execute/instantiate SQL.
// These are 100% precise — they never match comments, strings, or
// error messages; they match ONLY real DB-access code.
const API_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  { re: /\.prepare\s*\(/, label: "db.prepare() — use a DbClient method" },
  { re: /\.exec\s*\(\s*[`"']/, label: ".exec() with a SQL string — use a DbClient method" },
  { re: /\bnew\s+DatabaseSync\s*\(/, label: "new DatabaseSync() — use the shared DbClient" },
  { re: /from\s*["']node:sqlite["']/, label: 'import from "node:sqlite" — use DbClient' },
  { re: /\bbetter-sqlite3\b/, label: "better-sqlite3 — use the shared DbClient (node:sqlite)" },
];

// SQL DML keywords as string literals — catches SQL built as a string and
// passed to any path (not only the `db.` API). Multi-word patterns have a
// near-zero false-positive rate in comments; comment lines are skipped too.
const SQL_PATTERNS: ReadonlyArray<{ readonly re: RegExp; readonly label: string }> = [
  { re: /["'`]\s*(?:INSERT\s+INTO|DELETE\s+FROM)\b/i, label: "INSERT INTO / DELETE FROM SQL literal" },
  { re: /["'`]\s*SELECT\s+(?:\*|DISTINCT|1|id)\b[\s\S]*?FROM\b/i, label: "SELECT ... FROM SQL literal" },
  { re: /["'`]\s*UPDATE\s+[a-z_]+\s+SET\b/i, label: "UPDATE ... SET SQL literal" },
];

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

describe("Single-Party-Owner: DB access — no raw SQL outside server/db/", () => {
  const findings: { file: string; line: number; text: string; label: string }[] = [];

  for (const file of files) {
    const rel = relative(process.cwd(), file);
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (isCommentLine(line)) continue;
      for (const { re, label } of [...API_PATTERNS, ...SQL_PATTERNS]) {
        if (re.test(line)) {
          findings.push({ file: rel, line: i + 1, text: line.trim(), label });
        }
      }
    }
  }

  test("no server file outside server/db/ uses the sqlite driver or raw SQL", () => {
    if (findings.length > 0) {
      const detail = findings
        .map((f) => `  ${f.file}:${f.line}  [${f.label}]\n    ${f.text}`)
        .join("\n");
      throw new Error(
        `Raw SQL / sqlite-driver use outside the DB owner (server/db/).\n` +
          `Move the query into a DbClient method (server/db/client.ts) with the ` +
          `proper gates (user_id scoping, encryption, validation):\n${detail}`,
      );
    }
  });

  test("server/db/client.ts is the DbClient owner and exports chatBelongsToUser (the chat→user gate)", () => {
    const src = readFileSync(join(DB_OWNER_DIR, "client.ts"), "utf8");
    // The choke-point ownership gate for the chat resource tree must live
    // in the owner (Single-Party-Owner), not scattered across routes. It is
    // retained as an internal ownership probe (used by the create methods to
    // verify the parent before inserting a child).
    expect(src, "DbClient must own chatBelongsToUser as a single JOIN query").toContain(
      "chatBelongsToUser",
    );
    expect(src, "chatBelongsToUser must be a single JOIN (chats ⋈ projects on user_id)").toMatch(
      /chatBelongsToUser[\s\S]*?JOIN projects p ON c\.project_id = p\.id[\s\S]*?p\.user_id = \?/,
    );
  });

  test("routes resolve ownership through scoped DbClient getters (getChat/getProject with userId), not an unscoped getChat+chatBelongsToUser dance", () => {
    // Single-Party-Owner: the caller-gated `chatBelongsToUser` +
    // unscoped `getChat` dance in every route is GONE. Ownership is enforced
    // by the scoped DB getters `getChat(id, userId)` / `getProject(id, userId)`
    // — they return null when the resource is not owned, so the route just
    // maps null → 404. Each route must resolve the authenticated user
    // (requireUserContext) and pass `user.userId` into a scoped getter; a
    // route that forgets cannot leak another user's data because the method
    // won't return it.
    // Dynamic discovery: scan ALL route files for ones that use
    // scoped DB getters (getChat/getProject). A route that uses a scoped
    // getter without requireUserContext + userId threading is automatically
    // caught — no hardcoded list.
    const ROUTES_DIR = join(process.cwd(), "server", "routes");
    const routeFiles = readdirSync(ROUTES_DIR)
      .filter((f) => SOURCE_EXTS.includes(extname(f)))
      .map((f) => join("server", "routes", f))
      .filter((f) => {
        const src = readFileSync(join(process.cwd(), f), "utf8");
        return src.includes("getChat(") || src.includes("getProject(");
      });
    expect(routeFiles.length, "at least one route should use getChat/getProject").toBeGreaterThan(0);
    for (const f of routeFiles) {
      const src = readFileSync(join(process.cwd(), f), "utf8");
      expect(
        src.includes("requireUserContext"),
        `${f} must resolve the authenticated user via requireUserContext`,
      ).toBe(true);
      expect(
        src.includes("user.userId"),
        `${f} must thread user.userId into the scoped DB getters`,
      ).toBe(true);
      expect(
        src.includes("getChat(") || src.includes("getProject("),
        `${f} must use a scoped DbClient getter (getChat/getProject) for ownership`,
      ).toBe(true);
    }
  });

  test("every user-data DbClient method takes a userId parameter (Single-Party-Owner enforcement)", () => {
    // The mechanical gate: every DbClient method that reads or writes
    // tenant-scoped rows MUST take a `userId` parameter and filter by it
    // (directly on user_id, or via a JOIN chain to the owning project). The
    // DB layer enforces the scoping so a route that forgets `userId` cannot
    // read/write another user's data (the method returns null/empty/throws
    // /affects 0 rows). This test pins that contract — a method that loses
    // its userId param fails the suite.
    //
    // DENY-BY-DEFAULT + DYNAMIC discovery. The tenant tables, row types,
    // and exempt (auth/system) tables are all discovered DYNAMICALLY:
    //  - tenant tables: parsed from migrations.ts (`CREATE TABLE IF NOT
    //    EXISTS <name>`). A new tenant table → methods referencing it are
    //    auto-caught (no list to update).
    //  - row types: parsed from schema.ts (`export type <Name>Row` +
    //    `ChatHistory`). A new row type → methods returning it are auto-
    //    caught by the secondary row-type scan.
    //  - exempt tables: the auth/system tables (`users`, `auth_config`,
    //    `auth_sessions`, `schema_version`) — the small, stable set of
    //    tables that store the user IDENTITY (not tenant data scoped by
    //    user_id). A method that references ONLY exempt tables is exempt
    //    (it looks up the user, not tenant data). A method referencing a
    //    NEW table is assumed tenant-scoped → must take userId (deny-by-
    //    default).
    // The only manual special-case is the input-object pattern: a method
    // whose userId is carried INSIDE a typed input object (e.g.
    // `upsertToolSetting(input: ToolSettingUpsertInput)` where `input`
    // carries `user_id`). This is a 1-element documented set, not a rotting
    // 10-element method-name list.
    const clientPath = join(DB_OWNER_DIR, "client.ts");
    const clientSrc = readFileSync(clientPath, "utf8");
    const schemaSrc = readFileSync(join(SERVER_ROOT, "db", "schema.ts"), "utf8");
    const migrationsSrc = readFileSync(join(SERVER_ROOT, "db", "migrations.ts"), "utf8");

    // Dynamically discover every table name from the migrations.
    const allTables = new Set<string>();
    for (const m of migrationsSrc.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)) {
      allTables.add(m[1]!);
    }
    expect(allTables.size, "must discover tables from migrations.ts").toBeGreaterThan(0);

    // The exempt (auth/system) tables — store the user identity or schema,
    // not tenant data scoped by user_id. A new table is tenant-scoped by
    // default (must take userId) unless explicitly added here. This is the
    // deny-by-default exception set (stable: auth + schema only).
    const exemptTables = new Set(["users", "auth_config", "auth_sessions", "schema_version"]);
    const tenantTables = [...allTables].filter((t) => !exemptTables.has(t));
    expect(tenantTables.length, "must discover tenant tables").toBeGreaterThan(0);

    // Dynamically discover every row type from schema.ts (+ ChatHistory).
    const rowTypes = new Set<string>();
    for (const m of schemaSrc.matchAll(/export type\s+(\w+Row)\s*=/g)) rowTypes.add(m[1]!);
    if (/export type\s+ChatHistory\b/.test(schemaSrc)) rowTypes.add("ChatHistory");
    expect(rowTypes.size, "must discover row types from schema.ts").toBeGreaterThan(0);

    // Methods that carry userId INSIDE a typed input object (not a top-
    // level param). Detected DYNAMICALLY from the method body: a method
    // reads `userId` from its input when its body accesses a `.user_id`
    // property (e.g. `valid.user_id` from a Zod-parsed input whose schema
    // has a `user_id` field, like `upsertToolSetting`). The check runs on
    // the string-stripped body so SQL column refs (`p.user_id = ?` inside a
    // template literal) do NOT match — only real JS property access does.
    // A new method that threads userId via an input object is auto-exempt
    // with no list to update; a method that loses the access must take a
    // top-level `userId` param (deny-by-default).
    function carriesUserIdInInput(body: string): boolean {
      return /\.\buser_id\b/.test(stripCommentsAndStringsFor(body, clientPath));
    }

    // Extract every class-method body: `  methodName(...) { ... matching }`.
    // Returns { name, params, body } for each method. The closing brace is
    // the first `}` at column 2 (matching the method's indentation).
    interface MethodSig { name: string; params: string; body: string; }
    function extractMethodBodies(src: string): MethodSig[] {
      const out: MethodSig[] = [];
      // Match a method signature at 2-space indent: `  name(` OR
      // `  name<T>(` (generic methods like `withTransaction<T>`). The
      // optional `<...>` group is matched non-greedily so the `(` after it
      // is the param-list open, not a `(` inside the generic constraint.
      // Without the generic clause, `withTransaction<T>(...)` was silently
      // skipped (the `\(` required `(` immediately after `\w+`, but `<`
      // followed) — a future generic method referencing a tenant table
      // would bypass the userId-threading check.
      const sigRe = /\n  (\w+)(?:<[^>()]*>)?\(([^)]*)\)/g;
      let sm: RegExpExecArray | null;
      while ((sm = sigRe.exec(src)) !== null) {
        const name = sm[1]!;
        const params = sm[2]!;
        // The `{` opening the body follows the signature (possibly on the
        // same line, possibly the next). Find it after the signature close.
        const afterSig = sm.index! + sm[0]!.length;
        const braceIdx = src.indexOf("{", afterSig);
        if (braceIdx === -1) continue;
        // Brace-match to the closing `}`.
        let depth = 0;
        let i = braceIdx;
        for (; i < src.length; i++) {
          const ch = src[i]!;
          if (ch === "{") depth++;
          else if (ch === "}") { depth--; if (depth === 0) break; }
        }
        const body = src.slice(braceIdx, Math.min(i + 1, src.length));
        out.push({ name, params, body });
      }
      return out;
    }

    // True if `body` references `table` via SQL (FROM/INTO/UPDATE/DELETE FROM/
    // JOIN). Checked on the raw body (SQL strings live in template literals).
    function referencesTable(body: string, table: string): boolean {
      const esc = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        `\\b(?:FROM|INTO|UPDATE|DELETE\\s+FROM|JOIN)\\s+${esc}\\b`,
        "i",
      );
      return re.test(body);
    }

    const methods = extractMethodBodies(clientSrc);
    expect(methods.length, "must discover DbClient methods").toBeGreaterThan(0);

    const failures: string[] = [];
    // PRIMARY scan (deny-by-default): every method that references a tenant
    // table must take userId (or carry it in a typed input object).
    for (const m of methods) {
      const refsTenant = tenantTables.some((t) => referencesTable(m.body, t));
      if (!refsTenant) continue;
      if (carriesUserIdInInput(m.body)) continue;
      if (/\buserId\b/.test(m.params)) continue;
      failures.push(`${m.name}(${m.params.trim()}): references a tenant table but takes no userId`);
    }
    // SECONDARY scan (deny-by-default): every method returning a tenant row
    // type must take userId (or carry it in a typed input object). A method
    // returning a tenant row type is one whose return type contains a row
    // type that is NOT an auth/system row type.
    const exemptRowTypes = new Set(["UserRow", "AuthConfigRow", "AuthSessionRow", "SchemaVersionRow"]);
    const tenantRowTypes = [...rowTypes].filter((r) => !exemptRowTypes.has(r));
    for (const m of methods) {
      // Re-find the full signature (params + return type) from the source.
      const re = new RegExp(`\\n  ${m.name}\\(([^)]*)\\)\\s*:\\s*([A-Za-z<>'"\\[\\], |]+)`, "");
      const mm = re.exec(clientSrc);
      if (mm === null) continue;
      const ret = mm[2]!;
      const returnsTenantRow = tenantRowTypes.some((r) => ret.includes(r));
      if (!returnsTenantRow) continue;
      if (carriesUserIdInInput(m.body)) continue;
      if (/\b(userId|user_id)\b/.test(mm[1]!)) continue;
      failures.push(`${m.name}(${mm[1]!.trim()}): returns ${ret.trim()} but takes no userId`);
    }
    expect(
      failures,
      `user-data DbClient methods missing userId (Single-Party-Owner violation):\n${failures.map((f) => `  - ${f}`).join("\n")}`,
    ).toEqual([]);
  });
});
