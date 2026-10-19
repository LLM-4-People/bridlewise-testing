// @vitest-environment node
/**
 * The memory config READER PATHS — every `memory` section key the config
 * owner reads must be a path the config document schema declares, and
 * every `memory.*` row the settings surface serves must keep a reader.
 *
 * A reader of an undeclared path is a knob that cannot exist: the write
 * gate validates the whole document against the strict schema and refuses
 * the unknown key, so the reader's private fallback is the only value it
 * can ever return — a "configurable via memory.…" docstring that no
 * sanctioned door can honor. The measured class: seven server readers
 * consumed paths the schema refused, each with a hardcoded fallback no
 * operator could override, while a declared sibling leaf sat writable but
 * unconsumed.
 *
 * DYNAMIC DISCOVERY: the key set below is discovered by scanning the
 * config owner's source for optional-chain memory-section reads
 * (`…memory?.<key>`), never restated here. A reader added tomorrow that
 * points at an undeclared key reds by name the day it lands.
 *
 * The charter is the config owner (`server/kernel/harness-config.ts`) —
 * the single file where raw config paths are read. The reads that do not
 * appear there as literals are followed to their owners: the
 * whole-section handle's per-key consumer is the engine memory resolver
 * (its own resolved shape names the keys it consumes once per process), a
 * nested section the owner hands out through a section accessor is read
 * key-by-key by the consumer that calls that accessor, and the exposure
 * module's projection knobs are seeded from the document by literal
 * config-path calls in the module's own registration.
 *
 * THE JOINED DIRECTION (a served row must keep its reader): the
 * zombie-leaf sweep in exposure-reachable.test.ts forces declared→served
 * and the arms below force readers→declared, so together they pin
 * readers ⊆ declared ⊆ served — and nothing forced the fourth direction.
 * A leaf that was declared, registered as a settings row and then lost
 * its reader stayed a visible knob writing to nothing while both sweeps
 * ran green, which is the original phantom-leaf lie wearing a row. The
 * join lives here because the reader census is this sweep's subject:
 * every reading idiom is discovered from the owner that performs it, the
 * row side is served by the canonical registry, and an arm placed
 * anywhere else would have to restate the census.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  installCustomizationConfigStore,
  isConfigPathDeclared,
  listCustomizations,
  registerAllExposure,
  resetAllRegistrations,
  resolveMemoryConfig,
} from "../../server/kernel/canonical.ts";
import { serverConfig } from "../../server/kernel/config.ts";
import { consumersOf, modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { moduleSpecifiers, read, stripCommentsOnly } from "../helpers/source-scan.ts";

const HARNESS_CONFIG_SRC = readFileSync(modulePath("harness-config.ts"), "utf8");
// The owner's code, comments stripped — the discovery idioms below read this,
// never the raw text: a read commented out or mentioned in a doc comment is
// not a read, and a census that counted prose would stay green through the
// exact deletion this sweep exists to catch.
const HARNESS_CONFIG_CODE = stripCommentsOnly(HARNESS_CONFIG_SRC);

/** Every `memory?.<key>` read in the config owner, discovered from source. */
function discoveredMemoryReads(): readonly string[] {
  const keys = new Set<string>();
  for (const match of HARNESS_CONFIG_CODE.matchAll(/\.memory\?\.\s*([A-Za-z0-9_]+)/g)) {
    keys.add(match[1]!);
  }
  return [...keys];
}

/** The nested memory sections the owner hands out through an accessor: an
 * owner function that reads a member off the whole-section handle
 * (`const raw = getMemoryConfig(); … raw.<member>`). Scanned on the
 * comment-stripped code, so a doc mention of either idiom cannot mint a
 * section. */
function discoveredSectionAccessors(): readonly { accessor: string; member: string }[] {
  const out: { accessor: string; member: string }[] = [];
  for (const chunk of HARNESS_CONFIG_CODE.split("export function ")) {
    const head = chunk.match(/^([A-Za-z0-9_]+)\(/);
    const member = chunk.match(/\braw\.([A-Za-z0-9_]+)/);
    if (head === null || member === null || !chunk.includes("getMemoryConfig()")) continue;
    out.push({ accessor: head[1]!, member: member[1]! });
  }
  return out;
}

/** Every config path under `memory` that a real reader reads, discovered
 * from each reading idiom's own owner — never restated here. Four idioms
 * make a memory knob real:
 *
 *  - the config owner's per-call literal reads (`discoveredMemoryReads()`
 *    above) — the capture-and-search leaves;
 *  - the engine memory resolver's own shape (the keys of
 *    `resolveMemoryConfig({})`) — the whole-context leaves the context
 *    bridge resolves once per process through the owner's whole-section
 *    handle;
 *  - the nested sections the owner hands out through a section accessor —
 *    the consumer that calls the accessor bracket-reads each leaf off the
 *    returned section;
 *  - the exposure module's projection seeding — the working-memory
 *    window knobs, each named by a literal `seedFromConfig("memory.<key>",
 *    …)` call in the memory registration.
 *
 * A row's own `current()` mirror-read through the config store is how the
 * settings room displays a knob, not what makes it real, so it never
 * counts: vouching by the mirror would leave every served row "read" and
 * the census blind exactly where the phantom leaf once lived. */
function discoveredMemoryReadPaths(): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const key of discoveredMemoryReads()) paths.add(`memory.${key}`);
  for (const key of Object.keys(resolveMemoryConfig({}))) paths.add(`memory.${key}`);
  for (const { accessor, member } of discoveredSectionAccessors()) {
    for (const consumer of consumersOf("harness-config.ts", (src) => moduleSpecifiers(src, "all"), read)) {
      const consumerSource = stripCommentsOnly(read(consumer));
      if (!consumerSource.includes(`${accessor}(`)) continue;
      for (const match of consumerSource.matchAll(/\["([A-Za-z0-9_]+)"\]/g)) {
        paths.add(`memory.${member}.${match[1]}`);
      }
    }
  }
  const registrationSource = stripCommentsOnly(
    readFileSync(modulePathMatching("exposure/registrations/memory.ts"), "utf8"),
  );
  for (const match of registrationSource.matchAll(/seedFromConfig\("memory\.([A-Za-z0-9_]+)"/g)) {
    paths.add(`memory.${match[1]}`);
  }
  return paths;
}

describe("memory config reader paths — a reader of an undeclared path is a knob that cannot be set", () => {
  test("the scan found real memory-section reads (not a vacuous pass)", () => {
    const reads = discoveredMemoryReads();
    expect(reads.length, "the config owner must read memory-section keys for this guard to have a subject").toBeGreaterThan(0);
  });

  test("every memory-section key the config owner reads is a declared config path", () => {
    const missing: string[] = [];
    for (const key of discoveredMemoryReads()) {
      if (!isConfigPathDeclared(`memory.${key}`)) missing.push(`memory.${key}`);
    }
    expect(
      missing,
      "harness-config.ts reads memory keys the config document schema does not declare — the write gate refuses those paths, so each reader is a knob that cannot be set",
    ).toEqual([]);
  });
});

describe("memory rows keep their readers — a served row with no reader is a visible knob that writes to nothing", () => {
  beforeEach(() => {
    let doc: Record<string, unknown> = {};
    installCustomizationConfigStore({
      configFilePath: serverConfig.harnessConfigPath,
      readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
      writeDocument: (next) => {
        doc = next;
      },
    });
    resetAllRegistrations();
    registerAllExposure();
  });

  afterEach(() => {
    resetAllRegistrations();
  });

  test("every memory.* row the settings surface serves is a discovered read (no rows without readers)", () => {
    const served = listCustomizations()
      .map((c) => c.configPath)
      .filter((p): p is string => p !== undefined && p.startsWith("memory."))
      .sort();
    expect(
      served.length,
      "the settings surface must serve memory rows for this join to have a subject",
    ).toBeGreaterThan(0);
    const readPaths = discoveredMemoryReadPaths();
    const orphans = served.filter((path) => !readPaths.has(path));
    expect(
      orphans,
      "every memory.* row the settings surface serves must be a discovered read — a served row with no reader is a knob the room renders and the write gate honors while no code path consumes it",
    ).toEqual([]);
  });
});
