// @vitest-environment node
/**
 * THE INVALIDATION-EVENT CENSUS — a surface that declares or subscribes to a
 * bus event is promising the event FIRES. This guard derives every declared
 * event name from the production trees and reds on any name with no
 * production firer.
 *
 * ── THE DEFECT, AS IT WAS FOUND (the UIE-053 focus-heal fix) ─────────────
 *
 * `run:done` was declared by six surfaces (`invalidateOn` on the sweep
 * spectrum, run compose, tools breaker, custody, checks, the desk) and
 * subscribed to by five more (`onInvalidation` in spectrum-load, desk-feed,
 * switch-feed, custody-feed, the checks store) — and NO production code
 * anywhere fired it. Every subscriber's own test stayed green for rounds,
 * because each pins its SUBSCRIPTION, never the FIRE. The band's fifth
 * refresh trigger was dead code wearing the shape of a live one, and the gap
 * surfaced only when a heal needed the door and found it dormant. That is the
 * wired-but-inert class: the wire exists (a declaration, a subscription),
 * the producer does not, and no per-surface test can see it — only a census
 * across every surface can.
 *
 * ── THE CENSUS, DERIVED NEVER LISTED ──────────────────────────────────────
 *
 * The DECLARED vocabulary (the demand side — surfaces that would refresh):
 *   - every event name in an `invalidateOn: [ … ]` array on a block read,
 *     client feeds and server block read specs alike;
 *   - every first argument of an `onInvalidation( … )` subscription.
 * The FIRED vocabulary (the supply side — paths that produce the event):
 *   - every event name in an `invalidates: [ … ]` array, client call sites
 *     and server action declarations alike — the Broker fires each declared
 *     `invalidates` entry on that action's success, so an action that carries
 *     the name IS a firer of it;
 *   - every direct `fireInvalidation(" … ")` call.
 * A declared name absent from the fired vocabulary reds, naming every
 * declaring site. The two honest exits are printed with the red: wire a
 * firer at the moment the data becomes true, or undeclare the event.
 *
 * There is deliberately NO allowlist. If an event is genuinely fired only in
 * a niche path, the honest state is a firing site in production code; a
 * declared-but-unfired event is exactly what this guard exists to catch, and
 * an exemption list would be the hole it left behind, re-opened by hand.
 *
 * GUARD SUBJECT: every invalidation event name declared by a block read (`invalidateOn`) or subscribed to by a store or feed (`onInvalidation`) in the production trees is fired by some production path — a `fireInvalidation("<name>")` call site or an action whose declared `invalidates` carries the name
 * GUARD OWNS: the declaration surface — `invalidateOn` on reads (server/blocks/* read specs + the client feeds' broker reads) and `invalidates` on actions (server/blocks/define.ts `BlockAction` + the client's `brokerAction` call sites); the firing surface — src/data/broker.ts `fireInvalidation` + the action loop that fires declared `invalidates` on success
 * GUARD PLANT: add `"census:fake"` to a production read's `invalidateOn` array (reds naming it), or delete the heal's `fireInvalidation("run:done")` in src/client.ts (reds naming run:done — the original finding's exact shape)
 * GUARD DRIVEN: the census derivation over the real production trees (src/ + server/) through the sanctioned source views, plus the same derivation over a planted fixture source that spells every refusal shape
 * GUARD LIVENESS: the census must find a non-empty declared vocabulary AND a non-empty firing vocabulary — a blind derivation passes nothing here; it reds
 * GUARD BOUNDARY: a declaration or fire threaded with no array literal or call-site literal anywhere (a member expression like `descriptor.invalidates`, or the Broker's own generic `fireInvalidation(event)` dispatch loop) is invisible to the census by construction — every fired name must be spelled literally at its declaration or call site, which today every one is; engine/ and scripts/ do not participate in the client Broker bus (verified: no vocabulary there), so the universe is src/ + server/, and test files are never firers
 */
import { describe, expect, test } from "vitest";

import { read, SOURCE_EXTS, relpath, walk } from "../helpers/source-scan.ts";
import { sourceViewOf } from "../../engine/scripts/verification/source-view.ts";

/** The trees the served product is built from — the census's whole universe.
 * `walk` refuses a missing root, so a renamed tree reds instead of shrinking
 * the census silently. */
const PRODUCTION_ROOTS = ["src", "server"] as const;

/** One occurrence of an event name, with the site that spells it. */
interface Site {
  readonly event: string;
  readonly file: string;
  readonly line: number;
}

/** A declaration whose event name the census cannot read. */
interface UnnameableSite {
  readonly file: string;
  readonly line: number;
  readonly entry: string;
}

/**
 * The array forms. `[^[\n;]*` before the bracket accepts the value-shapes the
 * tree actually uses — a bare array, a `?? [ … ]` fallback, a type restated
 * as `readonly string[]` (which matches with an EMPTY body and contributes
 * nothing) — while refusing to cross a newline or statement end, so a
 * non-array value can never borrow a later line's bracket. Optional-member
 * type positions (`invalidateOn?:`) do not match at all.
 */
const INVALIDATE_ON_ARRAY = /invalidateOn\s*:\s*[^[\n;]*\[([^\]]*)\]/g;
const INVALIDATES_ARRAY = /invalidates\s*:\s*[^[\n;]*\[([^\]]*)\]/g;
/** Call shapes only: a literal or identifier first argument. The definitions
 * in the Broker (`onInvalidation(event: string, …)`) carry a type after the
 * name, so they do not match — the census counts uses, not the mechanism. */
const ON_INVALIDATION_ARG = /\bonInvalidation\(\s*("[^"]*"|[A-Za-z_$][\w$]*)\s*,/g;
const FIRE_INVALIDATION_ARG = /\bfireInvalidation\(\s*("[^"]*"|[A-Za-z_$][\w$]*)\s*\)/g;
/** String constants, so a name threaded as a constant (the settings event)
 * resolves at both sides instead of hiding from the census. */
const CONST_STRING =
  /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*"([^"]*)"/g;

/** Is this file a test? Test files are never firers (deny-by-default): the
 * census certifies PRODUCTION supply, and a test that fires an event proves
 * nothing about any user's session. */
function isTestFile(rel: string): boolean {
  return /\.test\.[^.]+$/.test(rel);
}

/** Every production file in the census's universe, derived by walking. */
function productionFiles(): string[] {
  const out: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    for (const f of walk(root, { exts: SOURCE_EXTS })) out.push(relpath(f));
  }
  return out.filter((f) => !isTestFile(f));
}

/** Read one entry of an event-name array body (or a call argument): a quoted
 * literal, a constant identifier, or something the census cannot name. */
type Entry =
  | { kind: "literal"; event: string }
  | { kind: "identifier"; name: string }
  | { kind: "other"; text: string };

function entryOf(raw: string): Entry | null {
  const entry = raw.trim();
  if (entry === "") return null;
  if (/^"[^"]*"$/.test(entry)) return { kind: "literal", event: entry.slice(1, -1) };
  if (/^[A-Za-z_$][\w$]*$/.test(entry)) return { kind: "identifier", name: entry };
  return { kind: "other", text: entry };
}

/** What one source text contributes to the census. */
interface FileCensus {
  readonly declared: Site[];
  readonly fired: Site[];
  readonly unnameable: UnnameableSite[];
}

/**
 * Extract the vocabulary from one source text. The view is
 * `codeWithStrings()` — comments and template interiors blanked, quoted
 * strings intact, byte-length preserved — the sanctioned view for a
 * vocabulary extractor: a prose mention of an event in a comment is not a
 * declaration, and a source-as-data string inside a template literal is not
 * either, while the names themselves live inside quoted strings. Because
 * every view preserves length, a match's index is the raw file's index and
 * `lineAt` reports the true line.
 */
function extractCensus(
  source: string,
  file: string,
  constants: ReadonlyMap<string, string>,
): FileCensus {
  const view = sourceViewOf(source, file);
  const text = view.codeWithStrings();
  const declared: Site[] = [];
  const fired: Site[] = [];
  const unnameable: UnnameableSite[] = [];

  /** Record one event occurrence on its side. An identifier no string
   * constant defines splits by side: the DEMAND side refuses it (the census
   * cannot certify a name it cannot read), while the SUPPLY side skips it —
   * the Broker's own `fireInvalidation(event)` dispatch loop is the
   * mechanism, not a firer, and a descriptor-passed `invalidates` has its
   * literal at the action's declaration. */
  const record = (event: Entry, line: number, side: "declared" | "fired"): void => {
    if (event.kind === "literal") {
      (side === "declared" ? declared : fired).push({ event: event.event, file, line });
      return;
    }
    if (event.kind === "identifier") {
      const resolved = constants.get(event.name);
      if (resolved !== undefined) {
        (side === "declared" ? declared : fired).push({ event: resolved, file, line });
      } else if (side === "declared") {
        unnameable.push({ file, line, entry: event.name });
      }
      return;
    }
    if (side === "declared") unnameable.push({ file, line, entry: event.text });
  };

  /** One array body, comma-split into entries. */
  const recordArray = (body: string, index: number, side: "declared" | "fired"): void => {
    const line = view.lineAt(index);
    for (const raw of body.split(",")) {
      const entry = entryOf(raw);
      if (entry !== null) record(entry, line, side);
    }
  };

  /** One call argument (a subscription's event or a direct fire's event). */
  const recordCall = (arg: string, index: number, side: "declared" | "fired"): void => {
    const entry = entryOf(arg);
    if (entry !== null) record(entry, view.lineAt(index), side);
  };

  for (const m of text.matchAll(INVALIDATE_ON_ARRAY)) {
    recordArray(m[1] ?? "", m.index ?? 0, "declared");
  }
  for (const m of text.matchAll(ON_INVALIDATION_ARG)) {
    recordCall(m[1] ?? "", m.index ?? 0, "declared");
  }
  for (const m of text.matchAll(INVALIDATES_ARRAY)) {
    recordArray(m[1] ?? "", m.index ?? 0, "fired");
  }
  for (const m of text.matchAll(FIRE_INVALIDATION_ARG)) {
    recordCall(m[1] ?? "", m.index ?? 0, "fired");
  }
  return { declared, fired, unnameable };
}

/**
 * The string constants of a file set, so constant-threaded event names
 * resolve. Derived from the same universe the census reads — a name the
 * vocabulary threads but no production file defines stays unresolvable and
 * is refused at the declaring site.
 */
function constantMapOf(sources: readonly { file: string; source: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const { file, source } of sources) {
    for (const m of sourceViewOf(source, file).codeWithStrings().matchAll(CONST_STRING)) {
      out.set(m[1] ?? "", m[2] ?? "");
    }
  }
  return out;
}

/** The whole census over the real production trees. */
function censusOfProductionTrees(): {
  declared: Map<string, Site[]>;
  fired: Map<string, Site[]>;
  unnameable: UnnameableSite[];
} {
  const files = productionFiles();
  const sources = files.map((file) => ({ file, source: read(file) }));
  const constants = constantMapOf(sources);
  const declared = new Map<string, Site[]>();
  const fired = new Map<string, Site[]>();
  const unnameable: UnnameableSite[] = [];
  const add = (into: Map<string, Site[]>, site: Site): void => {
    const list = into.get(site.event);
    if (list === undefined) into.set(site.event, [site]);
    else list.push(site);
  };
  for (const { file, source } of sources) {
    const one = extractCensus(source, file, constants);
    for (const site of one.declared) add(declared, site);
    for (const site of one.fired) add(fired, site);
    unnameable.push(...one.unnameable);
  }
  return { declared, fired, unnameable };
}

/** The remedies printed with every red — the two honest exits. */
function remedies(event: string): string {
  return (
    `either wire an honest firer — fire "${event}" at the moment the data it ` +
    `names becomes true, through the Broker door the declarers already listen ` +
    `to — or undeclare it from every read and subscription that names it`
  );
}

/** The production census, computed ONCE and shared by every arm — the walk
 * + view + constant-map pass is the file's whole cost, and four arms each
 * re-paying it is the fixed-setup-per-test shape the suite's budget exists
 * to refuse. No arm mutates the result, so the share is safe. */
let censusShared: ReturnType<typeof censusOfProductionTrees> | null = null;
function census(): ReturnType<typeof censusOfProductionTrees> {
  if (censusShared === null) censusShared = censusOfProductionTrees();
  return censusShared;
}

describe("the invalidation-event census — a declared event must have a production firer", () => {
  test("the production trees: every event a read declares or a feed subscribes to is fired somewhere in src/ + server/", () => {
    const { declared, fired } = census();
    const dormant: string[] = [];
    for (const [event, sites] of [...declared.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (fired.has(event)) continue;
      const where = sites.map((s) => `${s.file}:${s.line}`).sort().join(", ");
      dormant.push(
        `"${event}" — declared at ${where}; no production firer anywhere ` +
        `(no fireInvalidation("${event}") call site, no action whose declared ` +
        `invalidates carries it; test files do not count). ${remedies(event)}.`,
      );
    }
    expect(dormant, "declared-but-never-fired invalidation events").toEqual([]);
  });

  test("a declared name the census cannot read is refused, never skipped — the demand side must spell its events", () => {
    const { unnameable } = census();
    const refusals = unnameable.map(
      (u) =>
        `${u.file}:${u.line} declares invalidation names the census cannot read ` +
        `("${u.entry}") — spell the event as a string literal or a defined ` +
        `string constant at the declaring site, or the census cannot certify ` +
        `it has a firer.`,
    );
    expect(refusals, "unnameable declared invalidation entries").toEqual([]);
  });

  test("the census is not blind: it finds a non-empty declared vocabulary and a non-empty firing vocabulary", () => {
    const { declared, fired } = census();
    // A guard whose derivation rots to nothing passes every census above
    // vacuously — that state is a defect of the guard, not a clean tree, so
    // it reds here instead.
    expect(declared.size, "declared invalidation events found").toBeGreaterThan(0);
    expect(fired.size, "firing sites' event vocabulary found").toBeGreaterThan(0);
  });

  test("the extraction's teeth on a planted source: a dormant declaration is named, and the shapes that must not count do not", () => {
    // The planted source spells every refusal and every exclusion in one
    // file: a dormant declaration (the census's subject), a comment mention,
    // a type position, a template-interior mention, the Broker's generic
    // dispatch, a constant-threaded pair, and a fired-and-declared pair.
    const planted = [
      `const FAKE_EVENT = "fixture:fired-const";`,
      `// prose mention: invalidateOn: ["fixture:comment-only"] — not a declaration`,
      `export type ReadOptions = { invalidateOn?: readonly string[] };`,
      "const template = `invalidateOn: [\"fixture:template-only\"]`;",
      `export function reads() {`,
      `  broker.read("sweep.spectrum", { invalidateOn: ["fixture:dormant", "fixture:alive"] });`,
      `  onInvalidation("fixture:subscribed", refresh);`,
      `  onInvalidation(FAKE_EVENT, refresh);`,
      `  fireInvalidation("fixture:alive");`,
      `  fireInvalidation(event);`,
      `  brokerAction("checks.auto", "rerun", {}, { invalidates: ["fixture:subscribed", FAKE_EVENT] });`,
      `}`,
    ].join("\n");
    const file = "planted/fixture.ts";
    const extracted = extractCensus(planted, file, constantMapOf([{ file, source: planted }]));
    const declaredNames = [...new Set(extracted.declared.map((s) => s.event))].sort();
    const firedNames = [...new Set(extracted.fired.map((s) => s.event))].sort();
    // The demand side sees exactly the spelled declarations — the comment,
    // the type position and the template interior contribute nothing, and
    // the constant resolves.
    expect(declaredNames).toEqual([
      "fixture:alive",
      "fixture:dormant",
      "fixture:fired-const",
      "fixture:subscribed",
    ]);
    // The supply side sees the direct fire, the invalidates literals and the
    // constant-threaded fire — but NOT the generic `fireInvalidation(event)`
    // dispatch, which names no event.
    expect(firedNames).toEqual([
      "fixture:alive",
      "fixture:fired-const",
      "fixture:subscribed",
    ]);
    // The dormancy the census exists for: declared minus fired names the
    // event, exactly as the production arm's red would.
    expect(declaredNames.filter((e) => !firedNames.includes(e))).toEqual([
      "fixture:dormant",
    ]);
    // Nothing in the planted source is unnameable on the demand side.
    expect(extracted.unnameable).toEqual([]);
    // The line the dormant declaration sits on is reported with the red, so
    // the remedy names a real place.
    expect(extracted.declared.find((s) => s.event === "fixture:dormant")?.line).toBe(6);
  });

  test("a declared identifier no constant defines is refused on the demand side and skipped on the supply side", () => {
    const planted = [
      `export function reads() {`,
      `  broker.read("sweep.spectrum", { invalidateOn: [UNDEFINED_EVENT, "fixture:declared"] });`,
      `  fireInvalidation(UNDEFINED_EVENT);`,
      `}`,
    ].join("\n");
    const file = "planted/unresolved.ts";
    const extracted = extractCensus(planted, file, new Map());
    // The unresolved identifier is refused with its site on the demand side…
    expect(extracted.unnameable).toEqual([
      { file, line: 2, entry: "UNDEFINED_EVENT" },
    ]);
    // …while the same identifier in a fire position is not a named firer:
    // "fixture:declared" still has no firer, which is the honest verdict for
    // a dispatch the census cannot read.
    expect(extracted.fired).toEqual([]);
    expect(extracted.declared.map((s) => s.event)).toEqual(["fixture:declared"]);
  });
});
