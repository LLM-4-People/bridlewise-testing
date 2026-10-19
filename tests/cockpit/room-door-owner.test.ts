// @vitest-environment node
/**
 * EVERY DECLARED ROOM HAS A DOOR, AND EVERY DOOR HAS A DECLARED ROOM.
 *
 * ── THE DEFECT, WHICH WAS LIVE ────────────────────────────────────────────
 *
 * `RoomId` declared `"memory"` and `"tools"`. Neither `MemoryRoom.svelte` nor
 * `ToolsRoom.svelte` had ever been written. The shell's discovery glob simply
 * did not match them, `roomExists` answered false, the shell rendered its
 * honest "not built yet" state — and every one of the nine consumer tests
 * STUBBED `roomExists`, so the suite was green over two rooms that could never
 * open. Two of seven declared rooms were permanently dead and no instrument in
 * the repository said so.
 *
 * A stub is what made it invisible. A guard that asks a stubbed `roomExists`
 * is asking the test what the test already believes, so this file is built the
 * other way round: three independently-sourced answers to "which rooms are
 * there", and all three must agree.
 *
 *   1. the DECLARATION — `RoomId`'s members, parsed from `contract.ts`'s bytes;
 *   2. the FILESYSTEM — `<Id>Room.svelte` under the rooms directory, walked
 *      through the shared scan helper, which refuses a universe smaller than
 *      the git index rather than returning a short list;
 *   3. the SHELL'S OWN ANSWER — the real `roomExists`, imported unstubbed, so
 *      the Vite glob that production actually depends on is exercised.
 *
 * Two instruments could agree while both being wrong about what the shell will
 * do at runtime; the third is the one that cannot be faked, and it is also the
 * only floor the glob has ever had.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { loadRoom, outletExists, roomExists, OUTLET_IDS } from "../../src/cockpit/shell/outlets.ts";
import { walk } from "../helpers/source-scan.ts";

const CONTRACT = "src/cockpit/shell/contract.ts";
const OUTLETS = "src/cockpit/shell/outlets.ts";
const ROOMS_DIR = "src/cockpit/rooms";

/**
 * The `RoomId` union's members, from the declaration's own bytes.
 *
 * Read as bytes and matched on the union body only — a scan that took every
 * quoted string in the file would collect half the shell's vocabulary and
 * agree with anything.
 */
function declaredRoomIds(): readonly string[] {
  const source = readFileSync(CONTRACT, "utf8");
  const declaration = /export type RoomId =([\s\S]*?);/u.exec(source);
  if (declaration === null) {
    throw new Error(
      `${CONTRACT} no longer declares \`export type RoomId =\`. The declaration is this guard's ` +
      `universe; a rename that this file cannot follow makes it certify nothing.`,
    );
  }
  const ids = [...(declaration[1] ?? "").matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? "");
  if (ids.length === 0) {
    throw new Error(`${CONTRACT} declares RoomId with no members; an empty union agrees with everything.`);
  }
  return ids;
}

/** The room ids the filesystem offers, by the `<Id>Room.svelte` convention. */
function builtRoomIds(): readonly string[] {
  return walk(ROOMS_DIR, { exts: [".svelte"] })
    .map((file) => basename(file))
    .filter((name) => name.endsWith("Room.svelte"))
    .map((name) => {
      const id = name.slice(0, -"Room.svelte".length);
      return id.charAt(0).toLowerCase() + id.slice(1);
    })
    .sort();
}

/**
 * The `OutletId` union's members, from the declaration's own bytes — the
 * SECOND instrument for the outlet half, exactly as `declaredRoomIds` is for
 * rooms.
 *
 * THE HAND-WRITTEN LITERAL THAT USED TO SIT HERE WAS THE DEFECT. It read
 * `const OUTLET_IDS: readonly OutletId[] = ["flow", …]`, and a subset array
 * satisfies that type, so a seventh outlet added to the union — component or
 * no component — left this guard at six passed and `tsc` at zero errors. A
 * declaration with nothing behind it, inside the guard written to end them.
 */
function declaredOutletIds(): readonly string[] {
  const source = readFileSync(OUTLETS, "utf8");
  const declaration = /export type OutletId =([\s\S]*?);/u.exec(source);
  if (declaration === null) {
    throw new Error(
      `${OUTLETS} no longer declares \`export type OutletId =\`. The declaration is this ` +
      `guard's universe; a rename it cannot follow makes it certify nothing.`,
    );
  }
  const ids = [...(declaration[1] ?? "").matchAll(/"([^"]+)"/gu)].map((m) => m[1] ?? "");
  if (ids.length === 0) {
    throw new Error(`${OUTLETS} declares OutletId with no members; an empty union agrees with everything.`);
  }
  return ids;
}

describe("a declared room and a real door are the same set", () => {
  test("the two instruments are both live before either is believed", () => {
    // POPULATION, as runtime numbers. Either side coming back empty would make
    // the set comparison below pass for the wrong reason.
    const declared = declaredRoomIds();
    const built = builtRoomIds();
    expect(declared.length).toBeGreaterThan(0);
    expect(built.length).toBeGreaterThan(0);
    // And they were not read the same way: one is a type declaration, the
    // other is a directory listing.
    expect(built).toContain("switch");
    expect(declared).toContain("switch");
  });

  test("no declared room is missing its component", () => {
    const declared = declaredRoomIds();
    const built = new Set(builtRoomIds());
    const doorless = declared.filter((id) => !built.has(id));
    expect(
      doorless,
      `${doorless.length} of ${declared.length} declared rooms have no component under ` +
        `${ROOMS_DIR}: ${doorless.join(", ")}. \`openRoom\` accepts these ids, so the type says a ` +
        `caller may summon a surface that can only render "not built yet". Either create ` +
        `<Id>Room.svelte, or delete the id.`,
    ).toEqual([]);
  });

  test("no component is missing its declaration", () => {
    // The direction that arrives with a NEW room: the file lands, nothing
    // references it, and it is unreachable because no id names it.
    const declared = new Set(declaredRoomIds());
    const built = builtRoomIds();
    const undeclared = built.filter((id) => !declared.has(id));
    expect(
      undeclared,
      `${undeclared.length} of ${built.length} room components are not declared in \`RoomId\`: ` +
        `${undeclared.join(", ")}. A component nothing can name is a room nothing can open; add ` +
        `the id to the union in ${CONTRACT}.`,
    ).toEqual([]);
  });

  test("THE REAL GLOB agrees, and it is not a stub", () => {
    // The anti-stub half, and the only floor the discovery glob has. Nine
    // consumer tests replace `roomExists` with a fake; this one imports the
    // shell's own module and asks it, so an empty glob — a moved directory, a
    // renamed convention, a Vite change — reds here instead of quietly making
    // every room "not built yet".
    const declared = declaredRoomIds();
    const missing = declared.filter((id) => !roomExists(id));
    expect(
      missing,
      `the shell's own discovery answers "not built" for ${missing.length} declared room(s): ` +
        `${missing.join(", ")}. The filesystem and the declaration can agree while the glob that ` +
        `production depends on matches nothing.`,
    ).toEqual([]);

    // NEGATIVE CONTROL, supplied from outside: a name no room has must come
    // back false, otherwise the check above is satisfied by a function that
    // says yes to everything.
    expect(roomExists("definitelyNotARoom")).toBe(false);
  });

  test("every declared room actually loads a component", () => {
    // `roomExists` and `loadRoom` read the same map, so agreement is cheap —
    // but a room whose loader resolves to a module with no default export is a
    // room that fails at the reveal, and only awaiting it can say so.
    return Promise.all(
      declaredRoomIds().map(async (id) => {
        const component = await loadRoom(id);
        expect(component, `loadRoom("${id}") resolved to nothing`).not.toBeNull();
      }),
    ).then(async () => {
      // The same call for a room that does not exist answers null rather than
      // throwing — the honest absence the shell renders around.
      expect(await loadRoom("definitelyNotARoom")).toBeNull();
    });
  });

  test("the outlet population is the union itself, agreed by two instruments", () => {
    // The bytes of the declaration, and the keys of the `Record<OutletId, …>`
    // the compiler forces to be complete. Neither is a list anyone maintains,
    // and a new member that reaches only one of them is a disagreement rather
    // than a silently smaller universe.
    const declared = [...declaredOutletIds()].sort();
    const exported = [...OUTLET_IDS].sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(exported, "the exported ids must be exactly the union's members").toEqual(declared);
  });

  test("every declared OUTLET is built, by the same rule", () => {
    // The rooms glob was the one already firing, but it is one of six in that
    // module and the other five had no floor either. A single-file glob that
    // stops matching disables its outlet in silence.
    const missing = OUTLET_IDS.filter((id) => !outletExists(id));
    expect(
      missing,
      `${missing.length} of ${OUTLET_IDS.length} declared outlets have no component: ` +
        `${missing.join(", ")}. Each is a single-file glob; when it stops matching the outlet ` +
        `renders "not built yet" and nothing else changes.`,
    ).toEqual([]);
    expect(OUTLET_IDS.length).toBeGreaterThan(0);
  });
});
