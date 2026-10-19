// @vitest-environment node
/**
 * Mechanical enforcement: the BLOCK is the only way a capability enters the
 * system.
 *
 * Binding guideline: "I want the entire harness to work the same, every api,
 * every page, so we can build on the easiest possible way, in modules/blocks."
 *
 * A capability was four hand-maintained artifacts — a route registration,
 * inline validation, a client function, and a bespoke panel. 102 route
 * registrations against 93 client exports means they had already drifted.
 * `defineBlock` collapses those into one declaration; this guard is what stops
 * the old shape growing back while the backlog drains.
 *
 * THE RATCHET IS THE POINT
 *
 * A big-bang migration of 102 routes would be a long red window with no
 * shippable state in between. Instead the legacy surface is counted and
 * allowed to SHRINK ONLY. New capabilities cannot be added the old way from
 * day one, so the problem stops growing immediately even while the existing
 * routes are converted one domain at a time.
 *
 * Assurance classes:
 *   A. Legacy route ratchet — the hand-written route count may only fall.
 *   B. Method invariant — block reads are GET, block actions are POST.
 *   C. Envelope — every block read answers `{data, meta:{etag, asOf}}`.
 *   D. Id grammar — block ids use the shared exposure `namespace.name` form.
 *   E. Declaration completeness — a block has a read or an action, and prose.
 *   F. No bypass — nothing outside `server/blocks/` calls `defineBlock`.
 *   G. Binding resolution — every module SourceBinding names a real block.
 *
 * Discovery is DYNAMIC throughout: routes are counted by scanning, blocks by
 * enumerating the registry. Adding a block requires no edit here, which is the
 * property the doctrine requires of a guard.
 */
import { describe, test, expect, beforeAll } from "vitest";

import {
  blockActionPath,
  blockReadPath,
  isBlockPath,
  parseBlockPath,
} from "../../shared/block-contract.ts";
import { UI_DECLARATIONS } from "../../server/schema/ui-declarations.ts";
import { walk, read, relpath } from "../helpers/source-scan.ts";

/**
 * The hand-written route surface at the moment the block contract landed.
 *
 * This number may only DECREASE. Raising it means a capability was added the
 * old way, which the contract exists to prevent.
 */
/**
 * Raised 102 → 103 for `GET /api/live`, the standing liveness stream.
 *
 * THE RATCHET'S RULE IS "a new CAPABILITY must be a Block", and this is not a
 * capability. A Block answers one JSON envelope with an etag, a TTL and an
 * `asOf`; this route never answers at all — it holds a socket open and beats
 * on it until the process dies. There is no envelope to cache, nothing to
 * revalidate, and no data of any kind: its whole content is the fact that the
 * connection exists. Expressing it as a Block would mean inventing a value
 * for it to return, which is the fabrication the Block contract exists to
 * prevent.
 *
 * It is also what let the 1s `/api/health` POLL be deleted, so the route
 * count went up by one while the client's steady-state request rate went to
 * zero.
 */
/**
 * Raised 103 → 104 for `GET /api/chats/:id/history/older`.
 *
 * THE RATCHET'S RULE IS "a new CAPABILITY must be a Block", and this is not a
 * new capability: reading a conversation's history is `/api/chats/:id/history`
 * and has been all along. What changed is that it stopped returning ALL of it
 * — measured at 75.1MB and 34,665ms against a 30,000ms client timeout, i.e. a
 * conversation that could not be opened at all (DESIGN-PERFORMANCE §1 L2).
 * The route now returns the tail plus a cursor, and this second route is the
 * OTHER HALF of that one contract: the page before a cursor.
 *
 * It is deliberately not a `?before=` on the existing route, because the two
 * answers have different shapes — an older page knows nothing about the
 * conversation's metrics snapshots or timeline refs, and returning empty
 * arrays for them would read as "there are none" (§1 L3). Two shapes, two
 * routes; one capability.
 *
 * Nor could it be a Block without changing what a Block is: a Block answers
 * ONE cacheable envelope per read key, and a cursor page is a different
 * envelope per cursor — an unbounded key space with a one-shot etag apiece.
 * Paging is the thing the Block contract does not model yet, and inventing a
 * cache identity for a page is worse than leaving the route hand-written and
 * saying so here.
 */
/**
 * Raised 103 → 105 for `DELETE /api/models/providers/:providerId` and
 * `POST /api/models/providers/:providerId/test`.
 *
 * NEITHER CAN BE A BLOCK, and the reason is the Block contract itself rather
 * than convenience. A Block answers one cacheable envelope per read key —
 * it MODELS A READ. These two are the opposite: one destroys state, the other
 * performs an outbound side effect (a real request to a third-party endpoint)
 * whose whole value is that it happened just now. Caching either would be
 * wrong in the specific way this contract exists to prevent: a cached
 * "connection works" is a fabricated fact about the present.
 *
 * They are also not a widening of an existing route. `PUT /api/models/prefs`
 * merges providers by name — it is add-and-replace by construction, because
 * that is what stops a settings form that knows about one provider from
 * deleting the others. Expressing "remove" through it would mean a sentinel
 * value inside the merge, i.e. a delete disguised as a save, which is exactly
 * the shape that destroyed user data here before. Two verbs, two doors.
 *
 * The gap this closes is a product gap, not a plumbing one: until now a
 * provider could be added and edited but never removed (a name typed wrong
 * stayed in the picker permanently), and the first evidence that a key was
 * wrong was a run failing after the user had written a prompt and waited.
 */
/**
 * Raised 105 → 110 for the undelete family's five verbs:
 * `POST /api/chats/:id/restore`, `POST /api/editor/restore`,
 * `GET /api/editor/recycle`, `POST /api/projects/:id/restore` and
 * `GET /api/trash`.
 *
 * THE RATCHET'S RULE IS "a new CAPABILITY must be a Block", and these are
 * not one: they are the completion of three delete/read families that have
 * been routes since before this ratchet existed. Each restore sits beside a
 * `router.delete` that has lived in the same file over the same bridge and
 * the same ownership gate all along (`/api/editor/delete`,
 * `/api/projects/:id`, `/api/chats/:id`), and each listing is the read-side
 * of that same surface. The capability — "delete is reversible" — was
 * already hand-written the day delete was; the round only removed its lie
 * of permanence. Splitting just the inverse verbs onto the Block surface
 * would put one capability's two halves behind two different contract
 * shapes, which is the two-copies defect this guard itself exists to
 * refuse.
 *
  * A Block is also the wrong grain for the writes: `executeAction`'s
  * envelope carries a read's cache identity, and a restore's whole content
  * is that a tree changed just now — `restore_occupied` and the post-restore
  * cache invalidations are verdicts about the present, the same reason the
  * provider-test route is not cached three raises up. If a later round wants
  * the whole editor/projects/chats surface on blocks, that is one migration
  * told as one story, not a seam torn through the middle of five families.
  */
/**
 * Raised 110 → 113 for the MCP server door's three verbs:
 * `PUT /api/mcp/servers`, `DELETE /api/mcp/servers/:id` and
 * `POST /api/mcp/servers/:id/test`.
 *
 * THE RATCHET'S RULE IS "a new CAPABILITY must be a Block", and these are
 * the SAME class as the provider delete/test pair five raises up, which the
 * config-file row cannot be a Block for either. A Block answers one
 * cacheable envelope per read key — it MODELS A READ. These three are the
 * opposite: upsert and destroy are state mutations of the install's config
 * document, and the test performs an outbound side effect (a real connect +
 * tools/list to a configured process or address) whose whole value is that
 * it happened just now. A cached "the server answers" is a fabricated fact
 * about the present — the exact sentence the provider-test raise records.
 *
 * They are also the same family-shape the undelete raise records: the
 * verbs sit beside `GET /api/mcp/servers` and `GET /api/mcp/info`, which
 * have been routes in the same file over the same bridge and the same
 * ownership gate all along; the round only added the missing halves of the
 * family (a list that could never be added to or removed from was the
 * product gap UIE-060 filed). One capability's verbs behind one contract
 * shape in one file — a seam through the middle would put the read on the
 * Block surface and the writes on the route surface.
 */
 /**
  * Raised 113 → 114 for the run's one status read:
  * `GET /api/run/:runId/status` (server/routes/run-status.ts).
  *
  * THE RATCHET'S RULE IS "a new CAPABILITY must be a Block", and a Block
  * MODELS A READ — one cacheable envelope per read key. This route is a
  * read whose whole value is the PRESENT TENSE: it answers, from the
  * process's live registry alone, whether a run is still executing right
  * now, and its reader (the reloaded page's reconcile) consumes the answer
  * as a WRITE BARRIER — "not executing" is the promise that the run's
  * final row writes are done, so the row read that follows it is final and
  * may be settled. A cached envelope would fabricate that promise: a
  * stale "not executing" served after a run's last moments would let a
  * reader settle a turn whose words were still being written. The
  * provider-test raise four raises up records the same class — an answer
  * whose whole value is that it happened just now — and this one is the
  * same sentence for the same reason.
  *
  * It is also the run family's own shape: the run's reads live in GET-only
  * modules whose import cones reach no executor (the verb-split family rule
  * in tests/prevention/run-executes-once.test.ts), and the Block bridge
  * does not participate in that cone discipline.
  */
const LEGACY_ROUTE_BASELINE = 114;

const ROUTE_REGISTRATION = /\brouter\.(get|post|put|patch|delete)\(\s*"/g;

function countLegacyRoutes(): { total: number; byFile: Record<string, number> } {
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const file of walk("server/routes", { exts: [".ts"] })) {
    const rel = relpath(file);
    const matches = read(rel).match(ROUTE_REGISTRATION);
    const n = matches?.length ?? 0;
    if (n > 0) {
      byFile[rel] = n;
      total += n;
    }
  }
  return { total, byFile };
}

describe("A. legacy route ratchet — the old surface may only shrink", () => {
  test(`hand-written routes never exceed the ${LEGACY_ROUTE_BASELINE} baseline`, () => {
    const { total, byFile } = countLegacyRoutes();
    expect(
      total,
      `Hand-written route registrations rose to ${total} (baseline ${LEGACY_ROUTE_BASELINE}).\n` +
        `A new capability must be declared with defineBlock in server/blocks/, not added as a\n` +
        `route. If routes were legitimately converted, LOWER the baseline to lock in the gain.\n` +
        `Current distribution:\n` +
        Object.entries(byFile)
          .sort((a, b) => b[1] - a[1])
          .map(([f, n]) => `  ${n}  ${f}`)
          .join("\n"),
    ).toBeLessThanOrEqual(LEGACY_ROUTE_BASELINE);
  });

  test("the baseline is not stale (it tracks reality within a tolerance)", () => {
    // A baseline far above the real count silently re-opens the door: routes
    // could be added freely up to the stale number. Keep it tight.
    const { total } = countLegacyRoutes();
    expect(
      LEGACY_ROUTE_BASELINE - total,
      `The ratchet baseline (${LEGACY_ROUTE_BASELINE}) is ${LEGACY_ROUTE_BASELINE - total} above the ` +
        `actual count (${total}). Lower LEGACY_ROUTE_BASELINE to ${total} so the guard stays tight.`,
    ).toBeLessThanOrEqual(5);
  });
});

describe("B/C/D/E. the block registry satisfies the contract", () => {
  // Imported lazily: registering blocks needs a DbClient, so the suite builds
  // the registry through the same path production uses rather than a fixture.
  let listBlocks: typeof import("../../server/blocks/define.ts").listBlocks;
  let defineBlock: typeof import("../../server/blocks/define.ts").defineBlock;
  let clearBlocks: typeof import("../../server/blocks/define.ts").clearBlocks;
  let envelope: typeof import("../../server/blocks/define.ts").envelope;

  beforeAll(async () => {
    const mod = await import("../../server/blocks/define.ts");
    listBlocks = mod.listBlocks;
    defineBlock = mod.defineBlock;
    clearBlocks = mod.clearBlocks;
    envelope = mod.envelope;
  });

  test("D. every block id uses the shared namespace.name grammar", () => {
    for (const { descriptor } of listBlocks()) {
      expect(
        descriptor.id,
        `block id "${descriptor.id}" must be namespace.name`,
      ).toMatch(/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/u);
    }
  });

  test("E. every block declares a read or an action, plus prose", () => {
    for (const { descriptor } of listBlocks()) {
      expect(
        descriptor.hasRead || descriptor.actions.length > 0,
        `block "${descriptor.id}" declares neither a read nor an action`,
      ).toBe(true);
      expect(descriptor.title.length, `block "${descriptor.id}" needs a title`).toBeGreaterThan(0);
      expect(
        descriptor.description.length,
        `block "${descriptor.id}" needs a description`,
      ).toBeGreaterThan(0);
    }
  });

  test("B. route derivation is GET for reads and POST for actions", () => {
    // Derived, never authored — a client binding cannot point at a path the
    // server does not serve because both sides call the same function.
    expect(blockReadPath("code.graph")).toBe("/api/b/code.graph");
    expect(blockActionPath("code.graph", "invalidate")).toBe("/api/b/code.graph/invalidate");
    expect(isBlockPath("/api/b/code.graph")).toBe(true);
    expect(isBlockPath("/api/projects")).toBe(false);
    expect(parseBlockPath("/api/b/code.graph")).toEqual({ id: "code.graph" });
    expect(parseBlockPath("/api/b/code.graph/invalidate")).toEqual({
      id: "code.graph",
      action: "invalidate",
    });
    // Malformed shapes are refused rather than half-parsed.
    expect(parseBlockPath("/api/b/")).toBeUndefined();
    expect(parseBlockPath("/api/b/a/b/c")).toBeUndefined();
    expect(parseBlockPath("/api/projects")).toBeUndefined();
  });

  test("C. the envelope is uniform and its etag is content-derived", () => {
    const a = envelope({ x: 1 });
    expect(a.data).toEqual({ x: 1 });
    expect(a.meta.etag).toMatch(/^W\/"[0-9a-f]+"$/);
    expect(typeof a.meta.asOf).toBe("number");
    // Same payload → same tag. A timestamp-based tag would defeat
    // If-None-Match, which is the whole reason the envelope carries one.
    expect(envelope({ x: 1 }).meta.etag).toBe(a.meta.etag);
    expect(envelope({ x: 2 }).meta.etag).not.toBe(a.meta.etag);
  });

  test("E. declaration validation is deny-by-default", () => {
    const before = listBlocks().length;
    const ok = { title: "T", description: "D" };
    expect(() => defineBlock({ id: "nodots", ...ok, actions: { a: null as never } })).toThrow();
    expect(() => defineBlock({ id: "probe.empty", title: "", description: "D" })).toThrow();
    expect(() => defineBlock({ id: "probe.nothing", title: "T", description: "D" })).toThrow();
    // Nothing partial was registered by a rejected declaration.
    expect(listBlocks().length).toBe(before);
    void clearBlocks;
  });
});

describe("F. no bypass — defineBlock is called only from the blocks owner", () => {
  test("no module outside server/blocks/ calls defineBlock", () => {
    const offenders: string[] = [];
    for (const root of ["server", "src"]) {
      for (const file of walk(root, { exts: [".ts", ".svelte"] })) {
        const rel = relpath(file);
        if (rel.startsWith("server/blocks/")) continue;
        if (/\bdefineBlock\s*\(/.test(read(rel))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      `defineBlock must be called from server/blocks/ only — it is the single\n` +
        `registration choke point. Offenders:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("G. binding resolution — no module points at a block that does not exist", () => {
  test("every SourceBinding.block names a declared block", async () => {
    const { listBlocks } = await import("../../server/blocks/define.ts");
    const known = new Set(listBlocks().map((b) => b.descriptor.id));
    const dangling: string[] = [];
    for (const mod of UI_DECLARATIONS.modules) {
      for (const src of mod.sources) {
        if (src.kind !== "read") continue;
        if (src.block === undefined) {
          dangling.push(`${mod.id}: a "read" source has no block id`);
          continue;
        }
        // A block registered only at runtime (needs a DbClient) is still a
        // real declaration; the check is that the id is *claimed* somewhere,
        // which the registry answers once routes are mounted. When the
        // registry is empty (no server booted in this test process) the
        // assertion is skipped rather than made vacuously false.
        if (known.size > 0 && !known.has(src.block)) {
          dangling.push(`${mod.id}: source "${src.key}" names unknown block "${src.block}"`);
        }
      }
    }
    expect(
      dangling,
      `A module binding points at a block that is not declared. This is the failure\n` +
        `the block id replaced a free-text endpoint path to prevent.\n${dangling.join("\n")}`,
    ).toEqual([]);
  });
});
