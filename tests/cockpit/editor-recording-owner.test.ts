// @vitest-environment node
/**
 * EDITOR RECORDING OWNER — a file change made in the editor room CANNOT be
 * unrecorded.
 *
 * The product's central claim is that every effect is recorded through choke
 * points, so recording is structurally unavoidable. An editor that wrote files
 * outside the recorder would be a hole straight through that claim: the ledger
 * would say a person opened the room and could not say what they did to the
 * code. (`recordFileEffect` shipped with ZERO production callers once already,
 * which is exactly how that hole appears.)
 *
 * What is proven here is the property for THIS surface, in two halves:
 *
 *   A. BEHAVIOURAL — every mutating door the room can reach, driven for real
 *      against a temp project, lands a `file-effect` in the real ledger with
 *      the right operation and the right path. Save, create, create-folder and
 *      delete.
 *
 *   B. STRUCTURAL, DENY-BY-DEFAULT — the room has no OTHER way to change a
 *      file. Every mutating door in `editor/feed.ts` is one of the four client
 *      functions below; each of those posts to a `/api/editor/*` route; each of
 *      those routes calls a bridge function; and every one of those bridge
 *      functions reaches the recorder. A fifth door, a direct `fetch`, or a
 *      route that stopped calling the bridge each fails this.
 *
 * The MUTATION the task asked for — bypass the recorder and show the guard
 * fails — is executed both ways: a write performed OUTSIDE the bridge records
 * nothing (proving the recording is a property of the choke point, not of the
 * call site), and a bridge source with the `recordFileEffect` call removed is
 * flagged by the structural scanner.
 *
 * (The bridge's own deny-by-default scan — "every function in the bridge that
 * mutates the filesystem also records" — lives in
 * tests/prevention/file-effect-recording.test.ts and is not repeated here.)
 */
import { beforeAll, describe, expect, test } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createDirectory,
  createFile,
  deleteFile,
  editFile,
  writeFileRaw,
} from "../../server/filesystem/editor-bridge.ts";
import { getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { read, stripCommentsAndStringsFor, stripCommentsOnly } from "../helpers/source-scan.ts";

const FEED = "src/cockpit/editor/feed.ts";
const CLIENT = "src/client.ts";
const ROUTE = "server/routes/editor.ts";
const BRIDGE = "server/filesystem/editor-bridge.ts";
const ROOM = "src/cockpit/rooms/EditorRoom.svelte";

/**
 * The four mutating doors the editor room has, as they are wired in the feed.
 * Each row is the whole chain: the feed's door, the client function it calls,
 * the route that function posts to, and the bridge function that route calls.
 * Every link is asserted below, so a chain that is re-pointed anywhere fails.
 */
const DOORS = [
  { door: "write", client: "editEditorFile", route: "/api/editor/edit", bridge: "editFile" },
  { door: "createFile", client: "createEditorFile", route: "/api/editor/create-file", bridge: "createFile" },
  { door: "createFolder", client: "createEditorFolder", route: "/api/editor/create-folder", bridge: "createDirectory" },
  { door: "remove", client: "deleteEditorFile", route: "/api/editor/delete", bridge: "deleteFile" },
] as const;

// ── A. BEHAVIOURAL: drive the real doors, read the real ledger ────────────

let root: string;

beforeAll(() => {
  // The temp-dir owner registers its own removal; there is no second half to
  // forget here (tests/helpers/temp-dir.ts).
  root = createTempDir("ch-editor-recording-");
  mkdirSync(join(root, "src"), { recursive: true });
});

/**
 * Every file effect the REAL ledger holds for `path`, oldest first.
 *
 * Read back through the public query, so this exercises the whole chain —
 * recorder, store, query — rather than a captured call argument. A test that
 * spied on the recorder would pass even if nothing reached the ledger.
 */
function effectsFor(path: string): readonly { operation: string; path: string }[] {
  const result = getTimelineQuery().byEventType("file-effect", { limit: 500, ascending: true });
  const out: { operation: string; path: string }[] = [];
  for (const event of result.events) {
    for (const doc of event.documents ?? []) {
      if (doc.name !== "effect" || typeof doc.contentJson !== "string") continue;
      const parsed = JSON.parse(doc.contentJson) as { path: string; operation: string };
      if (parsed.path === path) out.push(parsed);
    }
  }
  return out;
}

describe("A. every mutating door lands a real file effect in the real ledger", () => {
  test("the room's SAVE (the preimage-checked edit) is recorded as a write", () => {
    const abs = join(root, "src", "saved.ts");
    writeFileSync(abs, "before\n", "utf8");
    // The state before this save, so the assertion is about THIS effect.
    const before = effectsFor(abs).length;
    editFile(abs, "before\n", "after\n", root);
    const after = effectsFor(abs);
    // ONE effect: the edit reads the preimage (a read is not an effect) and
    // then performs exactly one write.
    expect(after.length, "a save that records nothing is the hole this guards").toBe(before + 1);
    expect(after.at(-1)!.operation).toBe("write");
    expect(readFileSync(abs, "utf8"), "…and the bytes really did change").toBe("after\n");
  });

  test("CREATE is recorded as a write", () => {
    const abs = join(root, "src", "made.ts");
    createFile(abs, "new file\n", root);
    const effects = effectsFor(abs);
    expect(effects.map((e) => e.operation)).toContain("write");
  });

  test("CREATE FOLDER is recorded as a mkdir", () => {
    const abs = join(root, "src", "made-dir");
    createDirectory(abs, root);
    expect(effectsFor(abs).map((e) => e.operation)).toContain("mkdir");
  });

  test("DELETE is recorded as a delete", () => {
    const abs = join(root, "src", "doomed.ts");
    writeFileSync(abs, "goodbye\n", "utf8");
    deleteFile(abs, root);
    expect(existsSync(abs), "the file is really gone").toBe(false);
    expect(effectsFor(abs).map((e) => e.operation)).toContain("delete");
  });

  test("a NESTED path is recorded at the path that actually changed", () => {
    mkdirSync(join(root, "src", "deep", "nested"), { recursive: true });
    const abs = join(root, "src", "deep", "nested", "reader.ts");
    writeFileRaw(abs, "nested content\n", root);
    const effects = effectsFor(abs);
    expect(effects.length, "the nested file's own path, not its folder's").toBeGreaterThan(0);
    expect(effects.at(-1)!.path).toBe(abs);
  });

  test("MUTATION: a write that BYPASSES the bridge records nothing", () => {
    // This is the failure mode the choke point exists to make impossible, and
    // the reason the room may not write files any other way: the same bytes,
    // written directly, leave the ledger silent.
    const abs = join(root, "src", "bypassed.ts");
    const before = effectsFor(abs).length;
    writeFileSync(abs, "written behind the recorder's back\n", "utf8");
    expect(
      effectsFor(abs).length,
      "recording is a property of the CHOKE POINT — a call site cannot supply it",
    ).toBe(before);
    // …and the same content through the bridge does record.
    writeFileRaw(abs, "written through the choke point\n", root);
    expect(effectsFor(abs).length).toBeGreaterThan(before);
  });
});

// ── B. STRUCTURAL: the room has no other way to change a file ─────────────

describe("B. the chain from the room to the recorder, link by link", () => {
  const feed = stripCommentsOnly(read(FEED));
  const client = stripCommentsOnly(read(CLIENT));
  const route = stripCommentsOnly(read(ROUTE));
  const bridge = stripCommentsAndStringsFor(read(BRIDGE), BRIDGE);

  test("the feed declares exactly the four mutating doors (no fifth)", () => {
    const block = /const LIVE_READERS: EditorReaders = \{([\s\S]*?)\n\};/.exec(feed);
    expect(block, "the feed must declare its doors in one place").not.toBeNull();
    const declared = [...block![1]!.matchAll(/^\s{2}([A-Za-z]+):/gm)].map((m) => m[1]!);
    // read-only doors + the four mutating ones, and nothing else.
    expect(declared.sort()).toEqual(
      ["createFile", "createFolder", "media", "probe", "read", "remove", "tree", "write"].sort(),
    );
  });

  for (const { door, client: clientFn, route: routePath, bridge: bridgeFn } of DOORS) {
    test(`${door} → ${clientFn} → ${routePath} → ${bridgeFn} → the recorder`, () => {
      // 1. the feed's door calls that client function
      const line = new RegExp(`${door}:\\s*\\([^)]*\\)\\s*=>\\s*${clientFn}\\(`).test(feed);
      expect(line, `the feed's \`${door}\` must call ${clientFn}`).toBe(true);
      // 2. that client function posts to that route
      const fn = new RegExp(
        `export async function ${clientFn}\\([\\s\\S]*?\\n\\}`,
      ).exec(client);
      expect(fn, `${clientFn} must exist in the client`).not.toBeNull();
      expect(fn![0]!, `${clientFn} must call ${routePath}`).toContain(
        routePath.replace("/api", ""),
      );
      // 3. the route calls that bridge function
      const handler = new RegExp(
        `router\\.[a-z]+\\("${routePath}",[\\s\\S]*?\\n  \\}\\);`,
      ).exec(route);
      expect(handler, `${routePath} must be registered`).not.toBeNull();
      expect(handler![0]!, `${routePath} must call the bridge's ${bridgeFn}`).toMatch(
        new RegExp(`\\b${bridgeFn}\\(`),
      );
      // 4. that bridge function reaches the recorder (directly, or through
      //    writeFileRaw, which does)
      const body = new RegExp(`export function ${bridgeFn}\\([\\s\\S]*?\\n\\}`).exec(bridge);
      expect(body, `${bridgeFn} must exist in the bridge`).not.toBeNull();
      expect(
        /recordFileEffect\(|writeFileRaw\(/.test(body![0]!),
        `${bridgeFn} must reach recordFileEffect — directly or via writeFileRaw`,
      ).toBe(true);
    });
  }

  test("`writeFileRaw` — the write everything funnels into — records", () => {
    const body = /export function writeFileRaw\([\s\S]*?\n\}/.exec(bridge);
    expect(body).not.toBeNull();
    expect(body![0]!).toContain("recordFileEffect(");
  });

  test("MUTATION: a writeFileRaw with the recorder removed is FLAGGED", () => {
    // The mutation, performed on the source text: take the recording call out
    // and show the assertion above goes red. A guard that cannot fail proves
    // nothing, and this project has found three of those already.
    const real = /export function writeFileRaw\([\s\S]*?\n\}/.exec(bridge);
    expect(real, "the function must be found before it can be mutated").not.toBeNull();
    expect(real![0]!.includes("recordFileEffect("), "the real source records").toBe(true);
    // Take the recording call OUT of that function's body and re-run the same
    // assertion the guard above makes.
    const mutated = real![0]!.replace(/recordFileEffect\(\{[\s\S]*?\}\);/, "");
    expect(
      mutated.includes("recordFileEffect("),
      "with the call removed the scanner must report it missing",
    ).toBe(false);
  });

  test("no editor source reaches the filesystem or the network on its own", () => {
    for (const file of [
      FEED,
      "src/cockpit/rooms/EditorRoom.svelte",
      "src/cockpit/editor/save.ts",
      "src/cockpit/editor/buffer.ts",
      "src/cockpit/editor/FilePane.svelte",
      "src/cockpit/editor/FileTree.svelte",
    ]) {
      const src = stripCommentsAndStringsFor(read(file), file);
      expect(src, `${file} must not call fetch — src/client.ts is the one I/O owner`).not.toMatch(
        /(?<![\w.])fetch\s*\(/,
      );
      expect(src, `${file} must not open an EventSource`).not.toMatch(/new\s+EventSource\s*\(/);
      expect(src, `${file} must not reach node:fs`).not.toMatch(/node:fs/);
    }
  });

  test("the room's mutating calls all go through the feed's doors", () => {
    const room = stripCommentsAndStringsFor(read(ROOM), ROOM);
    // The room may name the feed's own functions and nothing lower.
    for (const clientFn of DOORS.map((d) => d.client)) {
      expect(
        room,
        `the room must not call ${clientFn} directly — it goes through editor/feed.ts`,
      ).not.toContain(clientFn);
    }
    for (const doorFn of ["createFileAt", "createFolderAt", "removePath", "saveWriter"]) {
      expect(room, `the room reaches the ${doorFn} door`).toContain(doorFn);
    }
  });
});
