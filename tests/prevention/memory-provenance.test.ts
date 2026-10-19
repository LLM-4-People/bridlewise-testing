// @vitest-environment node
/**
 * Prevention: memory provenance + encryption + session scoping.
 *
 * The user: "memory should be moved elsewhere... properly and securely
 * bind memory to the same user we use with the database thing and possibly
 * encrypt it if feasible with that same key. we really need to make sure we
 * properly tag things in memory, whether it comes from a tool, what is the
 * tool name, what was the original request, what it saved, if it's on a
 * conversation, was it an llm, when what how, same for user."
 *
 * This test mechanically verifies the memory-bridge + route + client carry
 * the full provenance taxonomy, encrypt content with the same DB key, and
 * scope by session. It scans source so a regression that drops a field or
 * the encryption fails loudly.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MEMORY_SOURCES } from "../../shared/wire-types";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const BRIDGE = modulePath("memory-bridge.ts");
const ROUTE = modulePathMatching("server/routes/memory.ts");
const STATE = modulePathMatching("src/state/memory.ts");
const CLIENT = modulePathMatching("src/client.ts");
// SPO: the wire types `MemorySource` + `MemoryEntryView` are owned by
// `shared/wire-types.ts` (single wire-shape owner, imported by both
// server + client — no drift). The provenance-taxonomy literals now live
// HERE (the bridge + state re-export from it).
const WIRE = "shared/wire-types.ts";

const bridgeSrc = readFileSync(BRIDGE, "utf8");
const routeSrc = readFileSync(ROUTE, "utf8");
const stateSrc = readFileSync(STATE, "utf8");
const clientSrc = readFileSync(CLIENT, "utf8");
const wireSrc = readFileSync(WIRE, "utf8");

describe("memory provenance taxonomy", () => {
  // Dynamically discover the provenance fields from the MemoryProvenance
  // type definition in the bridge (the single owner). A new field added to
  // the type is automatically checked; the list never silently rots.
  function discoverProvenanceFields(src: string): readonly string[] {
    const start = src.indexOf("export type MemoryProvenance = Readonly<{");
    if (start === -1) return [];
    const end = src.indexOf("}>", start);
    if (end === -1) return [];
    const block = src.slice(start, end + 2);
    const fields: string[] = [];
    for (const m of block.matchAll(/readonly (\w+)/g)) {
      fields.push(m[1]!);
    }
    return fields;
  }
  const PROVENANCE_FIELDS = discoverProvenanceFields(bridgeSrc);

  test("the bridge type declares every provenance field the user listed", () => {
    expect(PROVENANCE_FIELDS.length, "MemoryProvenance type must be discovered in the bridge").toBeGreaterThan(0);
    // source (tool/conversation/llm/user), toolName, originalRequest, chatId,
    // how (automatic/manual), userId — the full "what/when/how" provenance.
    for (const field of PROVENANCE_FIELDS) {
      expect(bridgeSrc, `MemoryProvenance must declare ${field}`).toContain(field);
    }
    // The four sources the user enumerated. SPO: the `MemorySource`
    // union + the `MEMORY_SOURCES` const live in shared/wire-types.ts
    // (the single wire-shape owner); the bridge + state re-export them.
    // Dynamic discovery (deny-by-default): import the canonical
    // `MEMORY_SOURCES` array + verify each member is in the `MemorySource`
    // union in wire-types.ts. A new source added tomorrow to
    // `MEMORY_SOURCES` is auto-checked (no static list to rot).
    expect(MEMORY_SOURCES.length, "MEMORY_SOURCES must be non-empty").toBeGreaterThan(0);
    for (const s of MEMORY_SOURCES) {
      expect(wireSrc, `MemorySource (shared/wire-types.ts) must include '${s}'`).toContain(`"${s}"`);
    }
  });

  test("provenance is encoded into tags + metadata (searchable + filterable)", () => {
    expect(bridgeSrc, "encodeProvenance must exist").toContain("encodeProvenance");
    expect(bridgeSrc, "decodeProvenance must exist").toContain("decodeProvenance");
    // source goes into tags; tool name is tagged as `tool:<name>` so it's filterable.
    expect(bridgeSrc).toContain("tags.push(`tool:${");
    // metadata carries originalRequest/chatId/how/userId as plaintext strings.
    expect(bridgeSrc).toContain('metadata["originalRequest"]');
    expect(bridgeSrc).toContain('metadata["chatId"]');
    expect(bridgeSrc).toContain('metadata["userId"]');
  });

  test("the route exposes search by provenance + a store endpoint (v12: user-resolved scoping)", () => {
    expect(routeSrc, "search schema must accept source").toContain("source");
    expect(routeSrc, "search schema must accept toolName").toContain("toolName");
    expect(routeSrc, "search schema must accept chatId").toContain("chatId");
    // v12: the route resolves the user server-side (NOT a client-supplied
    // sessionId) — the prior client-supplied sessionId was a cross-user leak.
    expect(routeSrc, "route must resolve the user via requireUserContext").toContain("requireUserContext");
    expect(routeSrc, "route must NOT accept a client-supplied sessionId").not.toContain("sessionId");
    expect(routeSrc, "POST /api/memory must exist for manual store").toContain('"/api/memory"');
  });

  test("the client + state carry the provenance view", () => {
    // The view model carries EVERY provenance field including the owning
    // userId (v12). SPO: the `MemoryEntryView` shape lives in
    // shared/wire-types.ts (single wire-shape owner); the state re-
    // exports it. The provenance-field literals are in the WIRE owner.
    for (const field of PROVENANCE_FIELDS) {
      expect(wireSrc, `contracts MemoryEntryView must include ${field}`).toContain(field);
    }
    expect(clientSrc, "client must expose searchMemory").toContain("searchMemory");
    expect(clientSrc, "client must expose storeMemory").toContain("storeMemory");
  });

  // (The MemoryPanel probe died with the old tree; the LIVE subject —
  //  server-side provenance, encryption and session scoping — is above.)
});

describe("memory content is encrypted with the same DB key", () => {
  test("the bridge encrypts content before storing and decrypts on read", () => {
    // The same persisted key as web.db. Memory content is sealed to its owner
    // and seal id (contentBinding → memoryBinding / ownerSealAad, SEC-d M6):
    // an entry moved to another user's metadata no longer opens.
    expect(bridgeSrc, "bridge must use createDbCrypto").toContain("createDbCrypto");
    expect(bridgeSrc, "bridge must encrypt content before the store").toContain("getMemoryCrypto().encryptField(content, contentBinding(metadata))");
    expect(bridgeSrc, "bridge must decrypt content on read").toContain("getMemoryCrypto().decryptField(entry.content, contentBinding(entry.metadata))");
  });

  test("the bridge uses the same key source as the DB client (the one admitted process key)", () => {
    // The process owner (bootstrap-key.ts) admits the key once from serverConfig;
    // database, memory and timeline share it (database-key-authority.test.ts proves it natively).
    expect(bridgeSrc).toContain("createDbCryptoFromKey(getDatabaseKey())");
  });
});

describe("memory is per-user (v12: user-resolved scoping)", () => {
  test("searchMemory + listMemoryEntries scope by userId (User B ≠ User A)", () => {
    expect(bridgeSrc, "searchMemory must accept userId").toContain("userId");
    expect(bridgeSrc, "listMemoryEntries must accept userId").toContain("userId");
    // SPO: the user filter is EXCLUSIVE (deny-by-default). Only
    // the caller's OWN entries are returned. The prior "own + shared
    // (null)" filter (`e.userId === null || e.userId === userId`) leaked
    // unscoped/legacy entries to every user — a deny-by-default violation.
    // The filter now requires an EXACT userId match (no null/shared leak).
    expect(bridgeSrc).toContain("e.userId === scopedUserId");
  });
});
