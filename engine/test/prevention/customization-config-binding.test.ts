import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readSourceView } from "../../scripts/verification/source-view.ts";

import {
  getCustomization,
  listCustomizations,
  registerCustomization,
  resetCustomizationValue,
  setCustomizationValue,
} from "../../src/shared/exposure/index.ts";
import {
  configBoundSet,
  installCustomizationConfigStore,
  isConfigPathDeclared,
  readConfigCustomization,
  rememberConfigPathDefault,
  resetCustomizationConfigStore,
  seedFromConfig,
  withConfigDocumentSnapshot,
  writeConfigCustomization,
  type CustomizationConfigStore,
} from "../../src/shared/exposure/config-binding.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { GIT_COMMIT_TIMEOUT_MAX_MS } from "../../src/kernel/config-contracts.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * CONFIG BINDING — every published customization bound to a config path is
 * backed by the config document, not a per-process stub.
 *
 * The defect this guards: a module's registration owned a private mutable
 * state object with literal defaults, and `set` mutated that object only — the
 * value reset on restart, was never validated by the config schema, and the
 * settings UI showed a number the config file knew nothing about. Two parallel
 * configurable systems answered "what is this knob's value" differently.
 *
 * The fix binds a Customization to a `configPath`: `current` reads the config
 * document through the installed store and `set` writes through the store's
 * schema gate. This suite drives the REAL mechanism (an in-memory store, so no
 * test touches the on-disk config) and asserts the class:
 *
 *   READ-THROUGH — a config-bound knob's value comes from the document.
 *   WRITE-THROUGH — `set` lands in the document (and only there).
 *   GATE — a value the schema rejects is refused, never written.
 *   DENY-BY-DEFAULT — a `configPath` the schema does not declare refuses to
 *     register, so a module cannot publish a configurable the config
 *     vocabulary does not know about.
 *   OMIT-DEFAULT — a write of the path's declared default leaves the key
 *     absent so the catalog (schema `.default()` or registration default)
 *     supplies it; a non-default still assigns. Type-zeros are not defaults.
 *
 * DYNAMIC: the registered-config-path population comes from the live registry
 * (`listCustomizations`), never a hardcoded list — a customization bound
 * tomorrow is exercised tomorrow with no edit here.
 */

/** An in-memory config store seeded from the real on-disk document's shape. */
function memoryStore(initial: Record<string, unknown>): CustomizationConfigStore & {
  readonly doc: Record<string, unknown>;
  readonly writes: ReadonlyArray<Record<string, unknown>>;
} {
  // Held in a closure so reads see the CURRENT document (a spread of the
  // state would freeze the initial reference and hide every later write).
  let doc = initial;
  const writes: Array<Record<string, unknown>> = [];
  return {
    get doc() {
      return doc;
    },
    get writes() {
      return writes;
    },
    // A scratch path in the suite's own temp world: this store persists
    // nothing to a file, and the lock keyed on the declared path stays
    // vacuous — the declaration exists so the store contract cannot lie
    // about which file a host persists to.
    configFilePath: join(mkTempDir("config-binding-memory-store-"), "bridlewise.config.json"),
    readDocument: () => JSON.parse(JSON.stringify(doc)) as Record<string, unknown>,
    writeDocument: (next) => {
      writes.push(JSON.parse(JSON.stringify(next)) as Record<string, unknown>);
      doc = next;
    },
  };
}


/** Read memory.trimThreshold from a store document, typed. */
function memTrimThreshold(doc: Record<string, unknown>): unknown {
  const mem = doc.memory;
  return typeof mem === "object" && mem !== null ? (mem as Record<string, unknown>).trimThreshold : undefined;
}

function atPath(doc: Record<string, unknown>, path: string): unknown {
  let node: unknown = doc;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

function hasOwnPath(doc: Record<string, unknown>, path: string): boolean {
  let node: unknown = doc;
  for (const segment of path.split(".")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
    const record = node as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) return false;
    node = record[segment];
  }
  return true;
}

function liveConfigClone(): Record<string, unknown> {
  const engineRoot = fileURLToPath(new URL("../../", import.meta.url));
  return JSON.parse(readFileSync(join(engineRoot, "bridlewise.config.json"), "utf8")) as Record<string, unknown>;
}

function freshStore(initial: Record<string, unknown>): ReturnType<typeof memoryStore> {
  const store = memoryStore(initial);
  installCustomizationConfigStore(store);
  return store;
}

test("config binding: isConfigPathDeclared is the deny-by-default membership test", () => {
  // A real declared path resolves; an undeclared one does not.
  assert.equal(isConfigPathDeclared("memory.trimThreshold"), true, "memory.trimThreshold is a real declared path");
  assert.equal(isConfigPathDeclared("memory.definitelyNotAKnob"), false, "an undeclared key must not resolve");
  assert.equal(isConfigPathDeclared("noSuchSection.key"), false, "an undeclared section must not resolve");
  // A path one segment too deep (into a scalar leaf) is not a value path.
  assert.equal(isConfigPathDeclared("memory.trimThreshold.deeper"), false, "a path below a leaf must not resolve");
  // The safety run-path accessors consume these sections; they must be
  // declared so a settings write / hand-edit is persistable.
  assert.equal(isConfigPathDeclared("safety.eventFeed"), true, "safety.eventFeed is a declared write-gate path");
  assert.equal(isConfigPathDeclared("safety.toolCallGate"), true, "safety.toolCallGate is a declared write-gate path");
  assert.equal(isConfigPathDeclared("safety.eventFeed.families.workaround.enabled"), true, "event-feed family knobs are addressable");
});

test("config binding: read-through returns the document's value, not the default", () => {
  freshStore({ memory: { trimThreshold: 0.62 } });
  // The read returns the persisted value, proving it is not a stored constant.
  assert.equal(readConfigCustomization("memory.trimThreshold"), 0.62);
  // seedFromConfig returns the persisted value when present…
  assert.equal(seedFromConfig("memory.trimThreshold", 0.85), 0.62);
  // …and the declared default only when the path is genuinely absent.
  assert.equal(seedFromConfig("memory.windowSize", 4096), 4096);
  resetCustomizationConfigStore();
});

test("config binding: write-through lands in the document through the gate", () => {
  const store = freshStore({ memory: { trimThreshold: 0.62 } });
  writeConfigCustomization("memory.trimThreshold", 0.7);
  assert.equal(memTrimThreshold(store.doc), 0.7, "the document now holds the written value");
  assert.equal(store.writes.length, 1, "exactly one write reached the store");
  resetCustomizationConfigStore();
});

test("config binding: a schema-rejected value is refused and never written", () => {
  const store = freshStore({ memory: { trimThreshold: 0.62 } });
  // memory.trimThreshold is bounded [0.5, 0.99] in the config schema; 5 is out.
  assert.throws(
    () => writeConfigCustomization("memory.trimThreshold", 5),
    (err: unknown) => err instanceof InputError && (err as InputError).code === "customization_config_value_invalid",
    "an out-of-schema value must be refused with the typed error",
  );
  assert.equal(memTrimThreshold(store.doc), 0.62, "a refused write must not change the document");
  assert.equal(store.writes.length, 0, "a refused value never reaches the store's writeDocument");
  resetCustomizationConfigStore();
});

test("config binding: writing to an undeclared path is refused (deny-by-default)", () => {
  const store = freshStore({});
  assert.throws(
    () => writeConfigCustomization("memory.notARealKnob", 1),
    (err: unknown) => err instanceof InputError && (err as InputError).code === "customization_config_path_unknown",
    "a path the schema does not declare must be refused",
  );
  assert.equal(store.writes.length, 0, "nothing was written");
  resetCustomizationConfigStore();
});

test("config binding: registering a customization with an undeclared configPath is refused", () => {
  freshStore({});
  assert.throws(
    () =>
      registerCustomization({
        id: "zzprobe.bound",
        module: "zzprobe",
        name: "Probe bound to a nonexistent path",
        description: "A probe customization whose config path the schema does not declare.",
        type: "number",
        default: 1,
        min: 0,
        max: 10,
        current: () => 1,
        set: () => undefined,
        configPath: "zzprobe.doesNotExist",
      }),
    (err: unknown) => err instanceof InputError && (err as InputError).code === "customization_config_path_unknown",
    "a customization bound to an undeclared path must refuse to register",
  );
  resetCustomizationConfigStore();
});

test("config binding: configBoundSet writes the gate AND applies the projection", () => {
  const store = freshStore({ memory: { trimThreshold: 0.62 } });
  let projection = 0.62;
  const set = configBoundSet("memory.trimThreshold", (v) => {
    projection = Number(v);
  });
  set(0.7);
  assert.equal(memTrimThreshold(store.doc), 0.7, "the document holds the value");
  assert.equal(projection, 0.7, "the live projection was updated in the same call");
  // A refused write must NOT touch the projection (the gate runs first).
  assert.throws(() => set(5), (err: unknown) => err instanceof InputError);
  assert.equal(projection, 0.7, "a refused write left the projection unchanged");
  assert.equal(memTrimThreshold(store.doc), 0.7, "a refused write left the document unchanged");
  resetCustomizationConfigStore();
});

test("config binding: every registered configPath is declared in the schema (no dangling bindings)", () => {
  // Register nothing here — this asserts over the modules registered by the
  // suite that imports this file's siblings. To make the population real even
  // in isolation, register the full exposure surface with the engine store.
  // Install a store so registration can seed projections, then register the
  // full surface fresh (resetting the per-module flags so registration runs).
  installCustomizationConfigStore(memoryStore({}));
  // Dynamic discovery: pull every registered customization that declares a
  // configPath and assert its path resolves. Registered lazily via the index.
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const bound = listCustomizations().filter((c) => c.configPath !== undefined);
      assert.ok(bound.length > 0, "at least one customization is config-bound (the population is real)");
      const dangling = bound.filter((c) => !isConfigPathDeclared(c.configPath!));
      assert.deepEqual(
        dangling.map((c) => `${c.id} -> ${c.configPath}`),
        [],
        "every config-bound customization's path must be declared in the config schema",
      );
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: served customizations read the config value, not a stub default", () => {
  // The integration point the user sees: after registration, a config-bound
  // customization's `current` reflects the persisted document. We install a
  // store holding a NON-default value and register the surface fresh (resetting
  // the per-module registration flags so the re-seed runs), then read a known
  // config-bound knob through the public getter.
  const store = memoryStore({ search: { threshold: 0.91 } });
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const searchThreshold = getCustomization("search.threshold");
      assert.ok(searchThreshold !== undefined, "search.threshold is registered");
      assert.equal(searchThreshold.configPath, "search.threshold", "search.threshold is config-bound");
      assert.equal(
        searchThreshold.current(),
        0.91,
        "the served value is the persisted config value, not the stub default 0.5",
      );
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: an out-of-band config edit is served live, not a stale projection", () => {
  // The defect: a projection-backed knob's `current` read the module's
  // in-memory state, which is seeded once at registration and otherwise moves
  // only on the knob's own `set`. A raw config edit (`PUT /api/config`, or an
  // operator editing the file) changed the document without touching the
  // projection, so the settings UI served a value the config file had already
  // left behind — the two-sources divergence the binding exists to end. The
  // read must go through the store on EVERY `current`, not only at seed time.
  //
  // Drive it: register with threshold 0.5, then mutate the document out of
  // band (no set, no re-seed — an idempotent re-register must NOT re-seed),
  // and assert the served value tracks the document.
  const store = memoryStore({ search: { threshold: 0.5 } });
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const knob = getCustomization("search.threshold");
      assert.ok(knob !== undefined, "search.threshold is registered");
      assert.equal(knob.current(), 0.5, "seeded from the document at registration");
      // Out-of-band edit: the document now says 0.91. No set() ran, and the
      // idempotent re-register does not re-seed the projection — so a stale
      // read returns 0.5 and a live read returns 0.91.
      store.writeDocument({ search: { threshold: 0.91 } });
      registerAllExposure();
      assert.equal(
        knob.current(),
        0.91,
        "a config edit outside the customization set path must be served live, not the stale projection",
      );
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: registration files declare configPath alongside set (mechanical, dynamic)", () => {
  // A config-bound customization whose `set` does NOT go through the gate is
  // the wired-but-inert shape: it would mutate state and never persist. Scan
  // the registration sources: every `configPath:` declaration must sit in a
  // customization whose `set` writes the SAME path through the gate — either
  // `configBoundSet(path, …)` (projection-backed) or `writeConfigCustomization(path, …)`
  // (config-direct). Read through the code-with-strings view: the paths ARE
  // string literals, so a string-blanking view would go blind to them.
  const registrationsDir = fileURLToPath(new URL("../../src/shared/exposure/registrations/", import.meta.url));
  const files = readdirSync(registrationsDir).filter((f) => f.endsWith(".ts") && f !== "index.ts");
  const failures: string[] = [];
  for (const file of files) {
    const source = readSourceView(join(registrationsDir, file)).codeWithStrings();
    for (const match of source.matchAll(/configPath:\s*"([^"]+)"/g)) {
      const path = match[1]!;
      const bound =
        source.includes(`configBoundSet("${path}"`) ||
        source.includes(`writeConfigCustomization("${path}"`) ||
        (source.includes(`configPath: "${path}"`) &&
          /writeConfigCustomization\(\s*(?:spec\.)?configPath/.test(source));
      if (!bound) {
        failures.push(`${file}: declares configPath "${path}" but no config-gated setter writes it`);
      }
    }
  }
  assert.deepEqual(failures, [], `configPath declarations without a config-bound setter:\n${failures.join("\n")}`);
});

test("config binding: the mcp module publishes its defaults bound to the tools.mcp config section", () => {
  // The MCP test case: the module-wide defaults (retry count, retry backoff,
  // call timeout) are registered as config-bound customizations, so they render
  // in the settings UI and persist through the gate. Drive the real surface:
  // install a store holding a non-default MCP value and register fresh.
  const store = memoryStore({ tools: { mcp: { retryCount: 7, timeoutMs: 45000, closeGraceMs: 900 } } });
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const mcp = listCustomizations().filter((c) => c.module === "mcp");
      assert.ok(mcp.length > 0, "the mcp module registers at least one customization");
      for (const c of mcp) {
        assert.ok(c.configPath !== undefined, `${c.id} must be config-bound`);
        assert.ok(
          c.configPath.startsWith("tools.mcp."),
          `${c.id} must bind into the tools.mcp section, got ${c.configPath}`,
        );
      }
      // The served value is the persisted config value, not the module default.
      const retryCount = getCustomization("mcp.retryCount");
      assert.equal(retryCount?.current(), 7, "mcp.retryCount reads the persisted config value");
      const timeout = getCustomization("mcp.timeout");
      assert.equal(timeout?.current(), 45000, "mcp.timeout reads the persisted config value");
      // The stdio stop-grace knob publishes through the same binding — a
      // module default the settings UI does not expose is a configurable the
      // web cannot reach.
      const termination = getCustomization("mcp.closeGraceMs");
      assert.ok(termination !== undefined, "mcp.closeGraceMs must be published with the module's other knobs");
      assert.equal(termination.current(), 900, "mcp.closeGraceMs reads the persisted config value");
      // A knob with no persisted override reads its declared default.
      const backoff = getCustomization("mcp.retryBackoff");
      assert.equal(backoff?.current(), 1000, "mcp.retryBackoff reads its default when config omits it");
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: the workspace commit timeout's setting spans exactly the schema's bound — one constant (WF-1b3c-FIX MED-4)", () => {
  // The schema raised the bound for a loaded machine's commit hook while the
  // setting kept the old one: the settings surface refused values the
  // document accepts. Both now read GIT_COMMIT_TIMEOUT_MAX_MS.
  const store = memoryStore(liveConfigClone());
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const commit = getCustomization("workspaceGit.timeoutsCommitMs");
      assert.equal(commit?.max, GIT_COMMIT_TIMEOUT_MAX_MS);
      setCustomizationValue("workspaceGit.timeoutsCommitMs", GIT_COMMIT_TIMEOUT_MAX_MS);
      assert.equal(atPath(store.doc, "workspaceGit.timeouts.commitMs"), GIT_COMMIT_TIMEOUT_MAX_MS, "the schema's largest value is a value the setting writes");
      assert.throws(() => setCustomizationValue("workspaceGit.timeoutsCommitMs", GIT_COMMIT_TIMEOUT_MAX_MS + 1));
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: intelligence knobs bind into codeIntelligence and read the document", () => {
  assert.equal(isConfigPathDeclared("codeIntelligence.farm.perFileTimeoutMs"), true);
  assert.equal(isConfigPathDeclared("codeIntelligence.retrieval.phraseBoost"), true);
  assert.equal(isConfigPathDeclared("codeIntelligence.autoHeal.staleSampleFloor"), true);
  const store = memoryStore({
    codeIntelligence: {
      searchDefaultLimit: 17,
      farm: { perFileTimeoutMs: 900 },
      retrieval: { phraseBoost: 0.4, finalK: 9 },
    },
  });
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const intel = listCustomizations().filter((c) => c.module === "intelligence");
      assert.ok(intel.length > 0, "intelligence registers customizations");
      for (const c of intel) {
        assert.ok(c.configPath !== undefined, `${c.id} must be config-bound`);
        assert.ok(
          c.configPath.startsWith("codeIntelligence."),
          `${c.id} must bind into codeIntelligence, got ${c.configPath}`,
        );
      }
      assert.equal(getCustomization("intelligence.searchDefaultLimit")?.current(), 17);
      assert.equal(getCustomization("intelligence.farmPerFileTimeoutMs")?.current(), 900);
      assert.equal(getCustomization("intelligence.phraseBoost")?.current(), 0.4);
      assert.equal(getCustomization("intelligence.finalK")?.current(), 9);
      assert.equal(getCustomization("intelligence.autoHealEnabled")?.current(), true);
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: graph knobs bind into webUi and read the document", () => {
  assert.equal(isConfigPathDeclared("webUi.graph.maxNodes"), true);
  assert.equal(isConfigPathDeclared("webUi.graph.labelGapPx"), true);
  assert.equal(isConfigPathDeclared("webUi.selfImproving.slowLlmMsThreshold"), true);
  const store = memoryStore({
    webUi: {
      graph: { maxNodes: 42, labelGapPx: 7 },
      metrics: { pollMs: 1234 },
      selfImproving: { slowLlmMsThreshold: 1111 },
    },
  });
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const graph = listCustomizations().filter((c) => c.module === "graph");
      assert.ok(graph.length > 0, "graph registers customizations");
      for (const c of graph) {
        assert.ok(c.configPath !== undefined, `${c.id} must be config-bound`);
        assert.ok(
          c.configPath.startsWith("webUi."),
          `${c.id} must bind into webUi, got ${c.configPath}`,
        );
      }
      assert.equal(getCustomization("graph.maxNodes")?.current(), 42);
      assert.equal(getCustomization("graph.labelGapPx")?.current(), 7);
      assert.equal(getCustomization("graph.metricsPollMs")?.current(), 1234);
      assert.equal(getCustomization("graph.slowLlmMsThreshold")?.current(), 1111);
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: artifacts knobs bind into artifacts and read the document", () => {
  assert.equal(isConfigPathDeclared("artifacts.maxBytes"), true);
  assert.equal(isConfigPathDeclared("artifacts.idLength"), true);
  const store = memoryStore({ artifacts: { maxBytes: 4096, idLength: 12 } });
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const artifacts = listCustomizations().filter((c) => c.module === "artifacts");
      assert.ok(artifacts.length > 0, "artifacts registers customizations");
      for (const c of artifacts) {
        assert.ok(c.configPath !== undefined, `${c.id} must be config-bound`);
        assert.ok(
          c.configPath.startsWith("artifacts."),
          `${c.id} must bind into artifacts, got ${c.configPath}`,
        );
      }
      assert.equal(getCustomization("artifacts.maxBytes")?.current(), 4096);
      assert.equal(getCustomization("artifacts.idLength")?.current(), 12);
      assert.equal(getCustomization("artifacts.iframeSandbox")?.current(), "allow-scripts");
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

const SCHEMA_DEFAULT_PATH = "memory.dedupCompression.enabled";
const SCHEMA_DEFAULT_SIBLING = "memory.dedupCompression.llmInputDedup";

test("config binding: a write of the schema default omits the key from the document", () => {
  // memory.dedupCompression.enabled is z.boolean().default(false). A write
  // of false must drop the key (overrides-only document). A write of true
  // must assign. Type-zero false is the declared default HERE because the
  // schema says so — not because false is a type-zero.
  const store = freshStore({
    memory: { dedupCompression: { enabled: true, llmInputDedup: true } },
  });
  writeConfigCustomization(SCHEMA_DEFAULT_PATH, true);
  assert.equal(hasOwnPath(store.doc, SCHEMA_DEFAULT_PATH), true, "a non-default must be present");
  assert.equal(atPath(store.doc, SCHEMA_DEFAULT_PATH), true, "the document holds the non-default");

  writeConfigCustomization(SCHEMA_DEFAULT_PATH, false);
  assert.equal(
    hasOwnPath(store.doc, SCHEMA_DEFAULT_PATH),
    false,
    "write of the declared default must omit the key from the document",
  );
  assert.equal(
    atPath(store.doc, SCHEMA_DEFAULT_SIBLING),
    true,
    "omitting one key must leave sibling keys in the same object",
  );

  writeConfigCustomization(SCHEMA_DEFAULT_PATH, true);
  assert.equal(atPath(store.doc, SCHEMA_DEFAULT_PATH), true, "a later non-default write must restore the key");

  writeConfigCustomization(SCHEMA_DEFAULT_PATH, false);
  assert.equal(hasOwnPath(store.doc, SCHEMA_DEFAULT_PATH), false, "writing the default after a non-default must omit again");
  resetCustomizationConfigStore();
});

test("config binding: omitting the only key in a parent prunes the empty object", () => {
  const store = freshStore({ memory: { dedupCompression: { enabled: true } } });
  writeConfigCustomization(SCHEMA_DEFAULT_PATH, false);
  assert.equal(
    hasOwnPath(store.doc, SCHEMA_DEFAULT_PATH),
    false,
    "write of the declared default must omit the key from the document",
  );
  assert.equal(
    hasOwnPath(store.doc, "memory.dedupCompression"),
    false,
    "an object left empty by omit must be pruned",
  );
  resetCustomizationConfigStore();
});

test("config binding: a boolean with no declared default is assigned, not omitted as a type-zero", () => {
  // runtime.userPreferences.emoji is optional with no schema .default() and
  // no customization. Writing false must persist — Jackson NON_DEFAULT as a
  // global default would drop type-zeros; that is the failure mode.
  assert.equal(isConfigPathDeclared("runtime.userPreferences.emoji"), true);
  const store = freshStore({});
  writeConfigCustomization("runtime.userPreferences.emoji", false);
  assert.equal(
    hasOwnPath(store.doc, "runtime.userPreferences.emoji"),
    true,
    "false without a declared default must stay in the document (not treated as a type-zero default)",
  );
  assert.equal(atPath(store.doc, "runtime.userPreferences.emoji"), false);
  resetCustomizationConfigStore();
});

test("config binding: a required key with a planted default still assigns on a valid document", () => {
  // memory.trimThreshold is required (no schema default). Planting a
  // registration default must NOT drop it from a valid document: omit
  // would fail getConfigDocumentSchema(), so the door assigns.
  rememberConfigPathDefault("memory.trimThreshold", 0.8);
  const store = freshStore(liveConfigClone());
  writeConfigCustomization("memory.trimThreshold", 0.8);
  assert.equal(
    hasOwnPath(store.doc, "memory.trimThreshold"),
    true,
    "omitting a required key from a valid document must assign instead",
  );
  assert.equal(atPath(store.doc, "memory.trimThreshold"), 0.8);
  resetCustomizationConfigStore();
});

test("config binding: write of default omits a previously-present optional key on a valid document", () => {
  // The omitOk arm (schema-valid omit) is the live path. Partial fixtures
  // take the neither-arm ("prefer omit") and stay green if omitOk is
  // discarded. A live clone is schema-valid, so omit of an optional key
  // can only happen through omitOk — assignOk would keep the key.
  const store = memoryStore(liveConfigClone());
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();

      const search = getCustomization("search.threshold");
      assert.ok(search !== undefined && search.configPath !== undefined);
      writeConfigCustomization(search.configPath, 0.91);
      assert.equal(
        hasOwnPath(store.doc, search.configPath),
        true,
        "a non-default must be present on the valid document",
      );
      assert.equal(atPath(store.doc, search.configPath), 0.91);

      writeConfigCustomization(search.configPath, search.default);
      assert.equal(
        hasOwnPath(store.doc, search.configPath),
        false,
        "write of the declared default must omit the key from a valid document",
      );

      const farm = getCustomization("intelligence.farmPerFileTimeoutMs");
      assert.ok(farm !== undefined && farm.configPath !== undefined);
      writeConfigCustomization(farm.configPath, 16000);
      assert.equal(atPath(store.doc, farm.configPath), 16000, "non-default farm timeout is assigned");
      resetCustomizationValue("intelligence.farmPerFileTimeoutMs");
      assert.equal(
        hasOwnPath(store.doc, farm.configPath),
        false,
        "reset to default must omit a previously-present key from a valid document",
      );

      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: a customization default is omitted even when the schema has no .default()", () => {
  // The live farm knob: optional, no schema default, registration default
  // 15000. Return-to-default used to materialize the key. After
  // registration, a write of the declared default must omit.
  const store = memoryStore({
    codeIntelligence: { farm: { perFileTimeoutMs: 900, initTimeoutMs: 500 } },
    search: { threshold: 0.91, maxResults: 10 },
    memory: { promoteOnTurnBoundary: false },
  });
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();

      const farm = getCustomization("intelligence.farmPerFileTimeoutMs");
      assert.ok(farm !== undefined && farm.configPath !== undefined);
      writeConfigCustomization(farm.configPath, farm.default);
      assert.equal(
        hasOwnPath(store.doc, farm.configPath),
        false,
        "write of the declared default must omit the key from the document",
      );
      assert.equal(
        atPath(store.doc, "codeIntelligence.farm.initTimeoutMs"),
        500,
        "omitting one farm key must leave sibling keys",
      );

      const search = getCustomization("search.threshold");
      assert.ok(search !== undefined && search.configPath !== undefined);
      setCustomizationValue("search.threshold", 0.91);
      assert.equal(atPath(store.doc, "search.threshold"), 0.91);
      resetCustomizationValue("search.threshold");
      assert.equal(
        hasOwnPath(store.doc, "search.threshold"),
        false,
        "reset to default must omit the key from the document",
      );
      assert.equal(atPath(store.doc, "search.maxResults"), 10, "reset must leave sibling search keys");
      assert.equal(search.current(), search.default, "live projection still sees the default when the key is omitted");

      const promote = getCustomization("memory.promoteOnTurnBoundary");
      assert.ok(promote !== undefined && promote.configPath !== undefined);
      assert.equal(promote.default, true, "discriminator: declared default is true, not the type-zero");
      writeConfigCustomization(promote.configPath, false);
      assert.equal(hasOwnPath(store.doc, promote.configPath), true, "non-default false must stay");
      writeConfigCustomization(promote.configPath, true);
      assert.equal(
        hasOwnPath(store.doc, promote.configPath),
        false,
        "write of declared default true must omit (type-zero would have omitted false instead)",
      );

      let projection = 0.91;
      const set = configBoundSet("search.threshold", (v) => {
        projection = Number(v);
      });
      set(0.5);
      assert.equal(hasOwnPath(store.doc, "search.threshold"), false, "configBoundSet of default must omit");
      assert.equal(projection, 0.5, "configBoundSet still applies the default to the live projection");

      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

test("config binding: a write of the value the path already carries is a no-op", () => {
  // The byte-identity rule for same-value writes. The reorder defect: a
  // default restatement the document carried explicitly was pruned by the
  // very write that restated it (the omit-on-default door treated the no-op
  // as a change), and the later re-add of the line landed at its section's
  // end — a value-identical write that reordered the document. A write that
  // changes no value must reach no store at all, for a default restatement
  // AND a plain non-default; the omit-on-default normalization keeps firing
  // on genuine value changes (the arms above and the discrimination below).
  const store = freshStore({ memory: { dedupCompression: { enabled: false, llmInputDedup: true } } });
  const writesBefore = store.writes.length;

  // The explicitly-carried default restatement: writing the same default
  // must not prune the line.
  writeConfigCustomization(SCHEMA_DEFAULT_PATH, false);
  assert.equal(store.writes.length, writesBefore, "a same-value write must reach no store");
  assert.equal(
    hasOwnPath(store.doc, SCHEMA_DEFAULT_PATH),
    true,
    "the explicitly-carried default restatement must stay in the document",
  );

  // A non-default value the path already carries: the same rule.
  writeConfigCustomization(SCHEMA_DEFAULT_SIBLING, true);
  assert.equal(store.writes.length, writesBefore, "a same-value non-default write must reach no store");
  assert.equal(atPath(store.doc, SCHEMA_DEFAULT_SIBLING), true);

  // A record-valued leaf: a candidate whose VALUE is identical but whose
  // key order differs must not re-serialize the document's own order.
  const expectationsPath = "safety.eventFeed.stepSkipExpectations";
  writeConfigCustomization(expectationsPath, { edit: ["oldString"], apply: ["newString"] });
  assert.equal(store.writes.length, writesBefore + 1, "the first record write lands");
  writeConfigCustomization(expectationsPath, { apply: ["newString"], edit: ["oldString"] });
  assert.equal(
    store.writes.length,
    writesBefore + 1,
    "a same-value record write in a different key order must reach no store",
  );
  assert.deepEqual(
    Object.keys(atPath(store.doc, expectationsPath) as Record<string, unknown>),
    ["edit", "apply"],
    "the document's own key order must survive the reordered candidate",
  );

  // The door is not inert: a genuine change still writes, and the change
  // back to the declared default still omits.
  writeConfigCustomization(SCHEMA_DEFAULT_PATH, true);
  assert.equal(store.writes.length, writesBefore + 2, "a genuine value change must write");
  assert.equal(atPath(store.doc, SCHEMA_DEFAULT_PATH), true);
  writeConfigCustomization(SCHEMA_DEFAULT_PATH, false);
  assert.equal(store.writes.length, writesBefore + 3, "the genuine change back to the default must write");
  assert.equal(
    hasOwnPath(store.doc, SCHEMA_DEFAULT_PATH),
    false,
    "the omit-on-default normalization still fires on a genuine change",
  );
  resetCustomizationConfigStore();
});

test("config binding: every config-bound customization's default is omitted from an empty document", () => {
  const store = memoryStore({});
  installCustomizationConfigStore(store);
  return import("../../src/shared/exposure/registrations/index.ts").then(
    ({ registerAllExposure, resetAllRegistrations }) => {
      resetAllRegistrations();
      registerAllExposure();
      const bound = listCustomizations().filter((c) => c.configPath !== undefined);
      assert.ok(bound.length > 0, "the bound population is real");
      const kept: string[] = [];
      for (const customization of bound) {
        writeConfigCustomization(customization.configPath!, customization.default);
        if (hasOwnPath(store.doc, customization.configPath!)) {
          kept.push(`${customization.id} -> ${customization.configPath} = ${String(customization.default)}`);
        }
      }
      assert.deepEqual(
        kept,
        [],
        `write of the declared default must omit the key from the document:\n${kept.join("\n")}`,
      );
      resetAllRegistrations();
      resetCustomizationConfigStore();
    },
  );
});

/** A store whose every read refuses with `failure`, counting the reads. */
function refusingStore(failure: Error): CustomizationConfigStore & { readonly reads: number } {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    configFilePath: join(mkTempDir("config-binding-refusing-store-"), "bridlewise.config.json"),
    readDocument: () => {
      reads += 1;
      throw failure;
    },
    writeDocument: () => {
      throw new Error("a refusing store is never written");
    },
  };
}

test("config binding: a snapshot answers every read from ONE reading of the document", () => {
  let reads = 0;
  const store = memoryStore({ memory: { trimThreshold: 0.62 } });
  installCustomizationConfigStore({
    configFilePath: store.configFilePath,
    readDocument: () => {
      reads += 1;
      return store.readDocument();
    },
    writeDocument: store.writeDocument,
  });
  const seen = withConfigDocumentSnapshot(() => [
    readConfigCustomization("memory.trimThreshold"),
    seedFromConfig("memory.trimThreshold", 0.85),
    withConfigDocumentSnapshot(() => readConfigCustomization("memory.trimThreshold")),
  ]);
  assert.deepEqual(seen, [0.62, 0.62, 0.62]);
  assert.equal(reads, 1, "three reads (one in a nested scope) cost one document read");
  readConfigCustomization("memory.trimThreshold");
  assert.equal(reads, 2, "outside the scope every read is fresh again");
  resetCustomizationConfigStore();
});

test("config binding: a FAILED reading is each read's failure inside the snapshot, never the snapshot's own", () => {
  // The defect (GitHub CI shard 9, 64fd622d): the scope read the document at
  // entry and let the store's refusal escape, so a settings file gone bad at
  // runtime turned the whole values answer into a 503 instead of serving each
  // setting's refusal beside the values that need no document.
  const failure = new InputError("config_unreadable: the settings file is not valid JSON", "config_json_invalid");
  const store = refusingStore(failure);
  installCustomizationConfigStore(store);
  const outcomes = withConfigDocumentSnapshot(() => {
    const perRead = ["memory.trimThreshold", "memory.windowSize"].map((path) => {
      try {
        return readConfigCustomization(path);
      } catch (error) {
        return error;
      }
    });
    let seeded: unknown;
    try {
      seeded = seedFromConfig("memory.trimThreshold", 0.85);
    } catch (error) {
      seeded = error;
    }
    return { perRead, seeded, documentFree: "a value that needs no document" };
  });
  assert.equal(outcomes.documentFree, "a value that needs no document", "the scope itself answers");
  assert.deepEqual(outcomes.perRead, [failure, failure], "each read refuses with the reading's own failure");
  assert.equal(outcomes.seeded, failure, "a seeded read refuses with it too, never a silent default");
  assert.equal(store.reads, 1, "the refusing store is still read once per snapshot");
  resetCustomizationConfigStore();
});

test("config binding: with no store installed a snapshot opens nothing and each read stands alone", () => {
  resetCustomizationConfigStore();
  const outcome = withConfigDocumentSnapshot(() => {
    let read: unknown;
    try {
      read = readConfigCustomization("memory.trimThreshold");
    } catch (error) {
      read = error;
    }
    return { read, seeded: seedFromConfig("memory.trimThreshold", 0.85) };
  });
  assert.ok(outcome.read instanceof InputError && outcome.read.code === "customization_config_store_missing", "a read refuses on its own");
  assert.equal(outcome.seeded, 0.85, "a seed answers its declared default on its own");
});

test("config binding: a write inside a snapshot is refused, loud, and the document is untouched", () => {
  const store = freshStore({ memory: { trimThreshold: 0.62 } });
  assert.throws(
    () => withConfigDocumentSnapshot(() => writeConfigCustomization("memory.trimThreshold", 0.7)),
    (error: unknown) => error instanceof InputError && error.code === "customization_write_inside_snapshot",
  );
  assert.equal(store.writes.length, 0, "nothing reached the store");
  writeConfigCustomization("memory.trimThreshold", 0.7);
  assert.equal(memTrimThreshold(store.doc), 0.7, "after the scope a write lands as before");
  resetCustomizationConfigStore();
});
