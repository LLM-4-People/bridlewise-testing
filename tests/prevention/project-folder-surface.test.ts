// @vitest-environment node
/**
 * Prevention: the missing-project-folder surface is WIRED, not decorative.
 *
 * The feature spans three surfaces that must agree, or the badge lies:
 *
 *   1. THE SERVER MEASURES. `projectFolderPresence` (fs-gate.ts — the
 *      filesystem access owner) is the ONLY probe; the project view mapper
 *      (views.ts) calls it on every read; the answer is a field on the
 *      wire, never a client-side guess.
 *   2. THE CLIENT CARRIES IT. `ProjectSummary.folder` is the client-side
 *      authority; `updateProjectPath` (the relink write) applies the
 *      PATCH response's re-measured presence to the store, so a relink
 *      that fixed the folder clears the badge from the SAME answer.
 *   3. THE SURFACES RENDER IT. The Switch cap badge, the chat band
 *      (Cockpit), and the relink verb all read the SAME field — a surface
 *      that probed the filesystem itself, or read a different field,
 *      would disagree with the others.
 *
 * Mutation-verified: deleting the probe from the view mapper, or the badge
 * read from a surface, or the store update from the relink write, turns an
 * arm RED.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const read = (p: string) => readFileSync(p, "utf8");

describe("the server measures, at the owner", () => {
  test("the probe lives in the filesystem access owner, and ONLY there", () => {
    const gate = read(modulePath("fs-gate.ts"));
    expect(gate).toMatch(/export function projectFolderPresence\b/);
    // No second probe re-implements a stat-and-classify over a project path.
    // (The projects route + the view mapper consume the owner; they must not
    // stat the path themselves.)
    const views = read(modulePath("views.ts"));
    expect(views).toMatch(/\bprojectFolderPresence\(/);
    expect(views).not.toMatch(/\bstatSync\(/);
    const route = read(modulePathMatching("server/routes/projects.ts"));
    expect(route).toMatch(/\bprojectFolderPresence\(/);
    expect(route).not.toMatch(/\bstatSync\(/);
  });

  test("the project view carries the measured presence on every read", () => {
    const views = read(modulePath("views.ts"));
    // The mapper takes the answer from the probe — a mapper that dropped the
    // field would leave the client with nothing honest to render.
    const mapper = /export function projectToView\([^)]*\)\s*:\s*ProjectView\s*\{([\s\S]*?)\n\}/.exec(views);
    expect(mapper, "projectToView must exist").not.toBeNull();
    expect(mapper![1]).toMatch(/folder:\s*projectFolderPresence\(/);
  });
});

describe("the client carries it", () => {
  test("ProjectSummary declares the folder presence field", () => {
    const state = read(modulePathMatching("src/state/projects.ts"));
    expect(state).toMatch(/folder\?:\s*"present"\s*\|\s*"missing"\s*\|\s*"unreadable"/);
  });

  test("the relink write applies the response's re-measured presence to the store", () => {
    const client = read(modulePathMatching("src/client.ts"));
    // updateProjectPath must hand the returned folder presence to the store —
    // otherwise the badge would clear only on a later full refetch (or never).
    const fn = /export async function updateProjectPath\([\s\S]*?\n\}/.exec(client);
    expect(fn, "updateProjectPath must exist").not.toBeNull();
    expect(fn![0]).toMatch(/updateProjectInStore\(/);
    // The INERT shape: the folder field must actually be passed through, not
    // merely mentioned. `updateProjectInStore(id, { path, updatedAt })` with
    // `folder` dropped leaves the badge stale — the field's NAME in the call
    // is the evidence the new path produces.
    expect(fn![0]).toMatch(/folder:\s*updated\.folder/);
  });
});

describe("the surfaces render the SAME field", () => {
  test("the Switch cap badge + relink verb read the project row's folder field", () => {
    const room = read("src/cockpit/rooms/SwitchRoom.svelte");
    expect(room).toMatch(/cap\.project\.folder\s*===\s*"missing"/);
    expect(room).toContain('data-verb-id="switch.relink"');
    // The relink calls the one write owner.
    expect(room).toMatch(/\bupdateProjectPath\(/);
  });

  test("the chat band reads the active project's folder field", () => {
    const cockpit = read("src/cockpit/Cockpit.svelte");
    expect(cockpit).toMatch(/\$currentProject\?\.folder/);
    expect(cockpit).toContain('data-verb-id="project.relink"');
    // The band is honest about both abnormal states.
    expect(cockpit).toMatch(/"missing"\s*\|\|\s*activeFolder\s*===\s*"unreadable"/);
  });

  test("the relink verb opens the Switch, where the picker lives", () => {
    const cockpit = read("src/cockpit/Cockpit.svelte");
    // The band's relink opens the Switch room (the picker's home), rather
    // than mounting a second picker — one picker, one owner.
    const band = /data-verb-id="project\.relink"[\s\S]{0,300}/.exec(cockpit);
    expect(band).not.toBeNull();
    expect(band![0]).toMatch(/openRoomById\("switch"\)/);
  });
});
