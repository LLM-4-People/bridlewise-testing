/**
 * THE MEASUREMENT CONTRACT'S MECHANICAL HALF.
 *
 * `engine/src/shared/measurement-registry.ts` declares every judged,
 * recorded or quoted signal. This module checks those declarations against
 * the tree and returns failures, never warnings:
 *
 *   producer     the module exists, exports the symbol, the declared
 *                derivation occurs IN THAT SYMBOL'S BODY and NOWHERE ELSE in
 *                the declared source universe (a second derivation of the
 *                same number is a defect);
 *   absence      the producer represents unreadability as null / a refusal /
 *                its declared sentinel, and carries no `?? 0`, `return 0` or
 *                zero-valued measurement field that would turn absent into a
 *                measured zero; a declared zero floor must be present and
 *                declared;
 *   quantity     the producer does not read a token that would prove it
 *                substituted a different quantity;
 *   load         an "agnostic" claim needs a normalisation step that the
 *                tree can prove; a "sensitive" claim needs a bound (and the
 *                deferral it names) or a registered finding;
 *   consumers    every declared gate/record/budget/doc consumer exists; every
 *                performance budget key is covered; every gate literal in an
 *                owned source is registered or declared non-measurement; a
 *                stale exemption is refused;
 *   universe     every measurement producer exported by a module that a
 *                declared consumer, a gate source or a registered producer
 *                imports is registered (no prefix allowlist);
 *   docs         a document token that names a budget/gate must resolve to a
 *                registered entry.
 *
 * ── THE UNIVERSE IS THE REPOSITORY'S OWNED WALK, NOT A ROOT LIST ──────────
 *
 * It used to scan six hand-written roots, so `bench/`, `server/` and `src/`
 * were outside the duplicate scan while a fourth division of ambient load sat
 * in `bench/lib/machine.ts` and a `?? 0` stood in two more. The walk in
 * `source-walk.ts` is the suite's one owner of "which files this repository
 * owns": it prunes ignored trees, refuses a missing or ignored root, and
 * cross-checks its answer against the git index. Reading it here means a new
 * top-level source directory is in scope the day it is committed.
 *
 * ── AND THE SCANNERS ARE THE SHARED ONES ─────────────────────────────────
 *
 * The checker used to carry a private walk, a private comment stripper and a
 * private `extractFunction` that took the first `{` after the parameter list.
 * The last one read a producer's `Readonly<{ value: number | null }>` return
 * type as its body, so a body that read a forbidden token passed; the private
 * stripper read `//` inside a regex literal as a comment, so a duplicate
 * derivation on that line was invisible. Both were certified by this guard's
 * own tests. The owners are `walk()` (source-walk.ts), the comments-only view
 * (source-view.ts) and `functionBody()` (source-structure.ts, which parses the
 * body instead of counting braces); this module calls them.
 *
 * The guard test drives this module over the real tree and over in-memory
 * plants: a duplicate derivation (including one hidden behind a regex
 * literal), a zero-for-absent, an unregistered gate in a new spelling and a
 * new file, an agnostic claim with no normalisation, and an unregistered
 * producer outside the old prefixes.
 */
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { WEB_PERFORMANCE_BUDGET_KINDS } from "../../src/kernel/web-performance-budgets.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  CPU_METRIC_PLACEHOLDERS,
  MEASUREMENT_DOC_ANCHOR,
  MEASUREMENT_DOC_SOURCE,
  MEASUREMENT_FINDINGS,
  MEASUREMENT_REGISTRY,
  NON_MEASUREMENT_CONSUMERS,
  NON_MEASUREMENT_GATES,
  NON_MEASUREMENT_PRODUCERS,
  type LoadBehaviour,
  type MeasurementFinding,
  type MetricConsumer,
  type MetricEntry,
} from "../../src/shared/measurement-registry.ts";
import { functionBodies, functionBody } from "../../src/shared/source-structure.ts";
import { SOURCE_EXTS, walk } from "./source-walk.ts";
import { sourceViewOf, stripCommentsOnly } from "./source-view.ts";

const REGISTRY_FILE = "engine/src/shared/measurement-registry.ts";
const CHECKER_FILE = "engine/scripts/verification/measurement-contract.ts";
/** Families whose members must state how they differ from one another. */
const REQUIRED_DISTINCTNESS_FAMILIES = new Set(["per-file.wall-duration", "ci.shard.duration"]);

/** The tree as the checker sees it; plants are applied by cloning this. */
export interface MeasurementWorld {
  readonly root: string;
  readonly sources: ReadonlyMap<string, string>;
  readonly docs: ReadonlyMap<string, string>;
  readonly other: ReadonlyMap<string, string>;
}

export interface MeasurementFailure {
  readonly code: string;
  readonly metric: string;
  readonly message: string;
}

export interface MeasurementContractReport {
  readonly failures: readonly MeasurementFailure[];
  readonly findings: readonly MeasurementFinding[];
  readonly checked: {
    readonly metrics: number;
    readonly placeholders: number;
    readonly sources: number;
    readonly budgets: number;
    readonly gates: number;
    /** Registry entries whose declared producer passed its clauses. */
    readonly registeredProducers: number;
    /**
     * The producer ids the universe scan actually FOUND — kept apart from the
     * registered count because `registered + discovered` cannot tell an empty
     * discovery from a clean one (a tree whose imports were all removed still
     * counted every registered entry).
     */
    readonly discoveredProducers: readonly string[];
  };
}

export interface MeasurementContractOptions {
  readonly registry?: readonly MetricEntry[];
  readonly placeholders?: readonly MetricEntry[];
  readonly findings?: readonly MeasurementFinding[];
}

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * A test tree's sources spell gates, derivations and producers as fixtures.
 * They are read by the guard's own plants, never executed as floor machinery;
 * the gate population therefore starts from production sources and adds a
 * test file only when the registry names it as a gate consumer.
 */
function isTestTree(path: string): boolean {
  return path.startsWith("tests/") || path.startsWith("engine/test/");
}

/**
 * The scan views, cached per world. The worlds a guard builds share their
 * source maps, so the clean tree's views are computed once across the file's
 * seven validations, while a plant's new map gets its own.
 */
const SCAN_VIEWS = new WeakMap<ReadonlyMap<string, string>, Map<string, string>>();

function scanCache(world: MeasurementWorld): Map<string, string> {
  const cached = SCAN_VIEWS.get(world.sources);
  if (cached !== undefined) return cached;
  const created = new Map<string, string>();
  SCAN_VIEWS.set(world.sources, created);
  return created;
}

/** The code view of a source: comments and literal interiors blanked, regex literals kept. */
function codeText(world: MeasurementWorld, path: string): string {
  const cache = scanCache(world);
  const key = `code\u0000${path}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const view = sourceViewOf(world.sources.get(path) ?? "", path).code();
  cache.set(key, view);
  return view;
}

/** The comments-only view of a source: comments blanked, every literal byte kept. */
function commentsOnlyText(world: MeasurementWorld, path: string): string {
  const cache = scanCache(world);
  const key = `comments\u0000${path}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const view = stripCommentsOnly(world.sources.get(path) ?? "");
  cache.set(key, view);
  return view;
}

/**
 * The view a duplicate scan reads a source through.
 *
 * A derivation that spells a string literal (`finiteDiagnosticMs(diagnostic,
 * "collectDuration")`) cannot be found in a view that blanks string
 * interiors, so it is scanned comments-only. A code-shaped derivation is
 * scanned with literals blanked, so a test fixture that spells the same
 * arithmetic inside a string is DATA and not a second computation.
 */
function duplicateScanText(world: MeasurementWorld, path: string, pattern: string): string {
  return pattern.includes('"') || pattern.includes("'")
    ? commentsOnlyText(world, path)
    : codeText(world, path);
}

/**
 * Read the declared source universe plus docs and the few non-source records.
 *
 * The universe is `walk()` over the repository root, which is the suite's one
 * ownership-pruned walk and refuses a missing root or one the repository does
 * not own. A second root list here is how `bench/`, `server/` and `src/`
 * silently left the measurement contract's jurisdiction.
 */
export function loadMeasurementWorld(root: string): MeasurementWorld {
  const repositoryRoot = resolve(root);
  const sources = new Map<string, string>();
  for (const absolute of walk(repositoryRoot, { exts: SOURCE_EXTS })) {
    const repoPath = toPosix(relative(repositoryRoot, absolute));
    sources.set(repoPath, readText(absolute) ?? "");
  }
  const docs = new Map<string, string>();
  for (const absolute of walk(join(repositoryRoot, "docs"), { exts: [".md"] })) {
    const repoPath = toPosix(relative(repositoryRoot, absolute));
    docs.set(repoPath, readText(absolute) ?? "");
  }
  const other = new Map<string, string>();
  for (const path of ["tests/test-shards.json", "package.json", "engine/package.json"]) {
    const text = readText(join(repositoryRoot, path));
    if (text !== null) other.set(path, text);
  }
  return { root: repositoryRoot, sources, docs, other };
}

/**
 * Carry a world's computed scan views to its clone, dropping the one path the
 * plant changed. A plant rewrites one file, so re-lexing the other 2,600 is
 * pure cost — and the guard's own tests build fifteen worlds per run.
 */
function cloneScanViews(from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>, changed: string): void {
  const cached = SCAN_VIEWS.get(from);
  if (cached === undefined) return;
  const copy = new Map(cached);
  copy.delete(`code\u0000${changed}`);
  copy.delete(`comments\u0000${changed}`);
  SCAN_VIEWS.set(to, copy);
}

/** Apply an in-memory plant without touching the checkout. */
export function withSource(world: MeasurementWorld, path: string, text: string): MeasurementWorld {
  const sources = new Map(world.sources);
  sources.set(path, text);
  cloneScanViews(world.sources, sources, path);
  return { ...world, sources };
}

/** Remove a source (a plant that deletes a producer). */
export function withoutSource(world: MeasurementWorld, path: string): MeasurementWorld {
  const sources = new Map(world.sources);
  sources.delete(path);
  cloneScanViews(world.sources, sources, path);
  return { ...world, sources };
}

/** A consumer file's text, from the source map or the auxiliary reads. */
function textOf(world: MeasurementWorld, path: string): string | null {
  return world.sources.get(path) ?? world.docs.get(path) ?? world.other.get(path) ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exportsSymbol(source: string, symbol: string): boolean {
  const name = escapeRegExp(symbol);
  return new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|interface|type)\\s+${name}\\b`, "u").test(source)
    || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`, "u").test(source);
}

function findingsById(findings: readonly MeasurementFinding[]): ReadonlyMap<string, MeasurementFinding> {
  return new Map(findings.map((finding) => [finding.id, finding]));
}

function registeredGates(
  registry: readonly MetricEntry[],
  placeholders: readonly MetricEntry[],
): ReadonlySet<string> {
  const gates = new Set<string>();
  for (const entry of [...registry, ...placeholders]) {
    for (const consumer of entry.consumers) {
      if (consumer.kind === "gate") gates.add(consumer.id);
    }
  }
  return gates;
}

function budgetKinds(): readonly string[] {
  return Object.keys(WEB_PERFORMANCE_BUDGET_KINDS);
}

function checkLoad(
  entry: MetricEntry,
  world: MeasurementWorld,
  findings: ReadonlyMap<string, MeasurementFinding>,
  fail: (code: string, message: string) => void,
): void {
  const load: LoadBehaviour = entry.load;
  if (load.kind === "placeholder") {
    if (load.note.trim().length < 20) fail("placeholder-without-note", "a placeholder must say what it reserves and who owns the final shape");
    return;
  }
  if (load.kind === "sensitive") {
    if (load.bound === null) {
      if (load.finding === null || !findings.has(load.finding)) {
        fail("sensitive-without-bound-or-finding", `sensitive with no bound must cite a registered finding (got ${String(load.finding)})`);
      }
    } else {
      if (!Number.isFinite(load.bound.value) || load.bound.value <= 0 || load.bound.defersAt.trim().length === 0) {
        fail("sensitive-bound-invalid", "a bound needs a positive value and the consumer/condition that defers past it");
      } else {
        const consumerText = entry.consumers
          .filter((consumer): consumer is Extract<MetricConsumer, { source: string }> => "source" in consumer)
          .map((consumer) => textOf(world, consumer.source) ?? "")
          .join("\n");
        if (!consumerText.includes(load.bound.defersAt)) {
          fail("sensitive-bound-unproven", `the declared deferral token ${JSON.stringify(load.bound.defersAt)} does not appear in any consumer`);
        }
      }
    }
    return;
  }
  if (load.normalization.trim().length < 20) {
    fail("agnostic-without-normalization", "an agnostic claim must name the normalisation step that removes host load");
  }
  const proofTexts = [
    world.sources.get(entry.producer.module) ?? "",
    ...entry.consumers
      .filter((consumer): consumer is Extract<MetricConsumer, { source: string }> => "source" in consumer)
      .map((consumer) => textOf(world, consumer.source) ?? ""),
  ];
  if (load.proof.trim().length === 0 || !proofTexts.some((text) => text.includes(load.proof))) {
    fail("agnostic-normalization-unproven", `the normalisation proof token ${JSON.stringify(load.proof)} does not appear in the producer or a consumer`);
  }
}

/**
 * ZERO FOR ABSENT, ACROSS THE WHOLE PRODUCER BODY.
 *
 * The check used to read a 240-byte window before and 360 bytes after the
 * declared derivation. The ambient producer's first two absence returns sat
 * outside that window, so replacing one with `perCpu: null → perCpu: 0` — the
 * exact defect the clause exists for — left the guard green; and a zero
 * assigned to the measurement's own field (`perCpu: 0`,
 * `{ load1: 0, … }`) was not in the vocabulary at all.
 *
 * The producer symbol is the scope now: one function computes one quantity,
 * so a zero fallback or a zero-valued field anywhere in it is a zero for this
 * measurement. The shard merge's own count parsing lives in a DIFFERENT
 * function (`readShard`), which is why naming the right producer (not the
 * module) is part of the contract rather than a comment.
 */
function checkAbsence(
  entry: MetricEntry,
  body: string,
  bodyWithStrings: string,
  fail: (code: string, message: string) => void,
): void {
  // A `?? 0` used only as a COUNT precondition (e.g. `totalCalls ?? 0) > 0`)
  // is not a value fallback: absent then takes the declared null branch. A
  // zero assigned to the measurement itself is still refused.
  const zeroFallback =
    /(?:\?\?|\|\|)\s*0\b(?!\s*\)?\s*[<>=!])|return\s+0\s*;|[{,]\s*[A-Za-z_$][\w$]*\s*:\s*0\b/u
      .test(body);
  const declaredFloor = entry.zero.kind === "floor";
  if (zeroFallback && !declaredFloor) {
    fail("zero-as-absent", "the producer carries a zero fallback or zero-valued measurement field; unreadable must be null, a refusal or the declared sentinel");
  }
  if (declaredFloor) {
    const floor = entry.zero.kind === "floor" ? entry.zero.value : 1;
    if (!new RegExp(`Math\\.max\\(\\s*${String(floor)}\\b`, "u").test(body)) {
      fail("declared-floor-missing", `the entry declares a floor of ${String(floor)} but the producer has no matching Math.max(...)`);
    }
  } else if (/Math\.max\(\s*1\b/u.test(body)) {
    fail("undeclared-zero-floor", "the producer floors a measurement but the entry declares no floor");
  }
  if (entry.absent.kind === "null") {
    if (!/\bnull\b/u.test(body)) fail("absence-not-represented", "the entry declares null absence but the producer never mentions null");
  } else if (entry.absent.kind === "sentinel") {
    // A sentinel IS a string literal, so this one branch reads the
    // comments-only view: the string must survive, the prose explaining it
    // must not count. (`body` has its string interiors blanked.)
    if (!bodyWithStrings.includes(entry.absent.value)) fail("absence-sentinel-missing", `the producer does not produce the declared sentinel ${JSON.stringify(entry.absent.value)}`);
  } else {
    if (!/\bnull\b|\bthrow\b|\bfail\(/u.test(body)) fail("absence-refusal-missing", "the entry declares a refusal but the producer has no refusal path");
  }
}

/**
 * THE PRODUCER MODULE IS NOT EXEMPT FROM THE DUPLICATE SCAN — ONLY THE
 * PRODUCER'S OWN BODY SPAN IS.
 *
 * The scan used to skip `entry.producer.module` wholesale, so a SECOND copy
 * of the formula in another function of the same module was invisible (a
 * plant with one division moved into a helper beside the producer passed).
 * Blanking the parsed body span (length-preserving, so the scan's offsets and
 * views stay aligned) lets the rest of the module be scanned like any other
 * file while the one legitimate spelling cannot report itself as a
 * duplicate.
 */
function withoutProducerBody(text: string, bodyOffset: number, bodyText: string): string {
  const start = bodyOffset;
  const end = start + bodyText.length;
  if (start < 0 || end > text.length || end < start) return text;
  return text.slice(0, start) + text.slice(start, end).replace(/[^\n]/gu, " ") + text.slice(end);
}

/**
 * Every module that IMPORTS or CALLS a producer symbol, excluding the
 * producer's own module and the registry/checker declarations.
 *
 * The consumer clause is TOTAL: using a registered producer without
 * declaring what you read from it is refused, rather than being invisible
 * because the module sits outside a hand-written root list. The scan is
 * cached per (world, producer) because the totality and stale-exemption
 * checks both read it.
 */
const CONSUMER_USE_CACHE = new WeakMap<ReadonlyMap<string, string>, Map<string, readonly string[]>>();

function consumerUsers(world: MeasurementWorld, producerModule: string, symbol: string): readonly string[] {
  let cache = CONSUMER_USE_CACHE.get(world.sources);
  if (cache === undefined) {
    cache = new Map();
    CONSUMER_USE_CACHE.set(world.sources, cache);
  }
  const key = `${producerModule}::${symbol}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const users: string[] = [];
  const callPattern = new RegExp(`\\b${escapeRegExp(symbol)}\\s*\\(`, "u");
  const importPattern = /import\s+(?:type\s+)?[^"'`;]+?\s+from\s+["'](\.{1,2}\/[^"']+)["']/gu;
  const symbolName = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, "u");
  for (const path of world.sources.keys()) {
    if (path === producerModule || path === REGISTRY_FILE || path === CHECKER_FILE) continue;
    if (callPattern.test(codeText(world, path))) {
      users.push(path);
      continue;
    }
    const importView = commentsOnlyText(world, path);
    for (const match of importView.matchAll(importPattern)) {
      if (!symbolName.test(match[0])) continue;
      if (resolveImport(path, match[1]!, world.sources) === producerModule) {
        users.push(path);
        break;
      }
    }
  }
  const frozen = Object.freeze(users.sort());
  cache.set(key, frozen);
  return frozen;
}

function checkProducer(
  entry: MetricEntry,
  world: MeasurementWorld,
  fail: (code: string, message: string) => void,
): number {
  const moduleText = world.sources.get(entry.producer.module);
  if (moduleText === undefined) {
    fail("producer-missing", `producer module ${entry.producer.module} is not in the declared source universe`);
    return 0;
  }
  if (!exportsSymbol(moduleText, entry.producer.symbol)) {
    fail("producer-not-exported", `${entry.producer.module} does not export ${entry.producer.symbol}`);
    return 0;
  }
  let rawBody: string;
  let bodyOffset: number;
  try {
    const scope = functionBody(moduleText, entry.producer.symbol, `${entry.producer.module} ${entry.producer.symbol}`);
    rawBody = scope.body;
    bodyOffset = scope.offset;
  } catch (error) {
    fail(
      "producer-body-unreadable",
      `cannot extract the body of ${entry.producer.symbol}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 0;
  }
  // THE BODY IS READ THROUGH A VIEW, NOT AS RAW BYTES. A comment above the
  // computation used to satisfy the declared derivation, so moving the real
  // arithmetic to a helper while leaving `// return loads[0] / cpuCount` in
  // place kept the producer "computing" it. The code view blanks comments and
  // string/template interiors; a derivation that legitimately spells a string
  // literal (the per-file collect entry names `"collectDuration"`) is read
  // through the comments-only view instead, exactly as the duplicate scan
  // chooses. One lexer, two views; no second stripper.
  const bodyPath = `${entry.producer.module}#${entry.producer.symbol}`;
  const codeBody = sourceViewOf(rawBody, bodyPath).code();
  const bodyWords = stripCommentsOnly(rawBody);
  const bodyViewFor = (pattern: string): string =>
    pattern.includes('"') || pattern.includes("'") ? bodyWords : codeBody;
  for (const forbidden of entry.producer.forbids) {
    if (codeBody.includes(forbidden)) {
      fail("forbidden-quantity", `the producer reads ${JSON.stringify(forbidden)} — a different quantity than the entry declares`);
    }
  }
  checkAbsence(entry, codeBody, bodyWords, fail);
  // THE BODY CLAUSE READS ONLY THE COMPUTE HALF. A `loadavg()` read is proof
  // the producer SAMPLED the fact, not that it computed the declared
  // quantity: a body that reads `loadavg()` and moves the division to a
  // helper satisfied the old union and passed. The READ half is a
  // duplicate-scan spelling only.
  const declaredPatterns = [...entry.producer.compute, ...entry.producer.reads];
  const inBody = entry.producer.compute.some((pattern) => new RegExp(pattern, "u").test(bodyViewFor(pattern)));
  if (!inBody) {
    fail(
      "derivation-not-in-producer",
      `none of the declared COMPUTE patterns occurs in ${entry.producer.symbol}'s body, so the named producer does not compute the declared quantity`,
    );
  }
  const moduleView = commentsOnlyText(world, entry.producer.module);
  const inModule = declaredPatterns.some((pattern) => new RegExp(pattern, "u").test(moduleView));
  if (!inModule) {
    fail(
      "derivation-not-found",
      `none of the declared derivations occurs in ${entry.producer.module}; the entry names a producer that does not compute this quantity`,
    );
  }
  // The union is scanned for duplicates; only the producer's own body span is
  // exempt in its module, never the module.
  for (const pattern of declaredPatterns) {
    const regex = new RegExp(pattern, "u");
    const duplicates: string[] = [];
    for (const path of world.sources.keys()) {
      if (path === REGISTRY_FILE || path === CHECKER_FILE) continue;
      const view = duplicateScanText(world, path, pattern);
      const scanText = path === entry.producer.module
        ? withoutProducerBody(view, bodyOffset, rawBody)
        : view;
      if (regex.test(scanText)) {
        duplicates.push(path === entry.producer.module ? `${path} (outside ${entry.producer.symbol}'s body)` : path);
      }
    }
    if (duplicates.length > 0) {
      fail("duplicate-derivation", `the same quantity is derived outside ${entry.producer.module}: ${duplicates.sort().join(", ")}`);
    }
  }
  return 1;
}

function checkConsumers(
  entry: MetricEntry,
  world: MeasurementWorld,
  fail: (code: string, message: string) => void,
): void {
  for (const consumer of entry.consumers) {
    if (consumer.kind === "budget") {
      const key = consumer.id.startsWith("webUi.performance.") ? consumer.id.slice("webUi.performance.".length) : null;
      if (key === null || !budgetKinds().includes(key)) {
        fail("consumer-budget-unregistered", `budget consumer ${consumer.id} is not a declared web performance budget`);
      }
      continue;
    }
    if (consumer.kind === "gate" && consumer.id.startsWith("performance:")) {
      const key = consumer.id.slice("performance:".length);
      if (!budgetKinds().includes(key)) fail("consumer-gate-unregistered", `gate consumer ${consumer.id} names no declared budget`);
      continue;
    }
    const text = textOf(world, consumer.source);
    if (text === null) {
      fail("consumer-source-missing", `${consumer.kind} consumer ${consumer.id} names missing source ${consumer.source}`);
      continue;
    }
    if (!text.includes(consumer.id)) {
      fail("consumer-not-found", `${consumer.kind} consumer ${consumer.id} does not appear in ${consumer.source}`);
    }
    if (consumer.kind === "doc" && !text.includes(consumer.anchor)) {
      fail("consumer-doc-anchor-missing", `doc consumer ${consumer.id} needs the anchor phrase ${JSON.stringify(consumer.anchor)} in ${consumer.source}`);
    }
  }
  // TOTALITY: a module that imports or calls the producer symbol must declare
  // what it reads (a consumer entry) or say why it reads nothing
  // (NON_MEASUREMENT_CONSUMERS). A hand-maintained consumer list cannot be
  // complete by memory; this is what makes an omission a refusal.
  const declaredSources = new Set(entry.consumers.flatMap((consumer) => "source" in consumer ? [consumer.source] : []));
  for (const path of consumerUsers(world, entry.producer.module, entry.producer.symbol)) {
    const exemption = NON_MEASUREMENT_CONSUMERS[`${path}::${entry.producer.symbol}`];
    if (declaredSources.has(path)) {
      if (exemption !== undefined) {
        fail("consumer-double-declared", `${path} is both a declared consumer of ${entry.name} and a declared non-consumer; one module has one answer`);
      }
      continue;
    }
    if (exemption === undefined) {
      fail(
        "undeclared-consumer",
        `${path} imports or calls ${entry.producer.symbol} but is neither a declared consumer of ${entry.name} nor a declared non-consumer with a reason`,
      );
    }
  }
}

/**
 * A non-consumer exemption is a sentence about a use that EXISTS: a stale
 * entry (the module stopped touching the producer) would hide the next
 * consumer that reuses the name.
 */
function checkConsumerExemptions(
  world: MeasurementWorld,
  registry: readonly MetricEntry[],
  fail: (metric: string, code: string, message: string) => void,
): void {
  const found = new Set<string>();
  for (const entry of registry) {
    for (const path of consumerUsers(world, entry.producer.module, entry.producer.symbol)) {
      found.add(`${path}::${entry.producer.symbol}`);
    }
  }
  for (const key of Object.keys(NON_MEASUREMENT_CONSUMERS)) {
    if (!found.has(key)) {
      fail(key, "stale-consumer-exemption", `the non-consumer exemption ${JSON.stringify(key)} no longer appears in the import universe (reason: ${NON_MEASUREMENT_CONSUMERS[key]})`);
    }
  }
}

function checkRegistryShape(
  registry: readonly MetricEntry[],
  fail: (metric: string, code: string, message: string) => void,
  allowPlaceholders = false,
): void {
  const names = new Set<string>();
  for (const entry of registry) {
    if (entry.name.trim().length === 0) fail(entry.name, "registry-entry-unnamed", "every entry needs a namespaced name");
    if (names.has(entry.name)) fail(entry.name, "registry-duplicate-name", "the registry names the same metric twice");
    names.add(entry.name);
    if (entry.unit.trim().length === 0) fail(entry.name, "registry-entry-unitless", "every entry declares one unit");
    if (entry.status === "placeholder" && !allowPlaceholders) fail(entry.name, "placeholder-in-main-registry", "reserved entries belong in CPU_METRIC_PLACEHOLDERS, not the finished registry");
  }
}

function checkFamilies(
  registry: readonly MetricEntry[],
  fail: (metric: string, code: string, message: string) => void,
): void {
  for (const entry of registry) {
    if (entry.family === null || !REQUIRED_DISTINCTNESS_FAMILIES.has(entry.family)) continue;
    const siblings = registry.filter((other) => other !== entry && other.family === entry.family);
    for (const sibling of siblings) {
      const mine = entry.distinctFrom.find((row) => row.name === sibling.name);
      if (mine === undefined || mine.reason.trim().length < 20) {
        fail(entry.name, "family-distinctness-missing", `sibling ${sibling.name} in family ${entry.family} needs a stated distinction`);
      }
      const theirs = sibling.distinctFrom.find((row) => row.name === entry.name);
      if (theirs === undefined || theirs.reason.trim().length < 20) {
        fail(sibling.name, "family-distinctness-missing", `sibling ${entry.name} in family ${sibling.family} needs a stated distinction`);
      }
    }
  }
}

function checkBudgetCoverage(
  registry: readonly MetricEntry[],
  fail: (metric: string, code: string, message: string) => void,
): void {
  for (const key of budgetKinds()) {
    const owner = registry.find((entry) => entry.consumers.some((consumer) => consumer.kind === "budget" && consumer.id === `webUi.performance.${key}`));
    if (owner === undefined) fail(key, "budget-unregistered", `webUi.performance.${key} has no registered metric`);
  }
  const policy = ROOT_POLICY.workflow.webPerformanceBudgets;
  if (policy.gatePrefix !== "performance:") fail("webPerformanceBudgets", "budget-gate-prefix-drift", "the engine's gate prefix is not the one the registry maps");
  if (policy.ledgerField !== "performanceMeasurements") fail("webPerformanceBudgets", "budget-ledger-field-drift", "the engine's ledger field is not the one the registry maps");
}

/**
 * A gate literal, in EVERY spelling the language has: double-quoted,
 * single-quoted and template. A template's interpolations are part of the
 * literal text (`engine-${reason}`), so a dynamic gate is judged by the text
 * it is written as rather than silently skipped.
 *
 * The scan reads the comments-only view: a gate NAMED in a comment judges
 * nothing, and the old raw-byte pattern counted one.
 */
const GATE_LITERAL = /\bgate\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/gu;

/**
 * Every source whose `gate:` literals are part of the declared gate universe.
 *
 * Derived, never listed: every owned production source that carries a gate
 * literal, plus every source a registry entry names as a gate consumer (the
 * reporter and the performance regression gate live under `tests/`, but the
 * registry declares them and a gate there still judges a measurement). A new
 * gate in a new file is in the population the moment it is committed; the
 * old six-file list is how two real engine gates — `engine-execution` and
 * `engine-test-results` — sat outside the guard until someone added the file
 * by hand.
 */
function gateSources(
  world: MeasurementWorld,
  registry: readonly MetricEntry[],
  placeholders: readonly MetricEntry[],
): ReadonlySet<string> {
  const sources = new Set<string>();
  for (const path of world.sources.keys()) {
    if (isTestTree(path)) continue;
    if ([...commentsOnlyText(world, path).matchAll(GATE_LITERAL)].length > 0) sources.add(path);
  }
  for (const entry of [...registry, ...placeholders]) {
    for (const consumer of entry.consumers) {
      if ("source" in consumer && world.sources.has(consumer.source)) sources.add(consumer.source);
    }
  }
  return sources;
}

function checkGates(
  world: MeasurementWorld,
  sources: ReadonlySet<string>,
  registry: readonly MetricEntry[],
  placeholders: readonly MetricEntry[],
  nonMeasurementGates: Readonly<Record<string, string>>,
  fail: (metric: string, code: string, message: string) => void,
): number {
  const registered = registeredGates(registry, placeholders);
  const seen = new Set<string>();
  for (const source of sources) {
    const text = world.sources.get(source);
    if (text === undefined) {
      fail(source, "gate-source-missing", `declared gate source ${source} is not in the source universe`);
      continue;
    }
    const view = sourceViewOf(text, source).codeWithStringsAndTemplates();
    for (const match of view.matchAll(GATE_LITERAL)) {
      const gate = match[1] ?? match[2] ?? match[3] ?? "";
      seen.add(gate);
      if (registered.has(gate)) continue;
      if (Object.hasOwn(nonMeasurementGates, gate)) continue;
      fail(gate, "unregistered-gate", `gate ${JSON.stringify(gate)} in ${source} judges no registered measurement and has no declared non-measurement reason`);
    }
  }
  for (const [gate, reason] of Object.entries(nonMeasurementGates)) {
    if (!seen.has(gate)) fail(gate, "stale-gate-exemption", `the non-measurement exemption ${JSON.stringify(gate)} no longer appears in a gate source (reason: ${reason})`);
  }
  return seen.size;
}

function resolveImport(importer: string, specifier: string, sources: ReadonlyMap<string, string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = join(dirname(importer), specifier);
  const candidates = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, `${base}.mts`, join(base, "index.ts"), join(base, "index.mjs")];
  for (const candidate of candidates) {
    const normalized = toPosix(candidate);
    if (sources.has(normalized)) return normalized;
  }
  return null;
}

/** A measurement producer is an exported function that reads a raw clock/
 *  counter/file fact and advertises a measurement in its name or signature. */
function isMeasurementProducer(name: string, signature: string, body: string): boolean {
  const raw = /loadavg\(|cpuUsage\(|hrtime|performance\.now\(|statSync\(|readFileSync\(|createHash\(|endTime|startTime|collectDuration|durationMs/u;
  const nameSignal = /(Ms|Cpu|Load|Hash|Bytes|Count|Duration|Occupancy|Weight|Latency|Time|Cost|Measurement|Metric|Reading|Summary|Measured)/u;
  const typeSignal = /number|Ms\b|Cpu|Load|Hash|Bytes|Count|Duration|Occupancy|Weight|Latency|Time|Reading|Summary|RunCpu|Warmth/iu;
  return raw.test(body) && (nameSignal.test(name) || typeSignal.test(signature));
}

/**
 * Every exported function declaration in a module, with the body the parser
 * found and the declaration text before it.
 *
 * The discovery regex reads the comments-only, length-preserving view so a
 * commented-out `export function` is not a producer and the match offsets are
 * the source's own; `functionBodies` then supplies the PARSE span, so a
 * return type spelled `Readonly<{ … }>` can never be mistaken for the body.
 */
function exportedFunctions(source: string, modulePath: string): readonly { name: string; signature: string; body: string }[] {
  const view = sourceViewOf(source, modulePath).codeWithStringsAndTemplates();
  const found: { name: string; signature: string; body: string }[] = [];
  const pattern = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/gu;
  for (const match of view.matchAll(pattern)) {
    const name = match[1]!;
    let scopes;
    try {
      scopes = functionBodies(source, name, `${modulePath} ${name}`);
    } catch {
      // A module the TypeScript parser cannot read exports no producer it
      // can name; the declarations it DOES hold are found above. This is a
      // stated edge, not a pass: the module is still in the universe, and a
      // parse failure here is not a claim that it has no producers.
      continue;
    }
    for (const scope of scopes) {
      found.push({ name, signature: source.slice(match.index, scope.offset), body: scope.body });
    }
  }
  return found;
}

/**
 * Every measurement producer a declared consumer, a gate source or a
 * registered producer imports must be registered.
 *
 * NO PREFIX ALLOWLIST. This used to skip any import outside
 * `engine/src/shared`, `scripts/testing`, `tests/performance/lib` and
 * `tests/reporters` BEFORE looking for producers, so a producer in
 * `engine/src/process` or a new product area was invisible; four registered
 * producers lived outside those prefixes while the failure text claimed
 * "no opt-out list". The roots are the declared consumers/gates and the
 * registry's own producer modules, and every relative import of each is
 * inspected.
 */
function checkProducerUniverse(
  world: MeasurementWorld,
  registry: readonly MetricEntry[],
  placeholders: readonly MetricEntry[],
  gates: ReadonlySet<string>,
  fail: (metric: string, code: string, message: string) => void,
): readonly string[] {
  const registered = new Set([...registry, ...placeholders].map((entry) => `${entry.producer.module}::${entry.producer.symbol}`));
  const roots = new Set<string>(gates);
  for (const entry of [...registry, ...placeholders]) {
    roots.add(entry.producer.module);
    for (const consumer of entry.consumers) {
      if ("source" in consumer && world.sources.has(consumer.source)) roots.add(consumer.source);
    }
  }
  const importPattern = /(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu;
  const inspected = new Set<string>();
  const discovered: string[] = [];
  for (const consumer of roots) {
    const text = world.sources.get(consumer);
    if (text === undefined) continue;
    for (const match of text.matchAll(importPattern)) {
      const imported = resolveImport(consumer, match[1]!, world.sources);
      if (imported === null || inspected.has(imported)) continue;
      inspected.add(imported);
      const moduleText = world.sources.get(imported)!;
      for (const fn of exportedFunctions(moduleText, imported)) {
        if (!isMeasurementProducer(fn.name, fn.signature, fn.body)) continue;
        const id = `${imported}::${fn.name}`;
        discovered.push(id);
        if (!registered.has(id) && !Object.hasOwn(NON_MEASUREMENT_PRODUCERS, id)) {
          fail(fn.name, "unregistered-producer", `measurement producer ${id} is read by ${consumer} but is absent from the registry (no opt-out list)`);
        }
      }
    }
  }
  const found = new Set(discovered);
  for (const [id, reason] of Object.entries(NON_MEASUREMENT_PRODUCERS)) {
    if (!found.has(id)) {
      fail(id, "stale-producer-exemption", `the non-measurement producer exemption ${JSON.stringify(id)} no longer appears in an inspected module (reason: ${reason})`);
    }
  }
  return discovered.sort();
}

function checkDocs(
  world: MeasurementWorld,
  registry: readonly MetricEntry[],
  fail: (metric: string, code: string, message: string) => void,
): void {
  const doc = world.docs.get(MEASUREMENT_DOC_SOURCE);
  if (doc === undefined) {
    fail(MEASUREMENT_DOC_SOURCE, "doc-missing", "the registry's reader-facing document is absent");
    return;
  }
  if (!doc.includes(MEASUREMENT_DOC_ANCHOR)) {
    fail(MEASUREMENT_DOC_SOURCE, "doc-anchor-missing", `the document must carry the section ${JSON.stringify(MEASUREMENT_DOC_ANCHOR)}`);
  }
  if (!doc.includes("engine/src/shared/measurement-registry.ts") || !doc.includes("tests/prevention/measurement-contract.test.ts")) {
    fail(MEASUREMENT_DOC_SOURCE, "doc-registry-path-missing", "the document must name the registry and its guard");
  }
  const names = new Set(registry.flatMap((entry) => entry.consumers.flatMap((consumer) => {
    if (consumer.kind === "budget" && consumer.id.startsWith("webUi.performance.")) return [consumer.id.slice("webUi.performance.".length)];
    return [];
  })));
  for (const [path, text] of world.docs) {
    for (const match of text.matchAll(/webUi\.performance\.([A-Za-z][\w]*)/gu)) {
      if (!names.has(match[1]!)) fail(match[1]!, "doc-unregistered-budget", `${path} names webUi.performance.${match[1]} but no registry entry maps it`);
    }
  }
}

/** Run every clause over one world. An empty failures list is the only pass. */
export function validateMeasurementContract(
  world: MeasurementWorld,
  options: MeasurementContractOptions = {},
): MeasurementContractReport {
  const registry = options.registry ?? MEASUREMENT_REGISTRY;
  const placeholders = options.placeholders ?? CPU_METRIC_PLACEHOLDERS;
  const findings = options.findings ?? MEASUREMENT_FINDINGS;
  const nonMeasurementGates = NON_MEASUREMENT_GATES;
  const failureList: MeasurementFailure[] = [];
  const fail = (metric: string, code: string, message: string): void => {
    failureList.push({ code, metric, message });
  };
  checkRegistryShape(registry, fail);
  checkRegistryShape(placeholders, fail, true);
  const findingMap = findingsById(findings);

  let registeredProducers = 0;
  for (const entry of registry) {
    const before = failureList.length;
    if (checkProducer(entry, world, (code, message) => fail(entry.name, code, message)) === 1) registeredProducers += 1;
    checkConsumers(entry, world, (code, message) => fail(entry.name, code, message));
    checkLoad(entry, world, findingMap, (code, message) => fail(entry.name, code, message));
    if (failureList.length > before && entry.status === "placeholder") {
      // A placeholder is allowed to be stale only in ways the CPU change owns;
      // its producer still has to exist.
      continue;
    }
  }
  for (const entry of placeholders) {
    if (world.sources.get(entry.producer.module) === undefined) {
      fail(entry.name, "placeholder-producer-missing", `the reserved producer module ${entry.producer.module} is absent`);
    } else if (!exportsSymbol(world.sources.get(entry.producer.module)!, entry.producer.symbol)) {
      fail(entry.name, "placeholder-producer-not-exported", `the reserved producer ${entry.producer.symbol} is no longer exported`);
    }
    if (entry.load.kind !== "placeholder") fail(entry.name, "placeholder-not-marked", "a reserved entry must declare load.kind = placeholder");
  }
  checkFamilies(registry, fail);
  checkBudgetCoverage(registry, fail);
  checkConsumerExemptions(world, registry, fail);
  const gates = checkGates(world, gateSources(world, registry, placeholders), registry, placeholders, nonMeasurementGates, fail);
  const discoveredProducers = checkProducerUniverse(world, registry, placeholders, gateSources(world, registry, placeholders), fail);
  checkDocs(world, registry, fail);

  return {
    failures: Object.freeze(failureList),
    findings: Object.freeze([...findings]),
    checked: {
      metrics: registry.length,
      placeholders: placeholders.length,
      sources: world.sources.size,
      budgets: budgetKinds().length,
      gates,
      registeredProducers,
      discoveredProducers: Object.freeze(discoveredProducers),
    },
  };
}

/** Read the checked-in tree and validate it with the checked-in registry. */
export function validateRepositoryMeasurementContract(root: string): MeasurementContractReport {
  return validateMeasurementContract(loadMeasurementWorld(root));
}
