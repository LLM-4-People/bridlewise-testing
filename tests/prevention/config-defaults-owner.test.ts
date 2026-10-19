// @vitest-environment node
/**
 * Mechanical enforcement: every configurable default is DECLARED, in ONE place.
 *
 * Binding guideline: "every configurable default lives in ONE place", plus
 * "single source of truth for everything".
 *
 * WHAT THE EXISTING GUARDS ALREADY DO — AND WHERE THE HOLE WAS
 *
 * `centralized-config.test.ts` proves `process.env` is read only inside the
 * config owner, and `no-hardcoded-config-values.test.ts` proves tunables do not
 * live outside it. Neither says anything about what happens INSIDE the owner —
 * and that is where the defaults themselves had drifted:
 *
 *   - `authUsername` fell back to an inline `"admin"` while its ~30 siblings
 *     each declared a named `DEFAULT_*`. "Where is the default for X" had a
 *     reliable answer for every value except that one.
 *   - three `envInt` calls carried bare numeric bounds (`0, 8760`, `60,
 *     60*60*24*365*10`) while the rest used named `*_MIN`/`*_MAX` constants —
 *     the same value repeated at two call sites with nothing tying them
 *     together.
 *
 * A bound is a configurable too: it decides which operator inputs are refused.
 * An unnamed one cannot be found, reviewed, or reused.
 *
 * Assurance classes:
 *   A. Discovery is live — the env-read call sites were actually found.
 *   B. Every env-read FALLBACK is a named constant. The one exception is the
 *      empty-string sentinel, which is not a default at all: it means "unset"
 *      (no password configured, no allowed-roots restriction), and naming it
 *      would assert a value where the point is that there is none.
 *   C. Every `envInt` BOUND is a named constant — no bare literal or inline
 *      arithmetic.
 *   D. Every env var is read exactly ONCE in the owner. Two reads are two
 *      places the default can be stated, which is the drift this file is about.
 *
 * DISCOVERY IS DYNAMIC: the owner is located by its `@config-owner` marker
 * (the same marker `no-hardcoded-config-values.test.ts` uses), and the call
 * sites are parsed from it. Adding a config value requires no edit here.
 */
import { describe, test, expect } from "vitest";

import { walk, read, relpath, stripCommentsOnly } from "../helpers/source-scan.ts";

/**
 * The config owners, discovered by their `@config-owner` marker rather than
 * by path. A new owner is covered automatically; a renamed one does not
 * silently drop out of the scan.
 */
function configOwners(): string[] {
  const out: string[] = [];
  for (const root of ["server", "src", "shared"]) {
    for (const file of walk(root, { exts: [".ts"] })) {
      const rel = relpath(file);
      if (/@config-owner\b/.test(read(rel))) out.push(rel);
    }
  }
  return out;
}

/** One `envInt(...)` / `envString(...)` call, split into its arguments. */
type EnvRead = Readonly<{
  owner: string;
  fn: string;
  args: readonly string[];
}>;

/** Split a call's argument text on TOP-LEVEL commas (nested calls survive). */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote !== null) {
      cur += c;
      if (c === "\\") { cur += text[i + 1] ?? ""; i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; cur += c; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function envReads(): EnvRead[] {
  const out: EnvRead[] = [];
  for (const owner of configOwners()) {
    const src = stripCommentsOnly(read(owner));
    for (const m of src.matchAll(/\b(envInt|envString|envBool|envNumber)\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      let depth = 0;
      let end = open;
      for (; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")") { depth--; if (depth === 0) break; }
      }
      const args = splitArgs(src.slice(open + 1, end));
      // Skip the helper's own definition (`function envInt(env, name, …)`),
      // which has parameter names rather than call arguments.
      if (src.slice(Math.max(0, m.index! - 20), m.index!).includes("function ")) continue;
      out.push({ owner, fn: m[1]!, args });
    }
  }
  return out;
}

/** A named constant reference (possibly a simple member expression). */
const NAMED_CONSTANT = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
/** The "unset" sentinel — an absence, not a default. */
const UNSET_SENTINEL = /^(""|''|``)$/;

describe("config defaults are declared once, in the config owner", () => {
  test("A. discovery is live (config owners and env reads were found)", () => {
    // Every class below iterates these; an empty scan would pass in silence.
    expect(configOwners().length, "no @config-owner module found").toBeGreaterThan(0);
    expect(envReads().length, "no env-read call sites parsed from the owners").toBeGreaterThan(20);
  });

  test("B. every env-read fallback is a named constant (or the unset sentinel)", () => {
    const offenders: string[] = [];
    for (const r of envReads()) {
      const name = r.args[1] ?? "(missing)";
      const fallback = r.args[2] ?? "(missing)";
      if (UNSET_SENTINEL.test(fallback)) continue;
      if (NAMED_CONSTANT.test(fallback)) continue;
      offenders.push(`${r.owner}: ${r.fn}(…, ${name}, ${fallback}) — inline default, not a named constant`);
    }
    expect(
      offenders,
      `"Every configurable default lives in ONE place" is only true if the default IS in\n` +
        `that place. An inline literal at the call site means the answer to "what does this\n` +
        `default to" is somewhere other than the declared-defaults block.\n` +
        `Declare an exported DEFAULT_* constant and pass it.\n\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("C. every envInt bound is a named constant", () => {
    const offenders: string[] = [];
    for (const r of envReads()) {
      if (r.fn !== "envInt") continue;
      const name = r.args[1] ?? "(missing)";
      for (const [i, label] of [[3, "min"], [4, "max"]] as const) {
        const bound = r.args[i];
        if (bound === undefined) {
          offenders.push(`${r.owner}: envInt(…, ${name}, …) has no ${label} bound`);
          continue;
        }
        if (NAMED_CONSTANT.test(bound)) continue;
        offenders.push(`${r.owner}: envInt(…, ${name}, …) ${label} bound is the literal \`${bound}\``);
      }
    }
    expect(
      offenders,
      `A bound is a configurable: it decides which operator inputs are REFUSED. Bare\n` +
        `literals cannot be found, reviewed or shared — two call sites needing the same\n` +
        `window restate it and drift apart. Name it (\`*_MIN\` / \`*_MAX\`) beside its\n` +
        `siblings.\n\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("D. every env var is read exactly once in the config owners", () => {
    const seen = new Map<string, string[]>();
    for (const r of envReads()) {
      const raw = r.args[1] ?? "";
      const name = /^["'`](.+)["'`]$/.exec(raw)?.[1];
      if (name === undefined) continue; // a computed name is not a duplicate claim
      seen.set(name, [...(seen.get(name) ?? []), r.owner]);
    }
    const dupes = [...seen]
      .filter(([, owners]) => owners.length > 1)
      .map(([name, owners]) => `${name} read ${owners.length}× (${[...new Set(owners)].join(", ")})`);
    expect(
      dupes,
      `An env var read twice can be given two different defaults, and only one of them is\n` +
        `the one that took effect. Read it once and pass the resolved value.\n${dupes.join("\n")}`,
    ).toEqual([]);
  });
});
