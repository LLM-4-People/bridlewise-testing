// @vitest-environment node
/**
 * Mechanical enforcement: FABRICATED DATA MAY NEVER REACH A USER.
 *
 * Binding guideline: "fake/static/placeholder data prohibited."
 *
 * WHY THIS GUARD EXISTS — A REAL DEFECT, NOT A HYPOTHETICAL
 *
 * `server/llm-bridge.ts` used to stream FIXTURE model events to the user when
 * LLM client creation failed. The user saw invented text in the exact place a
 * model answer belongs, with nothing to distinguish it from a real one. An
 * earlier revision had already diagnosed the harm — its own comment read "the
 * user saw fixture events + thought the LLM worked" — and responded by adding
 * an operator warning WHILE STILL FABRICATING. Observability was fixed and the
 * user was still reading fiction.
 *
 * That path now yields a typed `error` event and stops. This test makes the
 * class of defect unrepeatable.
 *
 * THE RULE
 *
 * Synthetic-data builders (fixtures/demo/sample/seed data) are legitimate for
 * tests and for an explicitly opted-in demo mode. They are NEVER a fallback.
 * Concretely:
 *
 *   A. A synthetic-data module may be imported only by `tests/**` or by a
 *      consumer on the ALLOWED_CONSUMERS list, which requires a stated reason.
 *      Deny-by-default: a new fixture module is out of bounds until listed.
 *   B. In an allowed consumer, every call to a synthetic builder must be
 *      lexically guarded by an explicit opt-in predicate (a config/env flag).
 *      A call reachable without the flag is a silent fallback.
 *   C. No synthetic builder may be called from inside a `catch` block. This is
 *      the exact shape of the llm-bridge defect: an error path that answers
 *      with fiction instead of failing.
 *
 * DISCOVERY IS DYNAMIC. Synthetic-data modules are found by scanning the tree,
 * not from a hardcoded list, so a newly added `fixtures.ts` / `demo-data.ts` is
 * covered automatically. Per the doctrine, a guard that needs editing when you
 * add a module is itself a defect.
 */
import { describe, test, expect } from "vitest";
import { basename } from "node:path";

import { walk, read, relpath, stripCommentsOnly } from "../helpers/source-scan.ts";

// `shared/` was NOT scanned, which was a hole in the discovery rather than
// a decision: it is the seam BOTH sides import, so a synthetic module placed
// there would have been invisible to this guard while being reachable from
// the server and the client at once.
const ROOTS = ["server", "src", "shared"] as const;

/**
 * Filename stems that denote a synthetic-data source.
 *
 * `placeholder`/`dummy`/`example-data` were added alongside the original
 * stems: they name the same thing and were simply missing, so a
 * `placeholder-data.ts` would have been treated as ordinary production code.
 */
const SYNTHETIC_STEM =
  /(^|[-.])(fixtures?|demo-data|sample-data|seed-data|mock-data|stub-data|placeholder-data|dummy-data|example-data)([-.]|$)/i;

/**
 * Consumers permitted to import a synthetic-data module outside `tests/`, each
 * with the reason it is allowed. Adding an entry is a deliberate decision, and
 * the entry must still satisfy checks B and C below.
 */
const ALLOWED_CONSUMERS: Readonly<Record<string, string>> = Object.freeze({
  "server/llm/llm-bridge.ts":
    "Explicit offline/demo mode behind HARNESS_WEB_LLM_FIXTURES=1, and the deterministic source for the SSE persistence test. Never a fallback: the client-creation and stream-failure paths yield typed error events.",
});

/** Predicates that count as an explicit opt-in gate for synthetic data. */
const OPT_IN_GATE = /\b\w*(fixtures?|demo|sample|seed)\w*Enabled\b|\bprocess\.env\.[A-Z0-9_]*(FIXTURE|DEMO|SAMPLE|SEED)[A-Z0-9_]*\b/i;

type Source = { rel: string; raw: string; code: string };

function sources(): Source[] {
  const out: Source[] = [];
  for (const root of ROOTS) {
    for (const file of walk(root, { exts: [".ts", ".svelte", ".mjs"] })) {
      const rel = relpath(file);
      const raw = read(rel);
      out.push({ rel, raw, code: stripCommentsOnly(raw) });
    }
  }
  return out;
}

const SOURCES = sources();

/** Files whose basename marks them as a synthetic-data module. */
const SYNTHETIC_MODULES = SOURCES.filter((s) => SYNTHETIC_STEM.test(basename(s.rel)));

// Deny-by-default sanity: if discovery silently matched nothing, every
// assertion below would be vacuously true and the guard would be theatre.
// `server/fixtures.ts` is the known member; assert discovery is live.
test("discovery finds the synthetic-data modules (guard is not vacuous)", () => {
  expect(
    SYNTHETIC_MODULES.length,
    "no synthetic-data module discovered — the scan is broken, not the tree",
  ).toBeGreaterThan(0);
});

/** Import specifiers a file uses, normalised to a basename stem. */
function importedStems(code: string): string[] {
  const out: string[] = [];
  // BOUNDED BY THE STATEMENT, not by 200 bytes. An import clause listing many
  // named bindings runs past 200 characters routinely, and every one of those
  // dropped out of this scan — a smaller universe, reported as a clean one.
  // `[^;]` cannot cross a statement boundary, which is the structural bound the
  // window was approximating.
  const re = /(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const spec = m[1] ?? m[2];
    if (spec !== undefined) out.push(basename(spec).replace(/\.(ts|js|mjs|svelte)$/, ""));
  }
  return out;
}

describe("A. synthetic-data modules are imported only by tests or allowed consumers", () => {
  test("no unlisted production consumer imports a synthetic-data module", () => {
    const syntheticStems = new Set(
      SYNTHETIC_MODULES.map((s) => basename(s.rel).replace(/\.(ts|js|mjs|svelte)$/, "")),
    );
    const violations: string[] = [];

    for (const src of SOURCES) {
      if (SYNTHETIC_MODULES.some((m) => m.rel === src.rel)) continue; // a fixture may reference itself
      const hits = importedStems(src.code).filter((stem) => syntheticStems.has(stem));
      if (hits.length === 0) continue;
      if (ALLOWED_CONSUMERS[src.rel] === undefined) {
        violations.push(`${src.rel} imports synthetic data (${[...new Set(hits)].join(", ")})`);
      }
    }

    expect(
      violations,
      `Synthetic/fixture data must not be reachable from production code.\n` +
        `Fabricated values must never stand in for real ones on a user-facing path.\n` +
        `If this is a deliberate, explicitly opted-in demo mode, add the file to ` +
        `ALLOWED_CONSUMERS with a reason.\n\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  test("every ALLOWED_CONSUMERS entry still exists and still imports synthetic data", () => {
    // A stale allowlist entry is a silent permission. Deny-by-default requires
    // the allowlist to shrink on its own when a consumer stops needing it.
    const stale: string[] = [];
    const syntheticStems = new Set(
      SYNTHETIC_MODULES.map((s) => basename(s.rel).replace(/\.(ts|js|mjs|svelte)$/, "")),
    );
    for (const rel of Object.keys(ALLOWED_CONSUMERS)) {
      const src = SOURCES.find((s) => s.rel === rel);
      if (src === undefined) {
        stale.push(`${rel} — allowlisted but the file no longer exists`);
        continue;
      }
      if (!importedStems(src.code).some((stem) => syntheticStems.has(stem))) {
        stale.push(`${rel} — allowlisted but no longer imports synthetic data; remove the entry`);
      }
    }
    expect(stale, `Stale ALLOWED_CONSUMERS entries:\n${stale.join("\n")}`).toEqual([]);
  });
});

describe("B/C. synthetic data is opt-in only, and never an error fallback", () => {
  /**
   * Character offsets of every `catch` block body in the source, as [start,end)
   * ranges. Brace-matched so nested blocks are handled.
   */
  function catchRanges(code: string): [number, number][] {
    const ranges: [number, number][] = [];
    const re = /\bcatch\b\s*(\([^)]*\))?\s*\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const open = code.indexOf("{", m.index + (m[0].length - 1));
      if (open === -1) continue;
      let depth = 0;
      let i = open;
      for (; i < code.length; i++) {
        if (code[i] === "{") depth++;
        else if (code[i] === "}") {
          depth--;
          if (depth === 0) break;
        }
      }
      ranges.push([open, i]);
    }
    return ranges;
  }

  /**
   * Local function definitions in a file, as name → [bodyStart, bodyEnd).
   * Covers `function f`, `async function* f`, and `const f = (…) => {…}`.
   */
  function localFunctions(code: string): Map<string, [number, number]> {
    const out = new Map<string, [number, number]>();
    const patterns = [
      /(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{/g,
      /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>\s*\{/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        const open = code.indexOf("{", m.index + m[0].length - 1);
        if (open === -1) continue;
        let depth = 0;
        let i = open;
        for (; i < code.length; i++) {
          if (code[i] === "{") depth++;
          else if (code[i] === "}") {
            depth--;
            if (depth === 0) break;
          }
        }
        out.set(m[1]!, [open, i]);
      }
    }
    return out;
  }

  /**
   * Names that transitively produce synthetic data in this file.
   *
   * Seeded from the imported builder names, then propagated to any LOCAL
   * function whose body calls a tainted name, to a fixpoint. Without this,
   * a single level of indirection defeats the guard — which is exactly how
   * the real defect was written: the catch block called a local
   * `fixtureEvents()` wrapper, not the imported `buildStreamModelEvents`.
   */
  function syntheticNames(code: string, imported: ReadonlySet<string>): Set<string> {
    const tainted = new Set(imported);
    const fns = localFunctions(code);
    for (let pass = 0; pass < 10; pass++) {
      let grew = false;
      for (const [name, [start, end]] of fns) {
        if (tainted.has(name)) continue;
        const body = code.slice(start, end);
        for (const t of tainted) {
          if (new RegExp(`\\b${t}\\s*\\(`).test(body)) {
            tainted.add(name);
            grew = true;
            break;
          }
        }
      }
      if (!grew) break;
    }
    return tainted;
  }

  test("no synthetic builder is invoked from inside a catch block (incl. via local wrappers)", () => {
    const violations: string[] = [];
    const syntheticStems = new Set(
      SYNTHETIC_MODULES.map((s) => basename(s.rel).replace(/\.(ts|js|mjs|svelte)$/, "")),
    );

    for (const rel of Object.keys(ALLOWED_CONSUMERS)) {
      const src = SOURCES.find((s) => s.rel === rel);
      if (src === undefined) continue;
      if (!importedStems(src.code).some((stem) => syntheticStems.has(stem))) continue;

      // Names imported from the synthetic module(s) in this consumer.
      const named = new Set<string>();
      const importRe = /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
      let im: RegExpExecArray | null;
      while ((im = importRe.exec(src.code)) !== null) {
        const stem = basename(im[2]!).replace(/\.(ts|js|mjs|svelte)$/, "");
        if (!syntheticStems.has(stem)) continue;
        for (const part of im[1]!.split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (name) named.add(name);
        }
      }
      if (named.size === 0) continue;

      const tainted = syntheticNames(src.code, named);
      const ranges = catchRanges(src.code);
      for (const name of tainted) {
        const callRe = new RegExp(`\\b${name}\\s*\\(`, "g");
        let cm: RegExpExecArray | null;
        while ((cm = callRe.exec(src.code)) !== null) {
          const inCatch = ranges.some(([s, e]) => cm!.index > s && cm!.index < e);
          if (inCatch) {
            violations.push(
              `${rel}: '${name}()' is called inside a catch block — an error path must surface the ` +
                `failure, never answer with fabricated data`,
            );
          }
        }
      }
    }

    expect(
      violations,
      `Fabricated data used as an error fallback:\n${violations.join("\n")}\n\n` +
        `This is the llm-bridge defect: on failure the user received invented content ` +
        `presented as real. Yield a typed error and stop.`,
    ).toEqual([]);
  });

  test("each allowed consumer gates synthetic data behind an explicit opt-in flag", () => {
    const missing: string[] = [];
    for (const rel of Object.keys(ALLOWED_CONSUMERS)) {
      const src = SOURCES.find((s) => s.rel === rel);
      if (src === undefined) continue;
      if (!OPT_IN_GATE.test(src.code)) {
        missing.push(
          `${rel} — imports synthetic data but has no explicit opt-in predicate ` +
            `(expected something like \`fixturesEnabled()\` or a *_FIXTURES env flag)`,
        );
      }
    }
    expect(
      missing,
      `Synthetic data must be reachable only behind a named, explicit opt-in:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
