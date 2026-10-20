/**
 * THE MEASUREMENT CONTRACT'S MECHANICAL HALF.
 *
 * `engine/src/shared/measurement-registry.ts` declares every judged,
 * recorded or quoted signal. This module checks those declarations against
 * the tree and returns failures, never warnings:
 *
 *   producer     the module exists, exports the symbol, and the declared
 *                derivation occurs in that module and NOWHERE ELSE in the
 *                declared source universe (a second derivation of the same
 *                number is a defect);
 *   absence      the producer represents unreadability as null / a refusal
 *                / its declared sentinel, and carries no `?? 0` or
 *                `return 0` fallback that would turn absent into a measured
 *                zero; a declared zero floor must be present and declared;
 *   quantity     the producer does not read a token that would prove it
 *                substituted a different quantity;
 *   load         an "agnostic" claim needs a normalisation step that the
 *                tree can prove; a "sensitive" claim needs a bound (and the
 *                deferral it names) or a registered finding;
 *   consumers    every declared gate/record/budget/doc consumer exists; every
 *                performance budget key is covered; every gate literal in a
 *                measurement-producing gate source is registered or declared
 *                non-measurement; a stale exemption is refused;
 *   universe     every measurement producer exported by a module that a
 *                declared consumer imports is registered (no opt-out list);
 *   docs         a document token that names a budget/gate must resolve to a
 *                registered entry.
 *
 * The guard test drives this module over the real tree and over in-memory
 * plants (a duplicate, a zero-for-absent, an unregistered gate, an
 * agnostic claim with no normalisation, and an unregistered producer).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { WEB_PERFORMANCE_BUDGET_KINDS } from "../../src/kernel/web-performance-budgets.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  CPU_METRIC_PLACEHOLDERS,
  GATE_SOURCE_FILES,
  MEASUREMENT_DOC_ANCHOR,
  MEASUREMENT_DOC_SOURCE,
  MEASUREMENT_FINDINGS,
  MEASUREMENT_REGISTRY,
  NON_MEASUREMENT_GATES,
  type LoadBehaviour,
  type MeasurementFinding,
  type MetricConsumer,
  type MetricEntry,
} from "../../src/shared/measurement-registry.ts";

/** The source roots the contract's duplicate scan covers (tests excluded). */
const SOURCE_ROOTS: readonly string[] = [
  "engine/src",
  "engine/scripts",
  "scripts",
  "shared",
  "tests/reporters",
  "tests/performance",
];

const EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", "_experiments", "fixtures", ".git", ".site", "test-results"]);
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
    readonly producers: number;
  };
}

export interface MeasurementContractOptions {
  readonly registry?: readonly MetricEntry[];
  readonly placeholders?: readonly MetricEntry[];
  readonly findings?: readonly MeasurementFinding[];
  readonly nonMeasurementGates?: Readonly<Record<string, string>>;
  readonly gateSources?: readonly string[];
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function walk(directory: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, out);
    else if (/\.(ts|mjs|js|md)$/u.test(entry.name)) out.push(absolute);
  }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Read the declared source universe plus docs and the few non-source consumers. */
export function loadMeasurementWorld(root: string): MeasurementWorld {
  const repositoryRoot = resolve(root);
  const sources = new Map<string, string>();
  const docs = new Map<string, string>();
  const absoluteFiles: string[] = [];
  for (const sourceRoot of SOURCE_ROOTS) walk(join(repositoryRoot, sourceRoot), absoluteFiles);
  for (const absolute of absoluteFiles) {
    const repoPath = toPosix(relative(repositoryRoot, absolute));
    if (repoPath.startsWith("docs/")) docs.set(repoPath, readText(absolute) ?? "");
    else if (!/\.md$/u.test(repoPath)) sources.set(repoPath, readText(absolute) ?? "");
  }
  const docsRoot = join(repositoryRoot, "docs");
  const docFiles: string[] = [];
  walk(docsRoot, docFiles);
  for (const absolute of docFiles) {
    if (!/\.md$/u.test(absolute)) continue;
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

/** Apply an in-memory plant without touching the checkout. */
export function withSource(world: MeasurementWorld, path: string, text: string): MeasurementWorld {
  const sources = new Map(world.sources);
  sources.set(path, text);
  return { ...world, sources };
}

/** Remove a source (a plant that deletes a producer). */
export function withoutSource(world: MeasurementWorld, path: string): MeasurementWorld {
  const sources = new Map(world.sources);
  sources.delete(path);
  return { ...world, sources };
}

/** A consumer file's text, from the source map or the auxiliary reads. */
function textOf(world: MeasurementWorld, path: string): string | null {
  return world.sources.get(path) ?? world.docs.get(path) ?? world.other.get(path) ?? null;
}

/** Remove comments while preserving strings (a token inside a string counts). */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      out += char;
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          out += source[index]! + (source[index + 1] ?? "");
          index += 2;
          continue;
        }
        out += source[index]!;
        if (source[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      index = newline === -1 ? source.length : newline + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? source.length : close + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

function matchPair(source: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Find one exported (or local) function's signature and body. */
export function extractFunction(
  source: string,
  symbol: string,
): Readonly<{ signature: string; body: string }> | null {
  const stripped = stripComments(source);
  const pattern = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${escapeRegExp(symbol)}\\b`, "u");
  const match = pattern.exec(stripped);
  if (match === null) return null;
  const openParen = stripped.indexOf("(", match.index + match[0].length - 1);
  if (openParen === -1) return null;
  const closeParen = matchPair(stripped, openParen, "(", ")");
  if (closeParen === -1) return null;
  const bodyStart = stripped.indexOf("{", closeParen);
  if (bodyStart === -1) return null;
  const bodyEnd = matchPair(stripped, bodyStart, "{", "}");
  if (bodyEnd === -1) return null;
  return {
    signature: stripped.slice(match.index, bodyStart),
    body: stripped.slice(bodyStart, bodyEnd + 1),
  };
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
 * The region around a declared derivation. Zero fallbacks are checked THERE,
 * not across a whole multi-purpose function: the shard merge legitimately
 * parses test counts with `?? 0`, while the duration it records is a null
 * ternary. A whole-body scan would either fail a correct producer or force a
 * weaker check everywhere.
 */
function derivationWindows(entry: MetricEntry, body: string, moduleText: string): string {
  const windows: string[] = [];
  for (const pattern of entry.producer.derivation) {
    const regex = new RegExp(pattern, "gu");
    for (const text of [body, moduleText]) {
      regex.lastIndex = 0;
      for (const match of text.matchAll(regex)) {
        const index = match.index ?? 0;
        windows.push(text.slice(Math.max(0, index - 240), index + 360));
        break;
      }
    }
  }
  return windows.length === 0 ? body : windows.join("\n");
}

function checkAbsence(
  entry: MetricEntry,
  body: string,
  moduleText: string,
  fail: (code: string, message: string) => void,
): void {
  const scope = derivationWindows(entry, body, moduleText);
  // A `?? 0` used only as a COUNT precondition (e.g. `totalCalls ?? 0) > 0`)
  // is not a value fallback: absent then takes the declared null branch. A
  // zero assigned to the measurement itself is still refused.
  const zeroFallback = /(?:\?\?|\|\|)\s*0\b(?!\s*\)?\s*[<>=!])|return\s+0\s*;/u.test(scope);
  const declaredFloor = entry.zero.kind === "floor";
  if (zeroFallback && !declaredFloor) {
    fail("zero-as-absent", "the producer carries a zero fallback beside the declared derivation; unreadable must be null, a refusal or the declared sentinel");
  }
  if (declaredFloor) {
    const floor = entry.zero.kind === "floor" ? entry.zero.value : 1;
    if (!new RegExp(`Math\\.max\\(\\s*${String(floor)}\\b`, "u").test(body)) {
      fail("declared-floor-missing", `the entry declares a floor of ${String(floor)} but the producer has no matching Math.max(...)`);
    }
  } else if (/Math\.max\(\s*1\b/u.test(scope)) {
    fail("undeclared-zero-floor", "the producer floors a measurement but the entry declares no floor");
  }
  if (entry.absent.kind === "null") {
    if (!/\bnull\b/u.test(body)) fail("absence-not-represented", "the entry declares null absence but the producer never mentions null");
  } else if (entry.absent.kind === "sentinel") {
    if (!body.includes(entry.absent.value)) fail("absence-sentinel-missing", `the producer does not produce the declared sentinel ${JSON.stringify(entry.absent.value)}`);
  } else {
    if (!/\bnull\b|\bthrow\b|\bfail\(/u.test(body)) fail("absence-refusal-missing", "the entry declares a refusal but the producer has no refusal path");
  }
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
  const fn = extractFunction(moduleText, entry.producer.symbol);
  if (fn === null) {
    fail("producer-body-unreadable", `cannot extract the body of ${entry.producer.symbol}`);
    return 0;
  }
  for (const forbidden of entry.producer.forbids) {
    if (fn.body.includes(forbidden)) {
      fail("forbidden-quantity", `the producer reads ${JSON.stringify(forbidden)} — a different quantity than the entry declares`);
    }
  }
  checkAbsence(entry, fn.body, moduleText, fail);
  for (const pattern of entry.producer.derivation) {
    const regex = new RegExp(pattern, "u");
    if (!regex.test(moduleText)) {
      fail("derivation-not-found", `the declared derivation ${JSON.stringify(pattern)} does not occur in ${entry.producer.module}`);
    }
    const duplicates: string[] = [];
    for (const [path, text] of world.sources) {
      if (path === entry.producer.module || path === REGISTRY_FILE || path === CHECKER_FILE) continue;
      if (regex.test(stripComments(text))) duplicates.push(path);
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

function checkGates(
  world: MeasurementWorld,
  registry: readonly MetricEntry[],
  placeholders: readonly MetricEntry[],
  nonMeasurementGates: Readonly<Record<string, string>>,
  gateSources: readonly string[],
  fail: (metric: string, code: string, message: string) => void,
): number {
  const registered = registeredGates(registry, placeholders);
  const seen = new Set<string>();
  const gatePattern = /\bgate\s*[:=]\s*"([^"]+)"/gu;
  for (const source of gateSources) {
    const text = world.sources.get(source);
    if (text === undefined) {
      fail("gate-source", "gate-source-missing", `declared gate source ${source} is not in the source universe`);
      continue;
    }
    for (const match of text.matchAll(gatePattern)) {
      const gate = match[1]!;
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
  const candidates = [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, "index.ts"), join(base, "index.mjs")];
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

function exportedFunctions(source: string): readonly { name: string; signature: string; body: string }[] {
  const stripped = stripComments(source);
  const found: { name: string; signature: string; body: string }[] = [];
  const pattern = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*(?:<[^>]*>)?\s*\(/gu;
  for (const match of stripped.matchAll(pattern)) {
    const name = match[1]!;
    const fn = extractFunction(stripped, name);
    if (fn !== null) found.push({ name, ...fn });
  }
  return found;
}

function checkProducerUniverse(
  world: MeasurementWorld,
  registry: readonly MetricEntry[],
  placeholders: readonly MetricEntry[],
  fail: (metric: string, code: string, message: string) => void,
): number {
  const registered = new Set([...registry, ...placeholders].map((entry) => `${entry.producer.module}::${entry.producer.symbol}`));
  const consumerFiles = new Set<string>();
  for (const entry of [...registry, ...placeholders]) {
    for (const consumer of entry.consumers) {
      if ("source" in consumer && world.sources.has(consumer.source)) consumerFiles.add(consumer.source);
    }
  }
  for (const gateSource of GATE_SOURCE_FILES) consumerFiles.add(gateSource);
  const importPattern = /(?:from\s*|import\s*\()\s*["'](\.{1,2}\/[^"']+)["']/gu;
  const inspected = new Set<string>();
  let producers = 0;
  for (const consumer of consumerFiles) {
    const text = world.sources.get(consumer);
    if (text === undefined) continue;
    for (const match of text.matchAll(importPattern)) {
      const imported = resolveImport(consumer, match[1]!, world.sources);
      if (imported === null || inspected.has(imported)) continue;
      if (!/^(engine\/src\/shared|scripts\/testing|tests\/performance\/lib|tests\/reporters)\//u.test(imported)) continue;
      inspected.add(imported);
      const moduleText = world.sources.get(imported)!;
      for (const fn of exportedFunctions(moduleText)) {
        if (!isMeasurementProducer(fn.name, fn.signature, fn.body)) continue;
        producers += 1;
        const id = `${imported}::${fn.name}`;
        if (!registered.has(id)) {
          fail(fn.name, "unregistered-producer", `measurement producer ${id} is read by ${consumer} but is absent from the registry (no opt-out list)`);
        }
      }
    }
  }
  return producers;
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
  const nonMeasurementGates = options.nonMeasurementGates ?? NON_MEASUREMENT_GATES;
  const gateSources = options.gateSources ?? GATE_SOURCE_FILES;
  const failureList: MeasurementFailure[] = [];
  const fail = (metric: string, code: string, message: string): void => {
    failureList.push({ code, metric, message });
  };
  checkRegistryShape(registry, fail);
  checkRegistryShape(placeholders, fail, true);
  const findingMap = findingsById(findings);

  let producerCount = 0;
  for (const entry of registry) {
    const before = failureList.length;
    if (checkProducer(entry, world, (code, message) => fail(entry.name, code, message)) === 1) producerCount += 1;
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
  const gates = checkGates(world, registry, placeholders, nonMeasurementGates, gateSources, fail);
  const producers = checkProducerUniverse(world, registry, placeholders, fail);
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
      producers: producerCount + producers,
    },
  };
}

/** Read the checked-in tree and validate it with the checked-in registry. */
export function validateRepositoryMeasurementContract(root: string): MeasurementContractReport {
  return validateMeasurementContract(loadMeasurementWorld(root));
}
