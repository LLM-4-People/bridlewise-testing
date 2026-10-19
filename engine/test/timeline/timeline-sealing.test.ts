/**
 * THE KEPT HALF OF THE AUTHENTICATED-TIMELINE WORK, DRIVEN (a3-design H3,
 * a3-correctness M-3): the protected projection and its sealed originals had
 * lost their only tests with the draft, and every refusal of the sealing
 * owner survived its mutation. Here:
 *
 *   A. the sealing owner (`src/timeline/timeline-sealing.ts`) round-trips an
 *      empty and a multi-chunk original exactly, and refuses — one typed
 *      answer, no bytes — a wrong key, a chunk copied under another event,
 *      reordered or missing chunks, no seal at all, and a digest that is not
 *      the original's (driven on a scratch table without the ledger's
 *      triggers, so each tamper is possible);
 *   B. through the store: a secret crossing the chunk boundary is protected
 *      whole and restored exactly, and no file of the ledger holds it; the
 *      seal KEY is one per ledger — seals held with the key file gone refuse
 *      (nothing minted), a sibling sharing the key refuses to mint (a3-design
 *      H2), a second key is refused at open, and the ledger records a check
 *      value, never the key;
 *   C. the projection: a token in a description is masked while UUIDs and
 *      git SHAs are not; a sensitive document name or identity is refused,
 *      never masked; a registry row with a known name but another id is a
 *      migration this build does not know.
 */
import assert from "node:assert/strict";
import { createSecretKey, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { resolvePersistedKey } from "../../src/filesystem/persisted-key.ts";
import { registerKnownSecret } from "../../src/privacy/secret-intelligence.ts";
import { createTimelineSealing } from "../../src/timeline/timeline-sealing.ts";
import { configureDebugSystem, createCollectingSink, getAuditEvents, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { makeTimelineEventInput } from "../support/timeline.ts";
import { mkTempDir } from "../support/temp-dir.ts";

const SECRET = "ghp_AAAAAAAAAAAAAAAAAAAAAAAA";
registerKnownSecret(SECRET, "timeline-sealing-test");
const key = () => createSecretKey(randomBytes(32));
const refused = { code: "timeline_sealed_original_unavailable" };

/** A scratch table with the sealing owner's schema and none of the ledger's triggers. */
function scratchOriginals(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE event_document_originals (doc_id INTEGER NOT NULL, chunk INTEGER NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY (doc_id, chunk)) STRICT");
  return db;
}

test("sealing owner: an empty and a multi-chunk original round-trip exactly; every tamper is one typed refusal", () => {
  const db = scratchOriginals();
  const sealing = createTimelineSealing(key());
  const at = { ledgerId: "L", eventId: "e1", sequence: "1" };
  const chunk = ROOT_POLICY.forensics.limits.maximumInputBytes;
  const big = `${"x".repeat(chunk - 10)}${SECRET}${"y".repeat(chunk)}`;
  sealing.seal(db, 1n, at, "");
  sealing.seal(db, 2n, at, big);
  assert.equal(sealing.open(db, 1n, at, sha256("")), "", "an empty original is one empty chunk");
  assert.equal(sealing.open(db, 2n, at, sha256(big)), big, "three chunks reassembled exactly");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM event_document_originals WHERE doc_id = 2").get() as { n: number }).n, 3);
  assert.throws(() => createTimelineSealing(key()).open(db, 2n, at, sha256(big)), refused, "a wrong key opens nothing");
  assert.throws(() => sealing.open(db, 2n, { ...at, eventId: "e2" }, sha256(big)), refused, "bound to its event");
  assert.throws(() => sealing.open(db, 2n, { ...at, sequence: "2" }, sha256(big)), refused, "bound to its sequence");
  assert.throws(() => sealing.open(db, 2n, at, sha256("another text")), refused, "the digest must be the original's");
  assert.throws(() => sealing.open(db, 3n, at, sha256("")), refused, "no seal at all");
  // A chunk copied under another document of another event.
  sealing.seal(db, 4n, { ...at, eventId: "e9" }, "short");
  db.prepare("INSERT INTO event_document_originals (doc_id, chunk, sealed) SELECT 5, chunk, sealed FROM event_document_originals WHERE doc_id = 4").run();
  assert.throws(() => sealing.open(db, 5n, at, sha256("short")), refused, "a chunk copied under another event");
  // Reordered and truncated chunks.
  for (const [from, to] of [[0, 10], [1, 0], [10, 1]] as const) db.prepare("UPDATE event_document_originals SET chunk = ? WHERE doc_id = 2 AND chunk = ?").run(to, from);
  assert.throws(() => sealing.open(db, 2n, at, sha256(big)), refused, "reordered chunks");
  sealing.seal(db, 6n, at, big);
  db.exec("DELETE FROM event_document_originals WHERE doc_id = 6 AND chunk = 2");
  assert.throws(() => sealing.open(db, 6n, at, sha256(big)), refused, "a truncated original");
  db.exec("DELETE FROM event_document_originals WHERE doc_id = 6 AND chunk = 0");
  assert.throws(() => sealing.open(db, 6n, at, sha256(big)), refused, "a missing first chunk");
  db.close();
});

test("store: a secret crossing the chunk boundary is protected whole, restored exactly, and in no file of the ledger", () => {
  const dir = mkTempDir("timeline-sealing-store-");
  try {
    const path = join(dir, "timeline.db");
    const store = createTimelineStore({ path, ledgerId: "L", key: key(), timelineConfig: { maxDocumentBytes: ROOT_POLICY.timeline.limits.maxDocumentBytes } });
    const chunk = ROOT_POLICY.forensics.limits.maximumInputBytes;
    const text = `${"a".repeat(chunk - 20)}TOKEN=${SECRET}\n${"b".repeat(64)}`;
    store.appendEvent({ ...makeTimelineEventInput("L", "e1", "file-effect"), documents: [{ name: "preimage", contentJson: text, contentDigest: sha256(text) }] });
    const document = store.getEvent("e1")!.documents[0]!;
    assert.equal(document.projectionDisposition, "protected");
    assert.equal(document.originalDigest, sha256(text));
    assert.equal(document.contentJson!.includes(SECRET), false, "the public row is masked");
    assert.equal(store.originalDocuments("e1", "rollback")![0]!.contentJson, text, "the original is restored exactly");
    store.close();
    for (const file of readdirSync(dir)) {
      const bytes = readFileSync(join(dir, file));
      for (const piece of [SECRET, SECRET.slice(0, 12), SECRET.slice(-12)]) assert.equal(bytes.includes(piece), false, `${file} holds ${piece}`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: ONE key per ledger — a lost key is never replaced, a sibling sharing it refuses to mint, a second key is refused at open (a3-design H2)", () => {
  const dir = mkTempDir("timeline-sealing-keys-");
  try {
    const sealed = join(dir, "a.db"), sibling = join(dir, "b.db"), empty = join(dir, "c-alone", "c.db");
    const store = createTimelineStore({ path: sealed, ledgerId: "A" });
    const text = `TOKEN=${SECRET}`;
    store.appendEvent({ ...makeTimelineEventInput("A", "sealed", "file-effect"), documents: [{ name: "preimage", contentJson: text, contentDigest: sha256(text) }] });
    store.close();
    const keyFile = resolvePersistedKey({ dbPath: sealed, disposition: "load-only" }).filePath!;
    const check = (new DatabaseSync(sealed, { readOnly: true }).prepare("SELECT check_value FROM timeline_seal_key_check").get() as { check_value: string }).check_value;
    assert.match(check, /^[0-9a-f]{64}$/u, "the ledger records a check value");
    assert.equal(check.includes(readFileSync(keyFile).toString("hex")), false, "never the key");
    rmSync(keyFile);
    assert.throws(() => createTimelineStore({ path: sealed, ledgerId: "A" }), { code: "persisted_key_missing" }, "seals held: the lost key is refused, never replaced");
    assert.equal(existsSync(keyFile), false, "nothing was minted");
    assert.throws(() => createTimelineStore({ path: sibling, ledgerId: "B" }), (error: unknown) => (error as { code?: string }).code === "persisted_key_missing" && String((error as Error).message).includes(sealed),
      "an empty sibling sharing the key does not mint a replacement that orphans the seals");
    assert.equal(existsSync(keyFile), false, "still nothing minted");
    // A ledger with nothing sealed, in a folder of its own, mints its key.
    mkdirSync(dirname(empty));
    createTimelineStore({ path: empty, ledgerId: "C" }).close();
    assert.equal(existsSync(resolvePersistedKey({ dbPath: empty, disposition: "load-only" }).filePath!), true);
    // A second key: refused at open, before anything is sealed or read.
    const mixed = join(dir, "mixed.db");
    const first = key();
    const web = createTimelineStore({ path: mixed, ledgerId: "M", key: first });
    web.appendEvent({ ...makeTimelineEventInput("M", "web", "file-effect"), documents: [{ name: "preimage", contentJson: text, contentDigest: sha256(text) }] });
    web.close();
    assert.throws(() => createTimelineStore({ path: mixed, ledgerId: "M", key: key() }), { code: "timeline_seal_key_mismatch" });
    const again = createTimelineStore({ path: mixed, ledgerId: "M", key: first });
    assert.equal(again.originalDocuments("web", "rollback")![0]!.contentJson, text, "the ledger's own key still opens it");
    again.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the decrypt door: every opening of a seal is audited — names, purpose and outcome, never bytes (a3-design M6)", (t) => {
  resetDebugSystem();
  t.after(resetDebugSystem);
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [createCollectingSink()]);
  const opens = () => getAuditEvents().filter((event) => event.category === "timeline.original.open").map((event) => event.context).reverse();
  const dir = mkTempDir("timeline-sealing-audit-");
  try {
    const path = join(dir, "timeline.db");
    const own = key();
    const store = createTimelineStore({ path, ledgerId: "L", key: own });
    for (const eventId of ["e1", "e2"]) {
      const text = `TOKEN=${SECRET}-${eventId}`;
      store.appendEvent({ ...makeTimelineEventInput("L", eventId, "file-effect"), documents: [{ name: "preimage", contentJson: text, contentDigest: sha256(text) }] });
    }
    store.appendEvent(makeTimelineEventInput("L", "plain"));
    assert.equal(store.originalDocuments("e1", "rollback")![0]!.contentJson, `TOKEN=${SECRET}-e1`);
    store.originalDocuments("plain", "workspace-shard-import");
    store.close();
    assert.deepEqual(opens(), [{ ledgerId: "L", eventId: "e1", documents: ["preimage"], purpose: "rollback", outcome: "opened" }], "one opening, audited; a document never sealed opens nothing");
    assert.equal(JSON.stringify(getAuditEvents()).includes(SECRET.slice(4, 16)), false, "never the bytes");
    // A seal copied under another event (the append-only triggers lifted and restored byte-exactly): refused, and the refusal audited.
    const raw = new DatabaseSync(path);
    const triggers = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'event_document_originals'").all() as { name: string; sql: string }[];
    assert.ok(triggers.length > 0);
    for (const trigger of triggers) raw.exec(`DROP TRIGGER "${trigger.name}"`);
    raw.exec(`UPDATE event_document_originals SET sealed = (SELECT o.sealed FROM event_document_originals o JOIN event_documents d ON d.doc_id = o.doc_id WHERE d.event_id = 'e2')
      WHERE doc_id = (SELECT doc_id FROM event_documents WHERE event_id = 'e1')`);
    for (const trigger of triggers) raw.exec(trigger.sql);
    raw.close();
    const reopened = createTimelineStore({ path, ledgerId: "L", key: own });
    assert.throws(() => reopened.originalDocuments("e1", "workspace-shard-import"), refused);
    reopened.close();
    assert.deepEqual(opens().at(-1), { ledgerId: "L", eventId: "e1", documents: ["preimage"], purpose: "workspace-shard-import", outcome: "timeline_sealed_original_unavailable" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("store: a token in a description is masked, UUIDs and git SHAs are not; a sensitive document name or identity is refused, never masked", () => {
  const dir = mkTempDir("timeline-sealing-projection-");
  try {
    const store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: "L", key: key() });
    store.appendEvent({ ...makeTimelineEventInput("L", "cmd"), description: `ran git push --token=${SECRET}` });
    const masked = store.getEvent("cmd")!.description;
    assert.equal(masked.includes(SECRET), false);
    assert.match(masked, /^ran git push --token=\[REDACTED:/u, "masked in place, the rest of the description kept");
    for (const [eventId, description] of [["uuid", "resumed chat 1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"], ["sha", "checked out 3f6fe77023577ed287039b38ddba0f0984168d2e"]] as const) {
      store.appendEvent({ ...makeTimelineEventInput("L", eventId), description });
      assert.equal(store.getEvent(eventId)!.description, description, `${eventId} is not a secret`);
    }
    assert.throws(() => store.appendEvent({ ...makeTimelineEventInput("L", "named"), documents: [{ name: `token-${SECRET}`, contentJson: "{}", contentDigest: sha256("{}") }] }), { code: "timeline_sensitive_identifier" });
    assert.throws(() => store.appendEvent(makeTimelineEventInput("L", `evt-${SECRET}`)), { code: "timeline_sensitive_identifier" });
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("migrations: a registry row with a KNOWN name but another id is a migration this build does not know", () => {
  const dir = mkTempDir("timeline-sealing-registry-");
  try {
    const path = join(dir, "timeline.db");
    createTimelineStore({ path, ledgerId: "L", key: key() }).close();
    const raw = new DatabaseSync(path);
    raw.exec("UPDATE schema_migrations SET migration_id = 99 WHERE name = 'timeline-document-sealed-originals-v1'");
    raw.close();
    assert.throws(() => createTimelineStore({ path, ledgerId: "L", key: key() }), { code: "timeline_migration_unknown" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
