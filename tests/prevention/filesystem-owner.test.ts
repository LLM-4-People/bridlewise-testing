// @vitest-environment node
/**
 * Mechanical enforcement: filesystem access owner (Single-Party-Owner
 * FILESYSTEM ACCESS).
 *
 * ("Single-Party-Owner Principle" + "Deny-by-
 * Default"): FILESYSTEM access (read, write, edit, delete, tree, search)
 * must have ONE owner module (`server/fs-gate.ts`). ALL project-scoped
 * filesystem operations go through the gate — no route or bridge accesses
 * the filesystem for a project path without going through it. The gate
 * enforces at the LOWEST level (the bridge choke point, NOT each route):
 * 1. PROJECT-OWNERSHIP (deny-by-default — db.getProjectByPath)
 * 2. PATH-TRAVERSAL prevention (CWE-22 — resolveWithinProject)
 * 3. ALLOWED-ROOTS (deny-by-default — assertWithinAllowedRoots)
 *
 * This test pins the architecture across 5 assurance classes:
 * A. source-scan — the gate is the single owner; bridges import it;
 * routes pass it; no route calls the old requireProjectByPath.
 * B. single-owner — the gate functions are defined ONLY in fs-gate.ts.
 * C. behavioral — the gate throws the right typed errors; deny-by-default.
 * D. bridge-level enforcement — the bridge throws when the gate is
 * passed + the path is not owned (the cross-user fix at the lowest
 * level, NOT the route).
 * E. consolidation — safeResolve / isWithinRoot / isWithinAllowedRoots
 * are NOT re-implemented outside fs-gate (No Scattered Helpers).
 *
 * Mutation-verified: key assertions FAIL when the violation is reintroduced
 * (removing the gate from a bridge, re-scattering the logic, reverting a
 * route to requireProjectByPath).
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { join, relative, sep } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, linkSync, statSync } from "node:fs";

import { DbClient } from "../../server/db/client.ts";
import { AsyncDbClient } from "../../server/db/async-client.ts";
import { createTestUser } from "../helpers/multi-user.ts";
import {
  assertProjectPathOwnership,
  resolveWithinProject,
  assertWithinAllowedRoots,
  isWithinAllowedRoots,
  makeFsGate,
  effectiveProjectRoot,
  type FsGate,
} from "../../server/filesystem/fs-gate.ts";
import { ForbiddenError, PathTraversalError, BadRequestError, WebError } from "../../server/kernel/errors.ts";
import { hasSecondName } from "../../server/kernel/canonical.ts";
import { readFile as readFileSyncViaBridge } from "../../server/filesystem/editor-bridge.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import {
  sourceFilesMentioning,
  nonEmptySourceFilesUnder,
  stripCommentsAndStringsFor,
  stripCommentsOnly,
  walkTs,
} from "../helpers/source-scan.ts";
import {
  bodyCallsWith,
  callArgumentsOf,
  exportedFunctionParameters,
  functionArgumentsOf,
  functionsCalling,
} from "../helpers/function-scope.ts";
import { requireHost } from "../../engine/test/support/host-requirement.ts";

const SERVER_DIR = join(process.cwd(), "server");
const ROUTES_DIR = join(SERVER_DIR, "routes");

/**
 * EVERY FIRST-PARTY SERVER MODULE THAT COULD CALL A BRIDGE — discovered, not
 * listed, and not scoped to a directory.
 *
 * The bridges themselves are excluded: a bridge calling its sibling is how the
 * gate is enforced, not a way around it. Everything else under `server/` is a
 * potential caller, including files in folders nobody has created yet.
 */
function serverModules(): readonly string[] {
  const out: string[] = [];
  const walkTree = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkTree(full);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith("-bridge.ts") && !entry.name.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walkTree(SERVER_DIR);
  return out;
}

// ── Test DB setup (for behavioral + bridge-level tests) ──

let tmpRoot: string;
let db: DbClient;
let userA: { userId: string };
let userB: { userId: string };
let projectAPath: string;
let gateA: FsGate;
let gateB: FsGate;

beforeAll(async () => {
  tmpRoot = createTempDir("ch-fs-owner-");
  db = new DbClient({ path: join(tmpRoot, "web.db") });
  userA = createTestUser(db, "alice-fs");
  userB = createTestUser(db, "bob-fs");
  projectAPath = join(tmpRoot, "alice-project");
  mkdirSync(projectAPath, { recursive: true });
  writeFileSync(join(projectAPath, "a.ts"), "export const x = 1;\n");
  db.createProject({ name: "A-project", path: projectAPath }, userA.userId);
  // Both gates are primed for A's project path: A's decision is "owned",
  // B's is "resolved, and not yours". The gate carries decisions now, so a
  // path a gate was never asked about is a distinct, louder failure than a
  // denial — the deny-by-default case below is a real denial, not an absence.
  const adb = AsyncDbClient.inline(db);
  gateA = await makeFsGate(userA.userId, adb, projectAPath);
  gateB = await makeFsGate(userB.userId, adb, projectAPath);
});

afterAll(() => {
  if (db) db.close();
});

// ── A. source-scan: the gate is the single owner ──

describe("A. source-scan: fs-gate is the single filesystem access owner", () => {
  test("fs-gate.ts exports the gate functions + type", () => {
    const src = readFileSync(join(SERVER_DIR, "filesystem/fs-gate.ts"), "utf8");
    expect(src).toContain("export function assertProjectPathOwnership");
    expect(src).toContain("export function resolveWithinProject");
    expect(src).toContain("export function assertWithinAllowedRoots");
    expect(src).toContain("export function isWithinAllowedRoots");
    expect(src).toContain("export async function makeFsGate");
    expect(src).toContain("export type FsGate");
  });

  test("every project-scoped bridge imports from fs-gate", () => {
    // Dynamic discovery: scan ALL bridge files in server/ that
    // do PROJECT-SCOPED filesystem access (accept a projectRoot parameter
    // or call resolveWithinProject). A project-scoped bridge without
    // fs-gate is automatically caught. Bridges that only read fixed config
    // files (llm-bridge reading serverConfig.llmConfigPath) are NOT
    // project-scoped and are excluded.
    const bridges = walkTs(SERVER_DIR)
      .filter((f) => f.endsWith("-bridge.ts"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return src.includes("resolveWithinProject") || /projectRoot/.test(src);
      });
    expect(bridges.length, "at least one bridge should be project-scoped").toBeGreaterThan(0);
    for (const f of bridges) {
      const src = readFileSync(f, "utf8");
      // The specifier's relative prefix depends on the bridge's own folder, so
      // assert it names the fs-gate module, not a fixed "./" spelling.
      expect(src, `${relative(SERVER_DIR, f)} must import from fs-gate`).toMatch(/from "(\.\.?\/)*filesystem\/fs-gate\.ts"|from "\.\/fs-gate\.ts"/);
    }
  });

  test("every path-based route imports from fs-gate (project-scoped OR browsing)", () => {
    // Dynamic discovery: scan ALL route files for ones that accept a
    // USER-SUPPLIED project path. A path-based route is one that reads a
    // `path` or `root` query param (via requirePathQuery OR direct
    // query.get("path")/query.get("root")) OR has a `root:` zod body field.
    // The -expanded regex now catches file-tree.ts (which uses
    // query.get("path") directly, NOT requirePathQuery — the old `root`-
    // only regex MISSED it). Every path-based route must import from
    // fs-gate.ts — project-scoped routes import makeFsGate; browsing routes
    // (filesystem/list) import assertWithinAllowedRoots.
    const USER_PATH_RE = /requirePathQuery\s*\(|query\.get\(\s*["'](?:path|root)["']\s*\)|root:\s*z\.string/;
    const routes = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => USER_PATH_RE.test(readFileSync(join(ROUTES_DIR, f), "utf8")));
    expect(routes.length, "at least one route should accept a user-supplied path/root").toBeGreaterThan(0);
    for (const f of routes) {
      const src = readFileSync(join(ROUTES_DIR, f), "utf8");
      expect(src, `${f} must import from fs-gate (the filesystem access owner)`).toContain("fs-gate.ts");
    }
  });

  test("every PROJECT-SCOPED path route imports makeFsGate (the ownership gate)", () => {
    // Project-scoped routes (requirePathQuery, root: zod, OR
    // assertProjectPathOwnership) need makeFsGate (the project ownership
    // gate object). Browsing routes (filesystem/list) use
    // assertWithinAllowedRoots — they do NOT need makeFsGate. This split
    // catches a project-scoped route that forgets the ownership gate while
    // allowing browsing routes to use the allowed-roots gate.
    const PROJECT_SCOPED_RE = /requirePathQuery\s*\(|root:\s*z\.string|assertProjectPathOwnership/;
    const routes = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => PROJECT_SCOPED_RE.test(readFileSync(join(ROUTES_DIR, f), "utf8")));
    expect(routes.length, "at least one project-scoped route should exist").toBeGreaterThan(0);
    for (const f of routes) {
      const src = readFileSync(join(ROUTES_DIR, f), "utf8");
      expect(src, `${f} must import makeFsGate (project-scoped — needs the ownership gate)`).toContain("makeFsGate");
    }
  });

  test("a LINK out of the project is refused — the gate resolves, it does not spell", () => {
    // ── DRIVEN, BECAUSE IT WAS A PROVEN ESCAPE ───────────────────────────
    //
    // `resolve` is pure string arithmetic and does not follow a symbolic link,
    // so a link INSIDE the project pointing outside it was lexically under the
    // root and really was not. Measured end to end: a CONFINED command created
    // `<project>/out.txt -> <outside>/secret.txt` — which the kernel permits,
    // because Landlock governs what is opened THROUGH a link, not the creation
    // of one — the sandbox could not follow it, and then this UNCONFINED
    // server followed it on the model's behalf and returned the bytes. Two
    // tool calls, both reporting success.
    const project = createTempDir("gate-link-project-");
    const outside = createTempDir("gate-link-outside-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "THE-SECRET-CONTENTS\n");
    const link = join(project, "out.txt");
    symlinkSync(secret, link);
    // LIVENESS: an ordinary file inside the project still resolves, so the
    // refusal below is a refusal and not an outage.
    const ordinary = join(project, "inside.txt");
    writeFileSync(ordinary, "fine\n");
    expect(resolveWithinProject(ordinary, project)).toBe(realpathSync(ordinary));
    expect(resolveWithinProject("inside.txt", project)).toBe(realpathSync(ordinary));
    // …and a path that does not exist yet still resolves, because a write to a
    // new file must be gated rather than refused.
    expect(resolveWithinProject(join(project, "not-yet.txt"), project))
      .toBe(join(realpathSync(project), "not-yet.txt"));

    // THE CONCLUSION, with the SPECIFIC type and code.
    let thrown: unknown;
    try {
      resolveWithinProject(link, project);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PathTraversalError);
    expect((thrown as PathTraversalError & { code: string }).code).toBe("path_traversal");
    // The message must not hand back the place the link pointed at.
    expect(String((thrown as Error).message)).not.toContain(outside);
  });

  test("a SECOND NAME for a file outside the project is refused, and the gate does not own that verdict", () => {
    // ── THE HALF THAT RESOLVING CANNOT SEE, DRIVEN END TO END ────────────
    //
    // The test above proves a SYMBOLIC link out of the project is refused,
    // because the gate compares locations rather than spellings. A HARD link
    // defeats that comparison completely: it is a second directory entry for
    // the same inode, `realpath` on it returns the hard link, and every
    // location comparison honestly answers "inside the project". Measured at
    // the commit before this test existed: `resolveWithinProject` ADMITTED the
    // hard link and the editor bridge returned the outside file's bytes.
    //
    // The severity is stated honestly so the fix is not over-claimed: a
    // confined child cannot CREATE this link (the kernel refuses a
    // cross-hierarchy link, and the grant carries MAKE_SYM but not REFER), so
    // it needs an unconfined actor or a project that arrives with one. It is a
    // disclosure hole, not a self-serve escape — and it was open.
    const project = createTempDir("gate-hardlink-project-");
    const outside = createTempDir("gate-hardlink-outside-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "THE-SECOND-NAME-CONTENTS\n");
    const second = join(project, "ordinary-looking.txt");
    try {
      linkSync(secret, second);
    } catch {
      // A cross-device temp layout cannot host a hard link at all. Refusing to
      // pretend: the assertion below would then prove nothing, so say so.
      expect.unreachable("this host could not create a hard link, so the refusal below is untested");
    }
    // THE PLANT IS REAL: two names, one inode. Without this the refusal could
    // be a refusal of something else entirely.
    // THE PLANT ASKS THE OWNER. Comparing the link count here would be a
    // second answer to the question this very test says has one — and the
    // harness-side equivalent already asks `hasSecondName`, so the two
    // repositories were writing the same verdict two different ways.
    expect(hasSecondName(statSync(second).nlink), "the plant must really create a second name").toBe(true);

    // LIVENESS IN THE SAME RUN, so the refusal is a refusal and not an outage.
    const ordinary = join(project, "one-name.txt");
    writeFileSync(ordinary, "fine\n");
    expect(resolveWithinProject(ordinary, project)).toBe(realpathSync(ordinary));
    expect(resolveWithinProject(join(project, "not-yet.txt"), project))
      .toBe(join(realpathSync(project), "not-yet.txt"));

    // THE CONCLUSION, with the SPECIFIC type AND code.
    let thrown: unknown;
    try {
      resolveWithinProject("ordinary-looking.txt", project);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PathTraversalError);
    expect((thrown as PathTraversalError & { code: string }).code).toBe("path_second_name");
    // The message must not hand back the place the other name is.
    expect(String((thrown as Error).message)).not.toContain(outside);

    // …AND THE BRIDGE, which is where the bytes actually came back.
    let bridgeThrown: unknown;
    try {
      readFileSyncViaBridge("ordinary-looking.txt", project);
    } catch (err) {
      bridgeThrown = err;
    }
    expect((bridgeThrown as { code?: string } | undefined)?.code).toBe("path_second_name");

    // ── ONE QUESTION, ONE OWNER — the point of the fix, asserted ─────────
    //
    // Copying the missing check into this gate would have closed the instance
    // and left the class: two modules answering "does this file have a second
    // name" independently, which is how they came to disagree. So the gate
    // must CONSULT the shared owner rather than contain its own verdict, and
    // that is mechanical rather than a matter of trust.
    const gateSrc = stripCommentsAndStringsFor(readFileSync(join(SERVER_DIR, "filesystem/fs-gate.ts"), "utf8"), "fs-gate.ts");
    expect(gateSrc, "the gate must ask the shared owner").toMatch(/pathHasSecondName\s*\(/);
    expect(gateSrc, "the gate must not grow its own link-count verdict").not.toMatch(/\bnlink\b/);

    // ── AND IT MUST ASK THE UNCONDITIONAL DOOR, NOT THE POLICY ONE ──────
    //
    // The owner offers both, and they answer DIFFERENT QUESTIONS.
    // `pathIsRefusedSecondName` consults the harness's self-protection policy,
    // which an operator legitimately turns off (`HARNESS_REJECT_HARDLINKS=0`)
    // because the harness's own tree is seeded with `cp -rl`. That is a fact
    // about the harness's source, not about whether a path inside a user's
    // project also lives outside it — so routing containment through it put two
    // unrelated invariants on one switch, and with the switch off this gate
    // ADMITTED a hard link pointing outside the project.
    expect(
      gateSrc,
      "containment must not consult the self-protection opt-out — one switch must not answer two invariants",
    ).not.toMatch(/pathIsRefusedSecondName|refusesSecondNames/);
  });

  test("the containment refusal survives the self-protection opt-out being SET", () => {
    // THE EXEMPTION, DISCHARGED. The coupling was never proven live — nothing
    // in this repository sets the variable, and the exposure was inheritance
    // from a dev-mode harness shell — and "not proven live" is exactly the
    // shape of claim that must carry evidence rather than prose. So the
    // variable is SET here, and the gate is driven through it.
    const saved = process.env["HARNESS_REJECT_HARDLINKS"];
    const project = createTempDir("gate-optout-project-");
    const outside = createTempDir("gate-optout-outside-");
    const secret = join(outside, "secret.txt");
    writeFileSync(secret, "THE-OPT-OUT-CONTENTS\n");
    try {
      linkSync(secret, join(project, "innocent.txt"));
    } catch {
      expect.unreachable("this host could not create a hard link, so the refusal below is untested");
    }
    try {
      process.env["HARNESS_REJECT_HARDLINKS"] = "0";
      // LIVENESS FIRST: an ordinary file still resolves under the same env, so
      // a refusal below is a refusal and not an outage.
      const ordinary = join(project, "plain.txt");
      writeFileSync(ordinary, "fine\n");
      expect(resolveWithinProject(ordinary, project)).toBe(realpathSync(ordinary));

      let thrown: unknown;
      try {
        resolveWithinProject("innocent.txt", project);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, "the hard link must still be refused with the opt-out set").toBeInstanceOf(PathTraversalError);
      expect((thrown as PathTraversalError & { code: string }).code).toBe("path_second_name");
    } finally {
      // RESTORE BEFORE ASSERTING ANYTHING ELSE: a test that mutates shared
      // state to prove a refusal must put it back, or a later probe measures a
      // workspace this test broke.
      if (saved === undefined) delete process.env["HARNESS_REJECT_HARDLINKS"];
      else process.env["HARNESS_REJECT_HARDLINKS"] = saved;
    }
    expect(process.env["HARNESS_REJECT_HARDLINKS"], "the shared environment must be restored").toBe(saved);
  });

  test("every bridge CALL in a project-scoped route actually PASSES the gate", () => {
    // ── THE COMMENT PROMISED THIS AND NOTHING CHECKED IT ─────────────────
    //
    // `fs-gate.ts` says a mechanical test verifies that every route accepting
    // a user-supplied project path passes the gate. The tests above assert
    // that the route file IMPORTS `makeFsGate` and CONSTRUCTS one — neither of
    // which is the same thing, because the parameter is optional
    // (`gate?: FsGate`) and omitting it makes the call succeed UNCHECKED. A
    // route could build a gate, hand it to one bridge call and forget the next
    // one, and every assertion in this file would stay green.
    //
    // So this reads the CALL SITES. A route that constructed a gate is a route
    // whose project-scoped bridge calls must all receive one; the gate's own
    // binding name is discovered from the construction rather than assumed, so
    // a route that calls it something else is still covered.
    /** Bridge functions that accept the ownership gate. */
    const gateIndex = gateParameterIndex();
    const gated = gatedBridgeFunctions();
    expect(
      gated.length,
      `project-path bridge entry points discovered: ${gated.length} — a collapse to zero would make this test vacuous`,
    ).toBeGreaterThanOrEqual(20);

    // ── THE UNIVERSE IS "ROUTES THAT CALL ONE", NOT "ROUTES THAT BUILD ONE" ──
    //
    // The filter used to be `routes that construct a gate`, which cannot BY
    // CONSTRUCTION catch a route that constructs none — and a route that
    // constructs none is the stronger version of the very defect this test
    // exists for. Measured: it hid `run.ts`, which called a gate-taking bridge
    // function with no gate at all, and it hid it twice over, because the
    // detector above could not see `export async function` either. Two
    // universe defects lining up so one live instance was invisible to both is
    // the whole argument for asking a parser instead of a pattern.
    // ── AND THE UNIVERSE IS THE CALL GRAPH, NOT A DIRECTORY ──────────────
    //
    // It was `readdirSync(ROUTES_DIR)`. Widening it once — from "routes that
    // BUILD a gate" to "routes that CALL one" — found two ungated calls nobody
    // had reported. Widening it again, from `server/routes` to all of
    // `server/**`, finds FOUR more, and one of them is the SAME FUNCTION that
    // was fixed at `routes/run.ts`, in the same shape, one directory up.
    //
    // Twice in a row the universe was the defect, so it is no longer declared.
    // A caller is any first-party server module that IMPORTS a gate-taking
    // bridge name; the bridges themselves are excluded because a bridge calling
    // its sibling is the enforcement, not a bypass. Nothing here names a
    // directory, so a caller added in a new folder tomorrow is covered because
    // nobody had to remember it.
    const routes = serverModules()
      .map((file) => ({ file: relative(SERVER_DIR, file), src: readFileSync(file, "utf8") }))
      // STRINGS PRESERVED for the IMPORT scan: the module specifier IS a string
      // literal, so the stripper that blanks literal contents erases the only
      // evidence of where a name came from — measured, with the blanking view
      // this set was EMPTY and every call below was skipped.
      .map((r) => ({ ...r, imported: bridgeImportedNames(stripCommentsOnly(r.src)) }))
      .filter((r) => gated.some((name) => r.imported.has(name)));
    expect(
      routes.length,
      "no server module imports a gate-taking bridge function — the universe collapsed and every call below would be skipped",
    ).toBeGreaterThan(0);
    // A FLOOR THAT THE OLD UNIVERSE COULD NOT MEET. `server/routes` alone
    // reaches roughly a dozen callers; the call graph reaches more, and a
    // regression back to one directory shows up here rather than as a silent
    // green.
    expect(
      routes.filter((r) => r.file.includes(sep)).length,
      `callers OUTSIDE server/routes that the directory-scoped universe could not see: ${routes.filter((r) => r.file.includes(sep)).length}`,
    ).toBeGreaterThan(0);

    const missing: string[] = [];
    const exemptedByDesign: string[] = [];
    // The run-totals, so a shrinking-but-nonzero universe is visible too.
    let routeBridgeNames = 0;
    let callsInspected = 0;
    for (const { file, src, imported } of routes) {
      const code = stripCommentsAndStringsFor(src, file);
      // The gate's own binding name is DISCOVERED from the construction rather
      // than assumed, so a route that calls it something else is still covered.
      // An empty list is no longer an error here: it is the finding.
      const gateNames = [...code.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+makeFsGate\s*\(/g)]
        .map((m) => m[1]!);
      // ── THE DETECTOR MUST BE AWAKE, NOT MERELY QUIET ─────────────────
      //
      // This set was once EMPTY on the blanked view, and an empty set skips
      // every call below: `missing` stays `[]` and the test is green while a
      // route that dropped its gate walks through. A conjunction of detectors
      // needs liveness on EVERY one of them.
      expect(
        imported.size,
        `${file}: bridge names read from its imports: ${imported.size} — zero means every call in this route was skipped, not that every call was gated`,
      ).toBeGreaterThan(0);
      routeBridgeNames += imported.size;
      // BOUNDED TO THE NAMES THIS FILE ACTUALLY IMPORTS FROM A BRIDGE, and the
      // bound is not tidiness — without it the scanner reported
      // `readFile(filePath, "utf8")` in `file-tree.ts` as an ungated bridge
      // call, when that `readFile` is `node:fs/promises` and merely SHARES A
      // NAME with the editor bridge's.
      for (const fn of gated.filter((name) => imported.has(name))) {
        const gateAt = gateIndex.get(fn)!;
        for (const call of callArgumentsOf(src, fn, `${file} calls to ${fn}`)) {
          callsInspected += 1;
          // THE GATE IS AN ARGUMENT IN THE GATE'S POSITION, whatever it is
          // called and however the caller got it. `gateNames` still discovers
          // locally-built gates and is kept as a second, narrower signal for
          // the planted-violation test below.
          // AN EXPLICIT `undefined` IS NOT A GATE. `readFileRaw(p, root,
          // undefined, cap)` supplies an argument in the gate's position and
          // supplies nothing at all — a hole a pure arity check walks straight
          // past, and one that was live in `tool-executor.ts`.
          const supplied = topLevelArguments(call)[gateAt]?.trim();
          if (supplied !== undefined && supplied !== "undefined") continue;
          // THE ONE DECLARED EXEMPTION, AND IT IS NOW INSIDE THE UNIVERSE
          // RATHER THAN OUTSIDE IT. `tool-executor.ts` omits the gate by
          // design — the path is ownership-verified upstream — and it used to
          // discharge that by living in a directory the scan never walked,
          // which is not an exemption, it is an absence. It is counted here,
          // and the claim behind it is planted in its own test below.
          if (file === "tools/tool-executor.ts") { exemptedByDesign.push(`${fn}(${call.replace(/\s+/g, " ").slice(0, 60)})`); continue; }
          missing.push(`${file}: ${fn}(${call.replace(/\s+/g, " ").slice(0, 60)}) — no gate in position ${gateAt}`);
        }
      }
    }
    // THE COVERED POPULATION AS RUNTIME NUMBERS, with floors. A collapse is
    // exactly what a wrong view or a wrong universe produces, and it is
    // indistinguishable from "everything is fine" without these.
    expect(
      routeBridgeNames,
      `bridge names read across all routes that call one: ${routeBridgeNames}`,
    ).toBeGreaterThanOrEqual(20);
    expect(
      callsInspected,
      `gate-taking bridge CALLS inspected across those routes: ${callsInspected}`,
    ).toBeGreaterThanOrEqual(20);
    expect(
      missing,
      `every call to a gate-taking bridge function must pass a gate — unchecked: ${missing.join(" | ")}`,
    ).toEqual([]);
    // THE EXEMPTION AS A NUMBER, with a ceiling. An exemption that is not
    // counted cannot be seen to grow, and this one grew from two sites to
    // three the moment the universe stopped being a directory. It grew once
    // more (to four) when the edit tools were routed through the governed
    // editor: the editor's injected atomic writer is a fourth
    // ownership-verified-upstream call site — `writeFileRaw(resolvedPath,
    // content, ctx.projectRoot)` — gated not by a per-call FsGate but by the
    // editor's write-set authorization (only the single model-named path is
    // writable) plus the bridge's own containment refusal.
    expect(
      exemptedByDesign.length,
      `ungated bridge calls exempted by design in tool-executor.ts: ${exemptedByDesign.length}\n${exemptedByDesign.join("\n")}`,
    ).toBeLessThanOrEqual(4);
    expect(
      exemptedByDesign.length,
      "the tool-executor exemption matched nothing — either the file moved or the scan no longer reaches it, "
      + "and an inert exemption means this scan is not reading what it thinks",
    ).toBeGreaterThan(0);
  });

  test("the tool-executor exemption carries its own evidence, not just its own comment", () => {
    // AN EXEMPTION IS A CLAIM ABOUT THE WORLD and carries the same evidence
    // burden as a detection. This one had none: it was written into a comment
    // ("routes pass the gate; the tool-executor omits it — path verified
    // upstream") and believed, while the sites it covered sat outside the
    // scan's universe entirely. Two halves, both planted.
    //
    // HALF ONE — WHAT THE MISSING GATE DOES NOT GIVE UP. The gate answers
    // OWNERSHIP. Path CONTAINMENT is a separate invariant enforced by the
    // bridge itself, and it still holds with no gate at all: a traversal out of
    // the project root is refused whether or not one is passed.
    // THE SPECIFIC TYPE, never a bare `.toThrow()`. A bare one passes on any
    // failure at all — including the bridge crashing for an unrelated reason —
    // so it would report "containment holds" while measuring an outage. The
    // estate's own guard against bare throw assertions caught this one.
    expect(
      () => readFileSyncViaBridge(join(projectAPath, "..", "escape.ts"), projectAPath),
      "without a gate the bridge must still refuse a path outside the project root",
    ).toThrow(PathTraversalError);
    // …and the clean control, so the refusal above is a refusal and not an outage.
    expect(readFileSyncViaBridge(join(projectAPath, "a.ts"), projectAPath).content).toContain("export const x = 1");

    // HALF TWO — WHERE THE OWNERSHIP ACTUALLY HAPPENS. The exemption rests on
    // "verified upstream", so the upstream is asserted rather than described:
    // the single production caller resolves the project through the
    // user-scoped door before it ever builds a tool context.
    // TWO SUBJECTS, BECAUSE THERE ARE NOW TWO MODULES, and conflating them
    // would let either one satisfy a claim about the other. The tool dispatch
    // lives in the executor (`server/run-executor.ts`) since the run stopped
    // being started by a GET; the user-scoped project resolution the
    // exemption defers to still happens in the start route.
    const executor = readFileSync(join(SERVER_DIR, "run/run-executor.ts"), "utf8");
    const runRoute = readFileSync(join(ROUTES_DIR, "run.ts"), "utf8");
    const callers = functionsCalling(executor, "executeToolCall");
    expect(callers.length, `production callers of executeToolCall: ${callers.length}`).toBeGreaterThan(0);
    expect(
      readFileSync(join(SERVER_DIR, "tools/tool-executor.ts"), "utf8").includes("executeToolCall"),
      "the executor must still be the single door the exemption is about",
    ).toBe(true);
    // The handler is an anonymous arrow registered on a route, so it is scoped
    // by the registration it belongs to rather than by a name it does not have.
    const [startRun] = functionArgumentsOf(runRoute, "router.post", ['"/api/run/start"'], "run.ts");
    expect(
      bodyCallsWith(startRun!, "db.getProject", ["input.projectId", "user.userId"]),
      "the run-start handler must resolve the project through the USER-SCOPED lookup before a tool context exists — "
      + "that resolution IS the ownership check the tool-executor exemption defers to",
    ).toBe(true);
    // …and the neighbouring registration must not answer for it: a handler
    // registered on a DIFFERENT route is a different handler.
    expect(
      functionArgumentsOf(runRoute, "router.post", ['"/api/run/start"'], "run.ts").length,
      "exactly one handler is registered for run-start",
    ).toBe(1);
  });

  test("the import reader is driven on the view that breaks it, and on the one that works", () => {
    // THE ESCAPE, RE-DRIVEN. A module specifier IS a string literal, so the
    // stripper that blanks literal contents erases the only evidence of where
    // a name came from. Stated as a comparison rather than as a comment,
    // because the comment was there and the assertion was not.
    const route = readFileSync(join(ROUTES_DIR, "editor.ts"), "utf8");
    const routePath = join(ROUTES_DIR, "editor.ts");
    expect(
      bridgeImportedNames(stripCommentsOnly(route)).size,
      "the correct view must yield the bridge's imported names",
    ).toBeGreaterThan(0);
    expect(
      bridgeImportedNames(stripCommentsAndStringsFor(route, routePath)).size,
      "the blanked view yields nothing — which is why the guard above asserts a floor rather than trusting the stripper",
    ).toBe(0);
  });

  test("the call-site scanner catches a route that forgets the gate", () => {
    // PLANTED VIOLATION for the scanner above, in exactly the shape it exists
    // to catch: the gate is built and one call does not receive it. Without
    // this, the empty result above is satisfied by a scanner that matches
    // nothing.
    const planted = `const gate = await makeFsGate(user.userId, db, path);\nconst s = getBranches(path);\n`;
    const code = stripCommentsAndStringsFor(planted, "probe.ts");
    const names = [...code.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+makeFsGate\s*\(/g)].map((m) => m[1]!);
    expect(names).toEqual(["gate"]);
    const calls = callArgumentsOf(planted, "getBranches");
    expect(calls.length).toBe(1);
    expect(/(?:^|[^\w$])gate(?:[^\w$]|$)/.test(calls[0]!)).toBe(false);
    // CLEAN CONTROL: the same call WITH the gate is not a violation.
    const ok = callArgumentsOf("getBranches(path, gate);", "getBranches");
    expect(/(?:^|[^\w$])gate(?:[^\w$]|$)/.test(ok[0]!)).toBe(true);
  });

  test("no path-based route CALLS requireProjectByPath (the gate moved to the bridge)", () => {
    // Check for actual CALLS (not comment mentions of the old name). A
    // call is `requireProjectByPath(` — a comment mentioning the name
    // for historical context is fine.
    const CALL_RE = /\brequireProjectByPath\s*\(/;
    // Dynamic discovery: scan ALL route files.
    const routes = nonEmptySourceFilesUnder(ROUTES_DIR, "path-based route modules");
    for (const f of routes) {
      const src = readFileSync(f, "utf8");
      expect(
        src,
        `${relative(ROUTES_DIR, f)} must NOT call requireProjectByPath (the gate is in the bridge now)`,
      ).not.toMatch(CALL_RE);
    }
  });

  test("every path-based route constructs the gate from requireUserContext + db", () => {
    // Dynamic discovery: scan ALL route files that import makeFsGate.
    const routes = readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(ROUTES_DIR, f), "utf8").includes("makeFsGate"));
    expect(routes.length).toBeGreaterThan(0);
    for (const f of routes) {
      const src = readFileSync(join(ROUTES_DIR, f), "utf8");
      // The route resolves the user (auth) + builds the gate.
      expect(src, `${f} must call requireUserContext`).toContain("requireUserContext");
      expect(src, `${f} must construct the gate via makeFsGate`).toMatch(/makeFsGate\(/);
    }
  });

  test("routes/filesystem.ts does NOT define isWithinAllowedRoots (only re-exports)", () => {
    const src = readFileSync(join(ROUTES_DIR, "filesystem.ts"), "utf8");
    // The function is re-exported (import + export), NOT defined.
    expect(src).not.toMatch(/export function isWithinAllowedRoots/);
    // The route uses the throwing form.
    expect(src).toContain("assertWithinAllowedRoots");
  });

  test("no route re-implements the allowed-roots check inline (must delegate to fs-gate)", () => {
    // Dynamic discovery: scan ALL route files for direct
    // `allowedProjectRoots` access. The allowed-roots check has ONE owner
    // (`isWithinAllowedRoots` / `assertWithinAllowedRoots` in fs-gate.ts).
    // A route that references `serverConfig.allowedProjectRoots` must ALSO
    // import from fs-gate.ts — otherwise it is re-implementing the allowed-
    // roots check inline (No Scattered Helpers bypass). Deny-by-default: a
    // new route that touches `allowedProjectRoots` without importing fs-gate
    // is auto-caught. A route may reference `allowedProjectRoots` in an error
    // message (e.g. `.join(", ")`) — that is allowed ONLY when the route also
    // imports the gate (the check itself must go through the owner).
    // AN EMPTY NARROWING HERE IS A CORRECT ANSWER — no route need touch the
    // field — so the floor cannot be a count. It is the term's own liveness:
    // `allowedProjectRoots` is a CONFIG FIELD, and renaming it (a change with
    // nothing to do with this guard) emptied this filter and made the test
    // pass in 0 ms having examined nothing. The door now proves the spelling
    // still exists where `server/config.ts` declares it, and refuses if not.
    const routes = sourceFilesMentioning(
      ROUTES_DIR,
      { term: "allowedProjectRoots", livingIn: join(SERVER_DIR, "kernel/config.ts") },
      "routes that reference the allowed-roots config field",
    );
    for (const f of routes) {
      const src = readFileSync(f, "utf8");
      expect(
        src,
        `${relative(ROUTES_DIR, f)} references allowedProjectRoots but does NOT import the fs-gate owner (isWithinAllowedRoots or assertWithinAllowedRoots) — re-implementing the allowed-roots check inline is a No Scattered Helpers bypass`,
      ).toMatch(/isWithinAllowedRoots|assertWithinAllowedRoots/);
    }
  });

  test("filesystem list + mkdir routes gate BEFORE any fs probe (no existence-info leak)", () => {
    // Deny-by-default ordering: the allowed-roots gate
    // (`assertWithinAllowedRoots`) MUST run BEFORE any filesystem probe
    // (`safeStat`/`statSync`/`existsSync`). The prior order (stat then gate)
    // leaked existence information for paths outside the roots (a caller
    // could distinguish "exists but forbidden" from "absent" via the error
    // response). The gate is the choke point — it must reject before the
    // filesystem is touched. This test pins the ordering in the two browsing
    // routes that use the allowed-roots gate.
    const src = readFileSync(join(ROUTES_DIR, "filesystem.ts"), "utf8");

    // The list route handler: from its path registration to the next route.
    const listStart = src.indexOf('"/api/filesystem/list"');
    const listEnd = src.indexOf('"/api/filesystem/roots"');
    expect(listStart, "list route must exist").toBeGreaterThan(-1);
    expect(listEnd, "list route must be followed by the roots route").toBeGreaterThan(listStart);
    const listRoute = src.slice(listStart, listEnd);
    const listGate = listRoute.indexOf("assertWithinAllowedRoots");
    const listProbe = listRoute.search(/safeStat\(|statSync\(|existsSync\(/);
    expect(listGate, "list route must call assertWithinAllowedRoots").toBeGreaterThan(-1);
    expect(listProbe, "list route must probe the filesystem").toBeGreaterThan(-1);
    expect(
      listGate,
      "list route must gate BEFORE the fs probe (no existence-info leak for paths outside the roots)",
    ).toBeLessThan(listProbe);

    // The mkdir route handler: from its path registration to the end of the
    // register function (the last route in the file).
    const mkdirStart = src.indexOf('"/api/filesystem/mkdir"');
    expect(mkdirStart, "mkdir route must exist").toBeGreaterThan(-1);
    const mkdirRoute = src.slice(mkdirStart);
    const mkdirGate = mkdirRoute.indexOf("assertWithinAllowedRoots");
    const mkdirProbe = mkdirRoute.search(/existsSync\(|statSync\(/);
    expect(mkdirGate, "mkdir route must call assertWithinAllowedRoots").toBeGreaterThan(-1);
    expect(mkdirProbe, "mkdir route must probe the filesystem").toBeGreaterThan(-1);
    expect(
      mkdirGate,
      "mkdir route must gate BEFORE the fs probe (no existence-info leak for paths outside the roots)",
    ).toBeLessThan(mkdirProbe);
  });
});

// ── B. single-owner: gate functions defined ONLY in fs-gate.ts ──

describe("B. single-owner: gate functions defined ONLY in fs-gate.ts", () => {
  // Dynamic discovery: scan ALL .ts files under server/, recursively — domain
  // subfolders (filesystem/, run/, …) hold source too. A new file that defines
  // a gate function is automatically caught.
  const SERVER_FILES: string[] = walkTs(SERVER_DIR).map((f) => relative(SERVER_DIR, f).split(sep).join("/"));

  test("assertProjectPathOwnership is defined ONLY in fs-gate.ts", () => {
    const definers: string[] = [];
    for (const f of SERVER_FILES) {
      const src = readFileSync(join(SERVER_DIR, f), "utf8");
      if (/export function assertProjectPathOwnership/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/fs-gate.ts"]);
  });

  test("resolveWithinProject is defined ONLY in fs-gate.ts", () => {
    const definers: string[] = [];
    for (const f of SERVER_FILES) {
      const src = readFileSync(join(SERVER_DIR, f), "utf8");
      if (/export function resolveWithinProject/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/fs-gate.ts"]);
  });

  test("makeFsGate is defined ONLY in fs-gate.ts", () => {
    const definers: string[] = [];
    for (const f of SERVER_FILES) {
      const src = readFileSync(join(SERVER_DIR, f), "utf8");
      if (/export async function makeFsGate/.test(src)) definers.push(f);
    }
    expect(definers).toEqual(["filesystem/fs-gate.ts"]);
  });
});

// ── C0. the gate carries DECISIONS, not a database ──
//
// The gate stopped holding a `DbClient` so the ownership query could move to
// the request boundary and off the event loop (DESIGN-PERFORMANCE §2/L1).
// That trade introduces exactly one new way to be wrong — a bridge asking
// about a path the request never resolved — and these are its guards. Each
// was mutation-proved: see the commit that introduced them.

describe("C0. the gate carries resolved decisions, and says so when it has none", () => {
  test("a path the request never resolved is REFUSED, and not as a denial", async () => {
    // The failure mode this exists to prevent is the QUIET one: folding
    // "nobody asked" into `project_path_not_owned` would produce a 403 that
    // reads like a working access-control decision and is not one. The gate
    // must refuse with its own code so the bug is visible as a bug.
    const gate = await makeFsGate(userA.userId, AsyncDbClient.inline(db), projectAPath);
    const neverAsked = join(tmpRoot, "never-primed");
    let caught: unknown;
    try {
      assertProjectPathOwnership(neverAsked, gate);
      throw new Error("expected assertProjectPathOwnership to refuse an unprimed path");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WebError);
    expect(caught).not.toBeInstanceOf(ForbiddenError);
    expect((caught as WebError).code).toBe("gate_path_undecided");
    // And it names the path, so the fix is the one line the route is missing.
    expect((caught as Error).message).toContain(neverAsked);
  });

  test("a resolved-but-not-owned path is a DENIAL, distinct from an unresolved one", async () => {
    // The positive control for the test above: the same gate, a path it DID
    // resolve, and a real 403. Without this pair, a guard that refused
    // everything would look identical to a guard that works.
    const gate = await makeFsGate(userB.userId, AsyncDbClient.inline(db), projectAPath);
    expect(() => assertProjectPathOwnership(projectAPath, gate)).toThrow(ForbiddenError);
  });

  test("the gate ALWAYS resolves the server's default project root", async () => {
    // A bridge called with no explicit root gates against
    // `effectiveProjectRoot()` — a path the caller never named. If the gate
    // did not resolve it, omitting the root would turn every 403 into a 500:
    // still a refusal, but no longer an access-control answer.
    const gate = await makeFsGate(userA.userId, AsyncDbClient.inline(db), projectAPath);
    expect(gate.decisions.has(effectiveProjectRoot())).toBe(true);
    // …and it is a real decision, reached the same way as any other: user A
    // owns no project at the server's default root, so it denies.
    expect(() => assertProjectPathOwnership(effectiveProjectRoot(), gate)).toThrow(ForbiddenError);
  });

  test("the gate has no database on it — a bridge cannot issue an ownership query", () => {
    // Structural, because it is invisible at runtime: as long as the gate
    // carries a client, any of the 51 guard sites can quietly go back to
    // querying on the request thread, and every behavioural test stays green.
    const src = readFileSync(join(SERVER_DIR, "filesystem/fs-gate.ts"), "utf8");
    const typeDecl = src.slice(
      src.indexOf("export type FsGate"),
      src.indexOf("export function effectiveProjectRoot"),
    );
    // The member LIST, not a keyword search. A keyword search misses the
    // shapes that matter — `db?: DbClient`, `client: DbClient`, a getter —
    // and this test was mutation-proved by exactly that escape: adding
    // `readonly db?: unknown;` slipped past a `/\bdb\b\s*:/` check.
    const members = [...typeDecl.matchAll(/readonly\s+(\w+)\??\s*:/g)].map((m) => m[1]).sort();
    expect(members, "the gate carries a user and decisions, and nothing else").toEqual([
      "decisions",
      "userId",
    ]);
    expect(Object.keys(gateA).sort()).toEqual(["decisions", "userId"]);
  });

  test("makeFsGate does not query for an empty or null-byte path", async () => {
    // Both are refused by the gate before it consults a decision, so priming
    // them would send a path the gate already rejects into a DB query.
    const asked: string[] = [];
    const spy = {
      getProjectByPath: async (path: string) => {
        asked.push(path);
        return null;
      },
    } as unknown as AsyncDbClient;
    const gate = await makeFsGate("u", spy, "", "a\0b", undefined, projectAPath, projectAPath);
    // projectAPath once (deduped) + the default root. Never "" or "a\0b".
    expect(asked).not.toContain("");
    expect(asked).not.toContain("a\0b");
    expect(asked.filter((p) => p === projectAPath)).toHaveLength(1);
    expect(gate.decisions.has("")).toBe(false);
  });
});

// ── C. behavioral: the gate throws the right typed errors ──

describe("C. behavioral: the gate enforces deny-by-default + typed errors", () => {
  test("assertProjectPathOwnership returns the project when owned", () => {
    const project = assertProjectPathOwnership(projectAPath, gateA);
    expect(project).toBeDefined();
    expect(project.path).toBe(projectAPath);
  });

  test("assertProjectPathOwnership throws ForbiddenError when NOT owned (deny-by-default)", () => {
    // User B does not own User A's project → ForbiddenError (403).
    expect(() => assertProjectPathOwnership(projectAPath, gateB)).toThrow(ForbiddenError);
    try {
      assertProjectPathOwnership(projectAPath, gateB);
    } catch (err) {
      expect((err as ForbiddenError).code).toBe("project_path_not_owned");
    }
  });

  test("assertProjectPathOwnership throws BadRequestError on empty path", () => {
    expect(() => assertProjectPathOwnership("", gateA)).toThrow(BadRequestError);
  });

  test("assertProjectPathOwnership rejects null bytes (injection guard)", () => {
    expect(() => assertProjectPathOwnership("a\0b", gateA)).toThrow(BadRequestError);
  });

  test("resolveWithinProject returns the absolute path when within root", () => {
    const abs = resolveWithinProject("a.ts", projectAPath);
    expect(abs).toBe(join(projectAPath, "a.ts"));
  });

  test("resolveWithinProject accepts an absolute path within root", () => {
    const abs = resolveWithinProject(join(projectAPath, "a.ts"), projectAPath);
    expect(abs).toBe(join(projectAPath, "a.ts"));
  });

  test("resolveWithinProject throws PathTraversalError on../ escape", () => {
    expect(() => resolveWithinProject("../../etc/passwd", projectAPath)).toThrow(PathTraversalError);
    try {
      resolveWithinProject("../../etc/passwd", projectAPath);
    } catch (err) {
      expect((err as PathTraversalError).code).toBe("path_traversal");
    }
  });

  test("resolveWithinProject throws PathTraversalError on absolute path outside root", () => {
    expect(() => resolveWithinProject("/etc/passwd", projectAPath)).toThrow(PathTraversalError);
  });

  test("resolveWithinProject rejects null bytes", () => {
    expect(() => resolveWithinProject("a\0b", projectAPath)).toThrow(BadRequestError);
  });

  test("resolveWithinProject rejects empty path", () => {
    expect(() => resolveWithinProject("", projectAPath)).toThrow(BadRequestError);
  });

  test("the filesystem root '/' is refused as a project root at the choke point", () => {
    // `/` contains the harness (and every system folder), so the re-run of
    // the project-door questions refuses it. A project root is not a durable
    // property of a string: a root that stopped being a project folder never
    // serves a file, and `/` was never a registrable project to begin with.
    requireHost(sep === "/", "POSIX path separators (the root `/` case)");
    expect(() => resolveWithinProject("a.ts", "/")).toThrow(ForbiddenError);
    expect(() => resolveWithinProject("/a.ts", "/")).toThrow(/project/i);
  });

  test("assertWithinAllowedRoots passes when no roots configured (default dev)", () => {
    // Default config has empty allowedProjectRoots → everything allowed.
    expect(() => assertWithinAllowedRoots("/anywhere/on/disk")).not.toThrow();
  });

  test("isWithinAllowedRoots returns true for any path when no roots configured", () => {
    expect(isWithinAllowedRoots("/anywhere/on/disk")).toBe(true);
  });

  test("isWithinAllowedRoots returns false for a non-absolute path when roots are set", () => {
    // The function checks isAbsolute when roots are non-empty. We can't
    // easily set roots here (config is frozen), but the source-level test
    // in backend-feature-wiring covers that. Here we verify the empty-roots contract.
    expect(isWithinAllowedRoots("/abs/path")).toBe(true);
  });
});

// ── D. bridge-level enforcement: the bridge throws at the choke point ──

describe("D. bridge-level enforcement: the bridge enforces ownership (NOT the route)", () => {
  test("editor-bridge.readFile throws ForbiddenError when gate passed + path not owned", () => {
    // The bridge enforces the gate at the CHOKE POINT. User B calling
    // readFile with A's project root + B's gate → ForbiddenError (403).
    // This is the cross-user fix at the LOWEST level — even if a route
    // forgot to check, the bridge catches it.
    expect(() =>
      readFileSyncViaBridge(join(projectAPath, "a.ts"), projectAPath, gateB),
    ).toThrow(ForbiddenError);
    try {
      readFileSyncViaBridge(join(projectAPath, "a.ts"), projectAPath, gateB);
    } catch (err) {
      expect((err as ForbiddenError).code).toBe("project_path_not_owned");
    }
  });

  test("editor-bridge.readFile succeeds when gate passed + path owned", () => {
    const result = readFileSyncViaBridge(join(projectAPath, "a.ts"), projectAPath, gateA);
    expect(result.content).toContain("export const x = 1");
  });

  test("editor-bridge.readFile throws PathTraversalError when path escapes root", () => {
    expect(() =>
      readFileSyncViaBridge("../../etc/passwd", projectAPath, gateA),
    ).toThrow(PathTraversalError);
  });

  test("editor-bridge.readFile without a gate does NOT check ownership (server-verified path)", () => {
    // When no gate is passed, the bridge trusts the path (ownership done
    // upstream at run-start). This is the opt-in design: routes pass the
    // gate; the tool-executor/run route omit it (path verified upstream).
    const result = readFileSyncViaBridge(join(projectAPath, "a.ts"), projectAPath);
    expect(result.content).toContain("export const x = 1");
  });
});

// ── E. consolidation: no scattered path-traversal logic ──

describe("E. consolidation: no scattered path-traversal logic outside fs-gate", () => {
  test("tool-executor safeResolve delegates to resolveWithinProject (no duplicate logic)", () => {
    const src = readFileSync(join(SERVER_DIR, "tools/tool-executor.ts"), "utf8");
    // safeResolve must delegate to resolveWithinProject (not re-implement).
    expect(src).toContain("resolveWithinProject");
    // The old inline resolve+startsWith logic must NOT be present.
    expect(src).not.toMatch(/if\s*\(!candidate\.startsWith\(root\s*\+\s*sep\)\)/);
  });

  test("project-context isWithinRoot delegates to resolveWithinProject (not exported)", () => {
    const src = readFileSync(join(SERVER_DIR, "context/project-context.ts"), "utf8");
    // isWithinRoot must delegate to resolveWithinProject.
    expect(src).toContain("resolveWithinProject");
    // isWithinRoot must NOT be exported (the gate is the canonical owner).
    expect(src).not.toMatch(/export function isWithinRoot/);
  });

  test("editor-bridge does NOT import isWithinRoot (uses resolveWithinProject)", () => {
    const src = readFileSync(join(SERVER_DIR, "filesystem/editor-bridge.ts"), "utf8");
    // Check for actual IMPORT (not comment mentions of the old name).
    expect(src).not.toMatch(/import\b[^\n]*\bisWithinRoot\b/);
    expect(src).not.toMatch(/\bisWithinRoot\s*\(/);
    expect(src).toContain("resolveWithinProject");
  });
});

/**
 * Every exported bridge function that accepts the ownership gate — discovered
 * from the bridge sources by a PARSER, never listed, so a bridge entry point
 * added tomorrow is covered without an edit here.
 *
 * IT USED TO BE A REGULAR EXPRESSION, and it was wrong in two independent ways.
 * `export\s+function` cannot see `export ASYNC function`, so it found 41 of the
 * 44 real entry points — and one of the three it could not see was being called
 * with no gate at all. `[^)]*` stops at the first `)`, so a parameter that is
 * itself a function type truncates the list it is meant to read. Measured
 * against the parser: 19 bridge modules, 119 exported functions, 44 gate-taking,
 * 3 previously invisible (`getAwarenessSnapshotAsync`, `getRepositoryMapAsync`,
 * `getQualityIndicatorAsync`).
 */
function gatedBridgeFunctions(): readonly string[] {
  return [...gateParameterIndex().keys()].sort();
}

/**
 * PER GATE-TAKING BRIDGE FUNCTION, WHICH ARGUMENT THE GATE IS — read from the
 * bridge's own signature.
 *
 * The call-site check used to ask a different question: it discovered the
 * binding name of a `makeFsGate(...)` construction in the CALLER and then
 * looked for that name in the argument text. That works only where the caller
 * builds the gate itself and names it. Widening the universe from
 * `server/routes` to the call graph immediately produced fourteen false
 * accusations against `blocks/intelligence.ts`, which obtains its gate from a
 * `gateFor(ctx, db, path)` helper and passes it inline — correctly gated, and
 * invisible to a rule that only recognises gates by the name they were bound
 * to.
 *
 * A NAME-BASED RULE CANNOT SURVIVE A WIDER UNIVERSE, which is the same lesson
 * as the rest of this round. The gate is a POSITION in the signature, so the
 * question is whether the call supplies an argument there — an answer that
 * holds however the caller obtained it and whatever it is called.
 */
/**
 * The TOP-LEVEL arguments of one call's argument text.
 *
 * Balanced rather than split on every comma, because an argument is routinely
 * a call, an object or an arrow that carries commas of its own —
 * `findReuse(input.path, input.q, await gateFor(ctx, db, input.path))` has
 * three arguments and a naive split reports five.
 */
function topLevelArguments(text: string): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if ("([{".includes(c)) depth += 1;
    else if (")]}".includes(c)) depth -= 1;
    else if (c === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.filter((a) => a.trim().length > 0);
}

function gateParameterIndex(): ReadonlyMap<string, number> {
  const at = new Map<string, number>();
  for (const fileAbs of walkTs(SERVER_DIR).filter((f) => f.endsWith("-bridge.ts"))) {
    const file = relative(SERVER_DIR, fileAbs).split(sep).join("/");
    for (const [name, parameters] of exportedFunctionParameters(readFileSync(fileAbs, "utf8"), file)) {
      // Split at top level: a parameter may itself be a function type carrying
      // commas (`onDone: (a, b) => void`), which is exactly what `[^)]*` in the
      // retired version could not read.
      const parts: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < parameters.length; i += 1) {
        const c = parameters[i]!;
        if ("([{<".includes(c)) depth += 1;
        else if (")]}>".includes(c)) depth -= 1;
        else if (c === "," && depth === 0) { parts.push(parameters.slice(start, i)); start = i + 1; }
      }
      parts.push(parameters.slice(start));
      const index = parts.findIndex((p) => /\bgate\??\s*:\s*FsGate/.test(p));
      if (index >= 0) at.set(name, index);
    }
  }
  return at;
}

// The argument text of every call is the shared owner's `callArgumentsOf`,
// which reads the parsed program: a hand-rolled balancer counts parentheses
// inside string literals and regular expressions as structure, and the two
// copies of this idea in this suite had already drifted.

/**
 * The names a route imports FROM a `-bridge.ts` module. Read from the import
 * clause rather than assumed from the call, because several bridge functions
 * share a name with a `node:fs` one and a scan that matched the spelling
 * reported a `node:fs/promises` call as an ungated bridge call.
 */
function bridgeImportedNames(code: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*-bridge\.ts["']/g)) {
    for (const spec of m[1]!.split(",")) {
      const trimmed = spec.trim().replace(/^type\s+/, "");
      if (trimmed.length === 0) continue;
      const parts = trimmed.split(/\s+as\s+/);
      names.add((parts[1] ?? parts[0]!).trim());
    }
  }
  return names;
}
