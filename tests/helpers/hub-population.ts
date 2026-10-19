// @vitest-environment node
/**
 * The canonical hub's decorated re-export population, derived from the hub's
 * OWN definition — never a hand list.
 *
 * The hub's value re-exports are destructured bindings from
 * `engineSpans(<namespace>, "<architecture-module-id>")`. This helper parses
 * that shape into `(moduleId, name)` pairs so the guards that hold the hub
 * honest (the choke-point guard's class G, the effect-kind behavioural lane)
 * share ONE derivation instead of each restating a scanner.
 */
import { modulePath } from "./module-resolver.ts";
import { read, stripCommentsOnly } from "./source-scan.ts";

export const CANONICAL_HUB = modulePath("canonical.ts");

export type HubReExport = Readonly<{
  /** The architecture module id the hub passes to engineSpans. */
  moduleId: string;
  /** The re-exported value name. */
  name: string;
}>;

/** The hub's source, comments stripped (a commented-out statement is not an
 *  export; a live one is). */
function hubSource(): string {
  return stripCommentsOnly(read(CANONICAL_HUB));
}

/**
 * Every value re-export the hub declares, as `(moduleId, name)` pairs —
 * every name destructured from an `engineSpans(...)` call, in file order.
 */
export function hubDecoratedPopulation(): readonly HubReExport[] {
  const src = hubSource();
  const out: { moduleId: string; name: string }[] = [];
  const destructure = /export const \{([^}]+)\}\s*=\s*engineSpans\([^,]+,\s*"([^"]+)"\)/g;
  for (const m of src.matchAll(destructure)) {
    const moduleId = m[2]!;
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim();
      if (name.length > 0) out.push({ moduleId, name });
    }
  }
  return out;
}

export type HubEngineSpanCall = Readonly<{
  /** The namespace identifier the hub passes to engineSpans. */
  namespace: string;
  /** The architecture module id the hub passes to engineSpans. */
  moduleId: string;
}>;

/**
 * Every `engineSpans(<namespace>, "<id>")` call in the hub as
 * `(namespace, moduleId)` pairs — the decoration population keyed by the
 * call itself, so a guard can ask which module a call decorates and which
 * id it claims, not just which names it re-exports.
 */
export function hubEngineSpanCalls(): readonly HubEngineSpanCall[] {
  const out: { namespace: string; moduleId: string }[] = [];
  for (const m of hubSource().matchAll(/engineSpans\(([A-Za-z_$][\w$]*),\s*"([^"]+)"\)/g)) {
    out.push({ namespace: m[1]!, moduleId: m[2]! });
  }
  return out;
}

/**
 * The hub's namespace → engine source path map: every
 * `import * as <ns> from "../../engine/src/<path>.ts"` statement, with the
 * path spelled the way the architecture manifest spells it (`src/...`).
 * A module id passed to engineSpans can then be compared against the module
 * the namespace actually imports — the manifest, never a hand map.
 */
export function hubNamespaceSourcePaths(): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const m of hubSource().matchAll(
    /import \* as ([A-Za-z_$][\w$]*) from "\.\.\/\.\.\/engine\/src\/([^"]+)"/g,
  )) {
    out.set(m[1]!, `src/${m[2]!}`);
  }
  return out;
}

/**
 * Bare VALUE re-export statements from engine paths — the bypass shape. An
 * `export { … } from "../../engine/src/…"` statement (NOT `export type {`)
 * re-exports a raw binding no decoration ever touches, which is exactly the
 * hole the auto-instrumentation exists to close. Returns each offender's
 * first live line.
 */
export function bareEngineValueReExports(): readonly string[] {
  const src = hubSource();
  const offenders: string[] = [];
  const statement = /export\s*\{[\s\S]*?\}\s*from\s*["'][^"']*engine\/src\/[^"']+["']/g;
  for (const m of src.matchAll(statement)) {
    if (/^export\s+type\s*\{/.test(m[0])) continue;
    const firstLine = m[0].split("\n").map((l) => l.trim()).find((l) => l.length > 0)!;
    offenders.push(firstLine);
  }
  return offenders;
}
