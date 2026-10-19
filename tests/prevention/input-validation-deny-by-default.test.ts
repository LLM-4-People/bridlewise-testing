// @vitest-environment node
/**
 * Mechanical enforcement: UNVALIDATED INPUT NEVER REACHES A HANDLER.
 *
 * Binding guidelines: "deny-by-default — unknown input is an error, not a
 * silent default" and "enforce at the LOWEST POSSIBLE CHOKE POINT".
 *
 * THE DEFECT SHAPE
 *
 * `GET /api/memory?tier=…` read the raw query param and passed it straight to
 * the bridge, whose tier dispatch was a chain of `if (tier === "present")…`
 * ending in `else entries = all()`. So `?tier=nonsense` did not fail — it
 * quietly returned EVERY tier, an answer that contradicts the request it
 * claims to serve. That is the deny-by-default rule broken at the trust
 * boundary: an unrecognised value chose a default instead of being refused.
 *
 * The body side already has a choke point (`assertValidBody`, which throws a
 * typed `invalid_*` code the router maps to 400) and the block contract
 * validates every input in ONE place (`parseInput` in `server/blocks/
 * define.ts`). This guard holds both doors shut and closes the query-param
 * door behind them.
 *
 * Assurance classes:
 *   A. Discovery is live — the handler split found the real route surface.
 *   B. Every legacy handler that reads `ctx.body` validates it IN THAT HANDLER.
 *   C. Every legacy handler that reads a query param validates or explicitly
 *      refuses it (a zod parse, the shared `requirePathQuery` guard, or a
 *      typed BadRequest/Validation throw). Reading a param and branching on it
 *      with no rejection path is the memory-tier defect.
 *   D. No block declares a permissive input schema (`z.any` / `z.unknown` /
 *      an unconstrained record) — validation that accepts anything is not
 *      validation.
 *   E. The block mount applies `parseInput` on BOTH sides (read and action):
 *      the single choke point cannot be half-wired.
 *
 * DISCOVERY IS DYNAMIC: route files are read from `server/routes/`, handlers
 * are split on their own `router.<method>("…"` registrations, and blocks from
 * `server/blocks/`. A new route file or block is covered with no edit here.
 */
import { describe, test, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { read, stripCommentsOnly } from "../helpers/source-scan.ts";

const ROUTES_DIR = join("server", "routes");
const BLOCKS_DIR = join("server", "blocks");

/** `router.<method>("<path>"` — the registration that starts a handler. */
const REGISTRATION = /\brouter\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"/g;

type Handler = Readonly<{ file: string; method: string; path: string; body: string }>;

/**
 * Every route handler, obtained by slicing each route file between successive
 * registrations. Crude by design: the slice always contains the whole handler
 * and never bleeds into the NEXT one, which is exactly the scoping these
 * checks need (a guard in a later handler must not excuse an earlier one).
 */
function handlers(): Handler[] {
  const out: Handler[] = [];
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith(".ts"))) {
    const src = stripCommentsOnly(read(join(ROUTES_DIR, file)));
    const marks = [...src.matchAll(REGISTRATION)].map((m) => ({
      index: m.index!,
      method: m[1]!.toUpperCase(),
      path: m[2]!,
    }));
    for (let i = 0; i < marks.length; i++) {
      const end = i + 1 < marks.length ? marks[i + 1]!.index : src.length;
      out.push({
        file,
        method: marks[i]!.method,
        path: marks[i]!.path,
        body: src.slice(marks[i]!.index, end),
      });
    }
  }
  return out;
}

const HANDLERS = handlers();

/** A schema check the handler performs on its own input. */
const VALIDATES = /\bassertValidBody\s*\(|\.safeParse\s*\(|\.parse\s*\(/;
/** An explicit refusal — the deny half of deny-by-default. */
const REFUSES = /\brequirePathQuery\s*\(|\bthrow\s+new\s+(BadRequestError|ValidationError)\b/;

function blockSources(): { file: string; src: string }[] {
  return readdirSync(BLOCKS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ file: `${BLOCKS_DIR}/${f}`, src: stripCommentsOnly(read(join(BLOCKS_DIR, f))) }));
}

describe("input validation is deny-by-default at the trust boundary", () => {
  test("A. discovery is live (handlers and blocks were actually found)", () => {
    // Every class below iterates these; an empty scan would pass silently.
    expect(HANDLERS.length, "no route handlers discovered — the split is broken").toBeGreaterThan(50);
    expect(blockSources().length, "no block modules discovered").toBeGreaterThan(0);
  });

  test("B. every handler that reads ctx.body validates it", () => {
    const offenders: string[] = [];
    for (const h of HANDLERS) {
      if (!/\bctx\.body\b/.test(h.body)) continue;
      if (VALIDATES.test(h.body)) continue;
      offenders.push(`${h.file}: ${h.method} ${h.path} reads ctx.body without a schema check`);
    }
    expect(
      offenders,
      `A body that reaches a handler unvalidated is a 500 waiting to happen (or worse, a\n` +
        `write of whatever shape the caller sent). Pass it through assertValidBody with an\n` +
        `\`invalid_*\` code — the router maps that to a 400.\n\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("C. every handler that reads a query param validates or refuses it", () => {
    const offenders: string[] = [];
    for (const h of HANDLERS) {
      const params = [...h.body.matchAll(/\bctx\.query\.get\s*\(\s*"([^"]+)"/g)].map((m) => m[1]!);
      if (params.length === 0) continue;
      if (VALIDATES.test(h.body) || REFUSES.test(h.body)) continue;
      offenders.push(
        `${h.file}: ${h.method} ${h.path} reads query param(s) ${params.join(", ")} with no ` +
          `validation and no rejection path`,
      );
    }
    expect(
      offenders,
      `This is the \`?tier=nonsense\` defect: an unrecognised value fell through to the\n` +
        `"everything" branch, so the response silently answered a different question than\n` +
        `the one asked. Parse the param (zod), use the shared requirePathQuery guard, or\n` +
        `throw a typed BadRequestError.\n\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("D. no block declares a permissive input schema", () => {
    // Scoped to the INPUT side deliberately. `parseInput` runs the input
    // schema and nothing else runs the output one, so a loose output is a
    // different (and much weaker) concern; flagging it here would be a
    // false positive dressed up as an invariant.
    const PERMISSIVE = /\bz\.(any|unknown)\s*\(|z\.record\(\s*z\.string\(\)\s*,\s*z\.(any|unknown)\s*\(/;
    const offenders: string[] = [];
    for (const { file, src } of blockSources()) {
      for (const m of src.matchAll(/\binput\s*:\s*([^,\n]+)/g)) {
        const expr = m[1]!.trim();
        // An identifier resolves to its declaration in the same module, so a
        // permissive schema cannot hide behind a name.
        const named = /^[A-Za-z_$][\w$]*$/.test(expr)
          ? (new RegExp(`\\bconst\\s+${expr}\\s*(?::[^=]+)?=\\s*([^;]+);`).exec(src)?.[1] ?? expr)
          : expr;
        if (PERMISSIVE.test(named)) {
          offenders.push(`${file}: input schema \`${expr}\` resolves to \`${named.trim()}\` — accepts anything`);
        }
      }
    }
    expect(
      offenders,
      `A block's input schema is its ONLY validation — \`parseInput\` runs it and nothing\n` +
        `else. A schema that accepts anything turns the single choke point into a pass-\n` +
        `through.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("E. the block mount validates BOTH the read and the action side", () => {
    const src = stripCommentsOnly(read(join(BLOCKS_DIR, "define.ts")));
    const mount = src.slice(src.indexOf("export function mountBlockRoutes"));
    expect(mount.length, "mountBlockRoutes not found in server/blocks/define.ts").toBeGreaterThan(0);

    const missing: string[] = [];
    for (const [label, marker] of [
      ["read", "blockReadPath("],
      ["action", "blockActionPath("],
    ] as const) {
      const at = mount.indexOf(marker);
      if (at === -1) {
        missing.push(`the ${label} side is not mounted at all (${marker} absent)`);
        continue;
      }
      // The registration's handler runs until the next registration (or the
      // end of the loop body), so a parseInput belonging to the OTHER side
      // cannot satisfy this one.
      const others = ["blockReadPath(", "blockActionPath("].filter((o) => o !== marker);
      const nexts = others.map((o) => mount.indexOf(o, at)).filter((i) => i !== -1);
      const end = nexts.length > 0 ? Math.min(...nexts) : mount.length;
      if (!/\bparseInput\s*\(/.test(mount.slice(at, end))) {
        missing.push(`the ${label} side mounts without calling parseInput`);
      }
    }
    expect(
      missing,
      `Every block gets identical input handling BECAUSE the mount applies parseInput\n` +
        `uniformly. A side that mounts without it is a whole class of capability with no\n` +
        `validation, and the per-block contract tests would still pass.\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
