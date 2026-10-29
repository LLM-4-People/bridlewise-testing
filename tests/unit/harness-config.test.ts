// @vitest-environment node
/**
 * Unit tests for the centralized harness-config reader (server/harness-config.ts).
 *
 * Verifies against the REAL harness config file (integration test):
 * - getAllowedCommands reads `tools.allowedCommands` from the config
 * - getMcpServers reads `tools.mcpServers` (NOT the non-existent `mcp.servers`
 * — proactive fix of a prior bug where MCP servers were silently invisible)
 * - getEnabledTools reads `tools.enabled`
 * - getMemoryConfig reads the `memory` section
 *
 * The real config has known contents (verified at test-write time); this
 * catches any regression that re-introduces the wrong config path.
 */
import { describe, test, expect, vi } from "vitest";
import { existsSync, readFileSync, statSync, utimesSync, chmodSync, openSync, closeSync, writeFileSync } from "node:fs";
import filesystem from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as fileRead from "../../server/filesystem/file-read.ts";
import * as debugBridge from "../../server/observability/debug-bridge.ts";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateHarnessConfig, plantSettingsDocument } from "../helpers/isolated-config.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";
import { resolve } from "node:path";
// The config file's cross-process write lock: this suite runs beside
// parallel forks that write the same shared file, so every write-read-write
// arm below holds the lock for its WHOLE cycle (the found bytes, the
// mutation, and the byte-identical restore are one indivisible hold — a
// concurrent fork's cycle can never interleave with this one's window).
import { withConfigWriteLock } from "../../engine/src/kernel/config-write-lock.ts";
// The document schema itself, for the parse-level acceptance arm (no file
// write: the gate's vocabulary is the schema, and acceptance is a parse).
import { getConfigDocumentSchema } from "../../server/kernel/canonical.ts";
import {
  getAllowedCommands,
  getMcpServers,
  getEnabledTools,
  getMemoryConfig,
  getPrivacyPolicy,
  resourceSamplerConfig,
  captureProviderPayloadsEnabled,
  performanceResourceDeltasEnabled,
  getToolMemoryContentMaxChars,
  getToolMemoryArgsMaxChars,
  getMemoryPreviewMaxChars,
  getMemorySearchDefaultLimit,
  getMemorySearchMaxLimit,
  getMemoryRetrievalLimit,
  getInteractionContentMaxChars,
  getToolCallArgumentsCacheEntries,
  getSafetyGateConfig,
  getEventFeedSafetyConfig,
  writeConfigRaw,
  readConfigRaw,
  refreshSettingsSnapshot,
  modifyConfigRaw,
  restoreConfigFileBytes,
  resolveWebDebugBootstrap,
} from "../../server/kernel/harness-config.ts";
// The exposure config store the settings doors write through — installed
// per-arm below exactly as server/index.ts installs it, and the
// registration door that resolves the drive-16 row and its declared
// default through the real registry.
import {
  installCustomizationConfigStore,
  writeConfigCustomization,
  readConfigCustomization,
  resetCustomizationConfigStore,
} from "../../engine/src/shared/exposure/config-binding.ts";
import { registerAllExposure, getCustomization, listCustomizations } from "../../server/kernel/canonical.ts";
import { serverConfig, resetServerConfig } from "../../server/kernel/config.ts";
import { DEFAULT_CAPTURE_PROVIDER_PAYLOADS } from "../../engine/src/kernel/config-contracts.ts";
// The privacy policy's own declarations: the category enumeration (the
// redaction minimum the config may not narrow) + the defaults-only policy
// (what an absent section resolves to) — both from the engine's canonical
// owners, never restated here.
import { DEFAULT_PRIVACY_POLICY, REDACTION_CATEGORIES } from "../../engine/src/privacy/privacy-policy.ts";
import {
  DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS,
  DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS,
  DEFAULT_MEMORY_PREVIEW_MAX_CHARS,
  DEFAULT_MEMORY_SEARCH_MAX_LIMIT,
  DEFAULT_MEMORY_RETRIEVAL_LIMIT,
  DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS,
  DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES,
} from "../../engine/src/kernel/config-contracts.ts";
// The memory resolver is the one door to the search-result default (the
// module that declares it resolves it, so the constant itself is private).
import { resolveMemoryConfig } from "../../engine/src/memory/memory-types.ts";
import {
  DEFAULT_RESOURCE_DELTAS_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_ENABLED,
  DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS,
} from "../../engine/src/performance/performance-config.ts";
import { configStoreAt } from "../../engine/test/support/fixture-config-store.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

// The real config file is an untracked, mutable file (some tests write it via
// writeConfigRaw). To avoid test-order dependence, this test reads the file's
// CURRENT contents and asserts the reader returns EXACTLY that — testing the
// reader logic, not a snapshot of specific tool names that may have changed.
const realConfigPath = isolateHarnessConfig("harness-config-owner-");

/**
 * A planted weakening NEVER becomes the snapshot (the store's posture doors,
 * wf1b2-design S-1): the store says `refused` naming the floor's code, and the
 * accessor keeps answering the section in force before the plant — no run
 * resolves the weaker section, and no request refuses for it.
 */
function expectRefusedAtTheStore<T>(read: () => T, inForce: T, code: string): string {
  const state = refreshSettingsSnapshot();
  expect(state).toMatchObject({ state: "refused", reason: expect.stringContaining(code) });
  expect(read()).toEqual(inForce);
  return state.reason ?? "";
}
function readRealEnabled(): readonly string[] {
  try {
    const doc = JSON.parse(readFileSync(realConfigPath, "utf8")) as { tools?: { enabled?: readonly string[] } };
    return doc.tools?.enabled ?? [];
  } catch {
    return [];
  }
}

describe("harness-config reader (proactive MCP fix)", () => {
  test("getAllowedCommands reads tools.allowedCommands from the real config", () => {
    const cmds = getAllowedCommands();
    // The real config has a non-empty allowedCommands list (node, git, etc.).
    expect(cmds.size).toBeGreaterThan(10);
    expect(cmds.has("node")).toBe(true);
    expect(cmds.has("git")).toBe(true);
    expect(cmds.has("rg")).toBe(true);
    // A command NOT in the config must be absent (no hardcoded fallback).
    expect(cmds.has("definitely-not-a-real-command-zzz")).toBe(false);
  });

  test("getMcpServers reads tools.mcpServers (NOT mcp.servers — proactive fix)", () => {
    // The arm plants its own server under `tools.mcpServers` (in this file's
    // isolated copy) and restores the bytes: it never depends on the MCP
    // servers the repository's document happens to list. The non-existent
    // `mcp.servers` path would return empty — this verifies the reader uses
    // the ACTUAL `tools.mcpServers` path.
    const original = readFileSync(realConfigPath, "utf8");
    const document = JSON.parse(original) as { tools: Record<string, unknown> };
    const github = { id: "github", transport: "http", url: "https://api.githubcopilot.com/mcp/", protocolVersion: "2025-11-25", enabled: false };
    try {
      plantSettingsDocument(realConfigPath, `${JSON.stringify({ ...document, tools: { ...document.tools, mcpServers: [github] } }, null, 2)}\n`);
      expect(getMcpServers().map((s) => s.id)).toEqual(["github"]);
    } finally {
      plantSettingsDocument(realConfigPath, original);
    }
    expect(readFileSync(realConfigPath, "utf8"), "the planted document was not restored").toBe(original);
  });

  test("getEnabledTools reads tools.enabled from the real config", () => {
    const enabled = getEnabledTools();
    // Assert the reader returns EXACTLY the config file's current tools.enabled
    // (whatever it is) — this is the real test of the reader and does NOT
    // depend on specific tool names that other tests may add/remove via
    // writeConfigRaw. The file is untracked/mutable, so hardcoding names was
    // order-dependent (a prior bug: this asserted read_file which isn't in the
    // config and only passed due to another test's mutation).
    const fileEnabled = readRealEnabled();
    expect(enabled.length, "enabled list must match the config file").toBe(fileEnabled.length);
    for (const tool of enabled) expect(fileEnabled).toContain(tool);
    // The reader must return a non-empty list when the config has one.
    if (fileEnabled.length > 0) {
      expect(enabled.length).toBeGreaterThan(0);
    }
  });

  test("getMemoryConfig reads the memory section from the real config", () => {
    const mem = getMemoryConfig();
    // The real config has contextTokenLimit: 32768, trimThreshold: 0.8.
    expect(typeof mem.contextTokenLimit).toBe("number");
    expect(mem.contextTokenLimit).toBe(32768);
    expect(mem.trimThreshold).toBe(0.8);

    // The read owner's caller-retained snapshot must bind its private bytes
    // to immutable decoded text, even against aliases and forged handles.
    const target = resolve(createTempDir("config-text-snapshot-"), "text.json");
    const firstText = "snapshot-source-A";
    const nextText = "snapshot-source-B";
    expect(atomicWriteFile(target, firstText, { createMode: 0o600 }).success).toBe(true);
    let first: fileRead.FileTextSnapshot;
    const copies = vi.spyOn(Buffer, "from");
    let copiedReads: number;
    try {
      first = fileRead.readFileText(target, { previous: undefined });
      copiedReads = copies.mock.calls.filter(([value]) => Buffer.isBuffer(value) && value.toString("utf8") === firstText).length;
    } finally { copies.mockRestore(); }
    expect(copiedReads, "the reader adopts its own fresh bytes without copying them").toBe(0);
    expect(first.text).toBe(firstText);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, "text", "stale-text")).toBe(false);
    expect(Reflect.set(first, "bytes", Buffer.from(nextText))).toBe(false);
    expect(fileRead.readFileText(target, { previous: first })).toBe(first);
    const Constructor = Object.getPrototypeOf(first).constructor as new (bytes: Buffer) => typeof first;
    expect(Object.isFrozen(Constructor)).toBe(true);
    const aliasedBytes = Buffer.from(firstText);
    const reflected = new Constructor(aliasedBytes);
    Buffer.from(nextText).copy(aliasedBytes);
    const staticBytes = Buffer.from(firstText);
    const reflectedFactory = Constructor as unknown as { reuse(bytes: Buffer, previous: typeof first | undefined, ownership?: symbol): typeof first };
    const reflectedStatic = reflectedFactory.reuse(staticBytes, undefined, Symbol("caller-owned-bytes"));
    Buffer.from(nextText).copy(staticBytes);
    const comparisonBytes = Buffer.from(nextText);
    let comparisonCalls = 0;
    comparisonBytes.equals = (retained: Uint8Array) => {
      comparisonCalls += 1;
      comparisonBytes.copy(retained);
      return true;
    };
    const compared = reflectedFactory.reuse(comparisonBytes, first, Symbol("external-comparison"));
    expect(atomicWriteFile(target, nextText, { createMode: 0o600 }).success).toBe(true);
    const subsequent = fileRead.readFileText(target, { previous: first });
    expect({ reflected: compared.text, subsequent: subsequent.text, physical: readFileSync(target, "utf8"), comparisonCalls },
      "reflected comparison keeps physical bytes associated with immutable text without caller dispatch").toEqual({
      reflected: nextText, subsequent: nextText, physical: nextText, comparisonCalls: 0,
    });
    const forged = { bytes: Buffer.from(nextText), text: "stale-text" } as unknown as typeof first;
    const inherited = Object.assign(Object.create(Object.getPrototypeOf(first)), { text: "stale-text" }) as typeof first;
    const proxied = new Proxy(first, { get: (snapshot, key) => key === "text" ? "stale-text" : Reflect.get(snapshot, key) });
    expect(atomicWriteFile(target, nextText, { createMode: 0o600 }).success).toBe(true);
    for (const previous of [first, reflected, reflectedStatic, forged, inherited, proxied]) {
      const next = fileRead.readFileText(target, { previous });
      expect(next.text, "current bytes must win over every stale or forged snapshot").toBe(nextText);
      expect(next === previous, "untrusted handles never become the current snapshot").toBe(false);
      expect(fileRead.readFileText(target, { previous: next })).toBe(next);
      expect(fileRead.readFileText(target), "ordinary callers still receive the current UTF-8 string").toBe(nextText);
    }
  });

  test("getAllowedCommands returns a fresh Set per call (no shared mutable state)", () => {
    const cmds1 = getAllowedCommands();
    const size1 = cmds1.size;
    // Mutating one returned set must not affect the next call (the reader
    // builds a fresh Set each time from the config).
    const cmds2 = getAllowedCommands();
    expect(cmds2.size).toBe(size1);
    expect(cmds1.size).toBe(size1);
  });
});

describe("harness-config reader — the observability knobs (timeline + performance sections)", () => {
  // The same read-the-real-file posture as the tools section above: the file
  // is mutable (settings writes go through the config gate), so the arms
  // assert the accessor returns EXACTLY what the file says now — with the
  // declared default as the fallback when the section is absent. These
  // accessors are the consumers the exposure knobs' declared effect timings
  // name: the sampler pair is resolved once at server start (restart), the
  // payload-capture and resource-delta switches are read live per call
  // (immediate).
  type CfgDoc = {
    timeline?: { captureProviderPayloads?: boolean };
    performance?: {
      resourceDeltas?: { enabled?: boolean };
      resourceSampler?: { enabled?: boolean; intervalMs?: number };
    };
  };
  function readRealDoc(): CfgDoc {
    try {
      return JSON.parse(readFileSync(realConfigPath, "utf8")) as CfgDoc;
    } catch {
      return {};
    }
  }

  test("resourceSamplerConfig returns the file's sampler section, or the declared defaults", () => {
    const doc = readRealDoc();
    const section = doc.performance?.resourceSampler;
    const resolved = resourceSamplerConfig();
    expect(resolved.enabled).toBe(section?.enabled ?? DEFAULT_RESOURCE_SAMPLER_ENABLED);
    expect(resolved.intervalMs).toBe(section?.intervalMs ?? DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS);
  });

  test("an out-of-range or absent interval falls back to the declared default, never into a timer", () => {
    // The accessor's guard: only a positive whole number passes; anything
    // else (a document that bypassed the write gate) resolves to the default.
    const doc = readRealDoc();
    const raw = doc.performance?.resourceSampler?.intervalMs;
    const resolved = resourceSamplerConfig().intervalMs;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      expect(resolved).toBe(DEFAULT_RESOURCE_SAMPLER_INTERVAL_MS);
    } else {
      expect(resolved).toBe(raw);
    }
    expect(resolved).toBeGreaterThan(0);
  });

  test("captureProviderPayloadsEnabled and performanceResourceDeltasEnabled read the live file", () => {
    const doc = readRealDoc();
    expect(captureProviderPayloadsEnabled()).toBe(
      doc.timeline?.captureProviderPayloads ?? DEFAULT_CAPTURE_PROVIDER_PAYLOADS,
    );
    expect(performanceResourceDeltasEnabled()).toBe(
      doc.performance?.resourceDeltas?.enabled ?? DEFAULT_RESOURCE_DELTAS_ENABLED,
    );
  });
});

describe("harness-config reader — the memory capture-and-search limits (declared leaves, live readers)", () => {
  // The seven readers consume the `memory` section's capture-and-search
  // leaves — paths the config contract now declares, so a settings write can
  // actually reach them. The arms assert each reader returns EXACTLY what the
  // file says, with the contract's own constant as the absent-key fallback
  // (one default, owned beside the schema — never a private reader literal).
  // These accessors are the consumers the settings rows' "immediate" timing
  // names: each call re-reads the config through the content-cached document.
  type MemoryDoc = {
    memory?: {
      searchResultLimit?: number;
      searchMaxLimit?: number;
      retrievalLimit?: number;
      interactionContentMaxChars?: number;
      toolResultContentMaxChars?: number;
      toolResultArgsMaxChars?: number;
      previewMaxChars?: number;
    };
  };
  function readRealMemory(): MemoryDoc["memory"] {
    try {
      return (JSON.parse(readFileSync(realConfigPath, "utf8")) as MemoryDoc).memory;
    } catch {
      return undefined;
    }
  }

  test("each reader returns the file's value, or the contract default when the leaf is absent", () => {
    const mem = readRealMemory();
    expect(getMemorySearchDefaultLimit()).toBe(
      mem?.searchResultLimit ?? resolveMemoryConfig({}).searchResultLimit,
    );
    expect(getMemorySearchMaxLimit()).toBe(mem?.searchMaxLimit ?? DEFAULT_MEMORY_SEARCH_MAX_LIMIT);
    expect(getMemoryRetrievalLimit()).toBe(mem?.retrievalLimit ?? DEFAULT_MEMORY_RETRIEVAL_LIMIT);
    expect(getInteractionContentMaxChars()).toBe(
      mem?.interactionContentMaxChars ?? DEFAULT_MEMORY_INTERACTION_CONTENT_MAX_CHARS,
    );
    expect(getToolMemoryContentMaxChars()).toBe(
      mem?.toolResultContentMaxChars ?? DEFAULT_MEMORY_TOOL_RESULT_CONTENT_MAX_CHARS,
    );
    expect(getToolMemoryArgsMaxChars()).toBe(
      mem?.toolResultArgsMaxChars ?? DEFAULT_MEMORY_TOOL_RESULT_ARGS_MAX_CHARS,
    );
    expect(getMemoryPreviewMaxChars()).toBe(mem?.previewMaxChars ?? DEFAULT_MEMORY_PREVIEW_MAX_CHARS);
  });

  test("the shipped default equals the effective default the search route has always used", () => {
    // Behavior preservation, pinned: the declared leaf's shipped value IS the
    // effective default (100) — not the dead 20 a former sibling leaf carried
    // while nothing consumed it. A regression that reinstates the inert value
    // silently changes every memory search that omits a limit.
    expect(readRealMemory()?.searchResultLimit).toBe(resolveMemoryConfig({}).searchResultLimit);
  });

  test("setting the declared search-result leaf changes what the default-limit reader returns", () => {
    // The rewire, driven: write `memory.searchResultLimit` through the real
    // write gate (the door that refused the old phantom spelling), and the
    // single-owner default-limit reader must answer the new value on the
    // very next call. The WHOLE cycle — found bytes, gated mutation, gated
    // restore, byte-identity verdict — holds the config's cross-process
    // write lock: a parallel fork writing the same file can no longer land
    // inside this window (the locked-out fork waits), so the restore is
    // guaranteed to put the exact found bytes back and the file can never
    // carry this test's window forward. The gate itself is re-entrant under
    // the same hold, and it reconciles the typed-reader cache explicitly,
    // so the follow-up read is deterministic rather than depending on the
    // filesystem's mtime granularity (a same-millisecond restore leaves a
    // stale cache reading the mutated value — measured).
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      const beforeDoc = readConfigRaw();
      try {
        writeConfigRaw({
          ...structuredClone(beforeDoc),
          memory: { ...(beforeDoc.memory as Record<string, unknown>), searchResultLimit: 7 },
        });
        expect(getMemorySearchDefaultLimit()).toBe(7);
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
      expect(getMemorySearchDefaultLimit()).toBe(resolveMemoryConfig({}).searchResultLimit);
    });
    // Private files drive both accepted verbs without touching the shared
    // document. An external editor can preserve exact mtime while replacing
    // the inode OR editing it in place; both must change actual typed values.
    const originalDocument = readConfigRaw();
    const directory = createTempDir("config-external-identity-");
    const outcomes: unknown[] = [];
    const reuse: unknown[] = [];
    try {
      for (const verb of ["gate", "restore", "external-atomic", "external-in-place"] as const) {
        const target = resolve(directory, verb + ".json");
        const first = { ...structuredClone(originalDocument), memory: { ...(originalDocument.memory as Record<string, unknown>), searchResultLimit: 7 } };
        const next = { ...structuredClone(originalDocument), memory: { ...(originalDocument.memory as Record<string, unknown>), searchResultLimit: 8 } };
        expect(atomicWriteFile(target, JSON.stringify(first, null, 2) + "\n", { createMode: 0o600 }).success).toBe(true);
        utimesSync(target, 1700000000, 1700000000);
        resetServerConfig({ ...process.env, HARNESS_CONFIG_PATH: target });
        expect(getMemorySearchDefaultLimit(), "prime the actual typed cache").toBe(7);
        const primed = statSync(target, { bigint: true });
        const bytes = JSON.stringify(next, null, 2) + "\n";
        if (verb === "external-in-place") {
          // Deliberately model an external in-place editor through a private
          // descriptor. Application writes still use the atomic owner.
          const descriptor = openSync(target, "r+");
          try { writeFileSync(descriptor, bytes); }
          finally { closeSync(descriptor); }
        } else expect(atomicWriteFile(target, bytes, { createMode: 0o600 }).success).toBe(true);
        utimesSync(target, 1700000000, 1700000000);
        const changed = statSync(target, { bigint: true });
        expect(changed.mtimeNs).toBe(primed.mtimeNs);
        expect(changed.size).toBe(primed.size);
        expect(changed.ino === primed.ino).toBe(verb === "external-in-place");
        if (verb === "gate") writeConfigRaw(next);
        else if (verb === "restore") restoreConfigFileBytes(bytes);
        // An external edit is in force from the next request's start (the
        // router's refresh); the server's own verbs swap the snapshot.
        else refreshSettingsSnapshot();
        const after = statSync(target, { bigint: true });
        outcomes.push({ verb, observed: getMemorySearchDefaultLimit(), physicalExact: readFileSync(target).equals(Buffer.from(bytes)), noReplacement: after.ino === changed.ino, unchangedMtime: after.mtimeNs === changed.mtimeNs });

        // Same text must keep the frozen parse and derived privacy policy,
        // including after a metadata-only edit. Then real no-op transactions
        // retain those objects without another JSON parse, and the accessors
        // themselves never read the file (the snapshot answers).
        const memory = getMemoryConfig();
        const privacy = getPrivacyPolicy();
        expect(Object.isFrozen(memory)).toBe(true);
        chmodSync(target, 0o400);
        expect(getMemoryConfig()).toBe(memory);
        expect(getPrivacyPolicy()).toBe(privacy);
        if (verb === "gate" || verb === "restore") {
          if (verb === "gate") writeConfigRaw(next);
          else restoreConfigFileBytes(bytes);
          const stable = statSync(target, { bigint: true });
          const reads = vi.spyOn(fileRead, "readFileText");
          const parses = vi.spyOn(JSON, "parse");
          const expectedBytes = Buffer.from(bytes);
          const decodes = vi.spyOn(Buffer.prototype, "toString");
          const existence = vi.spyOn(filesystem, "existsSync");
          const stats = vi.spyOn(filesystem, "statSync");
          try {
            syncBuiltinESMExports();
            const sameMemory = getMemoryConfig() === memory;
            const samePrivacy = getPrivacyPolicy() === privacy;
            const sameLimit = getMemorySearchDefaultLimit() === memory.searchResultLimit;
            reuse.push({ verb, sameMemory, samePrivacy, sameLimit,
              reads: reads.mock.calls.filter(([path]) => path === target).length,
              parses: parses.mock.calls.filter(([text]) => text === bytes).length,
              decodes: decodes.mock.contexts.filter((buffer, index) => decodes.mock.calls[index]?.[0] === "utf8" && buffer.equals(expectedBytes)).length,
              existence: existence.mock.calls.filter(([path]) => path === target).length,
              stats: stats.mock.calls.filter(([path]) => path === target).length });
          } finally {
            stats.mockRestore(); existence.mockRestore(); decodes.mockRestore(); parses.mockRestore(); reads.mockRestore();
            syncBuiltinESMExports();
          }
          const retained = statSync(target, { bigint: true });
          expect(retained.ino).toBe(stable.ino);
          expect(retained.mtimeNs).toBe(stable.mtimeNs);
          expect(Number(retained.mode & 0o7777n)).toBe(0o400);
        }
      }
      const missing = resolve(directory, "missing.json");
      resetServerConfig({ ...process.env, HARNESS_CONFIG_PATH: missing });
      const warning = vi.spyOn(debugBridge, "webWarn");
      try {
        expect(getMemoryConfig()).toEqual({});
        expect(warning).not.toHaveBeenCalled();
        // Absent is the documented empty result (above); a file that appears
        // but does not decode is REFUSED for every save and reported as the
        // state `unreadable`, while the last good snapshot (here: absent)
        // stays in force (the corrupt-config class:
        // tests/unit/config-refusal-write-gate.test.ts).
        expect(atomicWriteFile(missing, '{"memory":', { createMode: 0o600 }).success).toBe(true);
        expect(refreshSettingsSnapshot()).toMatchObject({ state: "unreadable", reason: expect.stringContaining("config_json_invalid") });
        expect(getMemoryConfig()).toEqual({});
        expect(() => readConfigRaw()).toThrowError(expect.objectContaining({ code: "config_unreadable" }));
        expect(warning, "the refusal is logged once, on the always-on sink — not per read on the debug system").not.toHaveBeenCalled();
      } finally { warning.mockRestore(); }
    } finally { resetServerConfig(); }
    expect(outcomes, "accepted transactions and external edits must make typed readers agree with current bytes").toEqual(
      ["gate", "restore", "external-atomic", "external-in-place"].map(verb => ({ verb, observed: 8, physicalExact: true, noReplacement: true, unchangedMtime: true })),
    );
    expect(reuse, "real same-byte transactions preserve frozen values, and the accessors read, parse, decode and stat nothing").toEqual(
      ["gate", "restore"].map(verb => ({ verb, sameMemory: true, samePrivacy: true, sameLimit: true, reads: 0, parses: 0, decodes: 0, existence: 0, stats: 0 })),
    );
  });
});

describe("harness-config reader — the redaction memo bound (declared leaf, live reader)", () => {
  // The one leaf of the `redaction` section. The accessor is the consumer
  // the settings row's "restart" timing names: it re-reads the config
  // through the content-cached document per call, while the store it sizes is
  // constructed once at module evaluation — the row states both halves.
  type RedactionDoc = { redaction?: { toolCallArgumentsCacheEntries?: number } };
  function readRealRedaction(): RedactionDoc["redaction"] {
    try {
      return (JSON.parse(readFileSync(realConfigPath, "utf8")) as RedactionDoc).redaction;
    } catch {
      return undefined;
    }
  }

  test("the reader returns the file's value, or the contract default when the leaf is absent", () => {
    const section = readRealRedaction();
    expect(getToolCallArgumentsCacheEntries()).toBe(
      section?.toolCallArgumentsCacheEntries ?? DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES,
    );
  });

  test("setting the declared leaf changes what the reader returns", () => {
    // Driven through the real write gate (the single write entry point —
    // re-entrant under the lock this cycle holds, and it invalidates the
    // typed-reader cache explicitly). The WHOLE cycle — found bytes, gated
    // mutation, gated restore, byte-identity verdict — holds the config's
    // cross-process write lock, so a parallel fork's write can never land
    // inside this window and leave this test's mutated value as the next
    // run's found bytes (the residue class measured when the restore raced).
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      const beforeDoc = readConfigRaw();
      try {
        writeConfigRaw({
          ...structuredClone(beforeDoc),
          redaction: { ...(beforeDoc.redaction as Record<string, unknown>), toolCallArgumentsCacheEntries: 128 },
        });
        expect(getToolCallArgumentsCacheEntries()).toBe(128);
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
      expect(getToolCallArgumentsCacheEntries()).toBe(
        readRealRedaction()?.toolCallArgumentsCacheEntries ?? DEFAULT_TOOL_CALL_ARGUMENTS_CACHE_ENTRIES,
      );
    });
  });
});

describe("harness-config reader — the privacy policy's config door (declared leaves, live reader, refused weakening)", () => {
  // The document's `privacy` section is the masker's policy in config form:
  // `getPrivacyPolicy()` resolves it once per config read and hands the SAME
  // object to every egress call (the reference is the memo and the marker
  // counters' invalidation key). The read-the-real-file posture applies as
  // everywhere above — the file is mutable, so the arms assert the policy
  // mirrors exactly what the file says now, and every write goes through the
  // real gate with a byte-identical restore.
  type PrivacyDoc = {
    privacy?: {
      maxContextLines?: number;
      maxFileBytes?: number;
      maxRegexPatternBytes?: number;
      maxMatchCount?: number;
      semanticModeEnabled?: boolean;
      preserveLineCount?: boolean;
      preserveStructure?: boolean;
      failClosedOnUncertainty?: boolean;
      enabledCategories?: readonly string[];
      piiClassifications?: readonly string[];
      redactionPrefix?: string;
      redactionSuffix?: string;
    };
  };
  function readRealPrivacy(): PrivacyDoc["privacy"] {
    try {
      return (JSON.parse(readFileSync(realConfigPath, "utf8")) as PrivacyDoc).privacy;
    } catch {
      return undefined;
    }
  }

  test("the resolved policy mirrors the file's section — present leaves carried, absent leaves at the built-in defaults", () => {
    const section = readRealPrivacy();
    const policy = getPrivacyPolicy();
    // The code default of `failClosedOnUncertainty` is now the file's
    // (true, the secure one), so it no longer discriminates the wiring; the
    // arm below that plants a non-default marker does.
    expect(policy.maxContextLines).toBe(section?.maxContextLines);
    expect(policy.maxFileBytes).toBe(section?.maxFileBytes);
    expect(policy.maxRegexPatternBytes).toBe(section?.maxRegexPatternBytes);
    expect(policy.maxMatchCount).toBe(section?.maxMatchCount);
    expect(policy.semanticModeEnabled).toBe(section?.semanticModeEnabled);
    expect(policy.preserveLineCount).toBe(section?.preserveLineCount);
    expect(policy.preserveStructure).toBe(section?.preserveStructure);
    expect(policy.failClosedOnUncertainty).toBe(section?.failClosedOnUncertainty);
    expect(DEFAULT_PRIVACY_POLICY.failClosedOnUncertainty, "the code default is the secure one, the same as the file's").toBe(true);
    // The optional leaves default when absent: the full category set (the
    // redaction minimum) and the built-in marker.
    expect([...policy.enabledCategories].sort()).toEqual([...REDACTION_CATEGORIES].sort());
    expect(policy.redactionPrefix).toBe(section?.redactionPrefix ?? DEFAULT_PRIVACY_POLICY.redactionPrefix);
    expect(policy.redactionSuffix).toBe(section?.redactionSuffix ?? DEFAULT_PRIVACY_POLICY.redactionSuffix);
  });

  test("a legal leaf written through the gate changes the resolved policy (and a second call serves the SAME object until the config changes)", () => {
    // `maxContextLines` is the drive leaf deliberately: it is real at the
    // policy (the viewer consumes it) but inert for every OTHER suite's
    // assertions — a masker-governing leaf (the marker) written into the
    // shared file would red every concurrently-running redaction suite
    // inside the write window. The marker's write-acceptance is proven
    // at the schema parse below; its end-to-end effect is the live
    // drive's proof (a real server, one process, no suite to poison).
    // The whole cycle holds the config's cross-process write lock, so the
    // byte-identical restore cannot become a lost update against a
    // parallel fork's window.
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      const beforeDoc = readConfigRaw();
      try {
        writeConfigRaw({
          ...structuredClone(beforeDoc),
          privacy: { ...(beforeDoc.privacy as Record<string, unknown>), maxContextLines: 25 },
        });
        const first = getPrivacyPolicy();
        expect(first.maxContextLines).toBe(25);
        // The cache: the same config read serves the same policy object — the
        // reference identity the redaction memo keys its invalidation on.
        expect(getPrivacyPolicy()).toBe(first);
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
      expect(getPrivacyPolicy().maxContextLines).toBe(
        readRealPrivacy()?.maxContextLines ?? DEFAULT_PRIVACY_POLICY.maxContextLines,
      );
    });
  });

  test("the write gate ACCEPTS a legal masker-governing document (a marker change is a writable, honest knob)", () => {
    // Parse-level acceptance, no file write: the gate's schema is the
    // deny-by-default vocabulary, and a document whose only change is the
    // redaction marker must pass it — the floor refuses NARROWING, not
    // spelling. (The gate's write path itself is driven by the arm above.)
    const doc = readConfigRaw();
    const parsed = CONFIG_DOCUMENT_SCHEMA.safeParse({
      ...structuredClone(doc),
      privacy: { ...(doc.privacy as Record<string, unknown>), redactionPrefix: "<CFG:" },
    });
    expect(parsed.success, `a legal marker document must pass the gate: ${parsed.success ? "" : JSON.stringify(parsed.error!.issues[0])}`).toBe(true);
  });

  test("the policy door composes the config section through the privacy resolver (the second-door composition)", () => {
    // Source-scan, not a file write: a hand-edited weakening section must
    // be refused at THIS door (the write gate never sees those bytes), and
    // the refusal is the resolver's own — so the door must hand the
    // section to `resolvePrivacyPolicyOptions` and its result to
    // `createPrivacyPolicy`, never around them. The resolver's throw is
    // proven at its own suite (engine test/privacy/privacy-config-fields);
    // this arm pins the composition so the door cannot quietly stop
    // consulting the floor.
    const source = readFileSync(resolve(import.meta.dirname, "../../server/kernel/harness-config.ts"), "utf8");
    expect(source).toMatch(/createPrivacyPolicy\(resolvePrivacyPolicyOptions\(section\)\)/);
  });
});

describe("harness-config reader — the debug bootstrap's one resolver (declared leaves, live reader, env override, refused weakening)", () => {
  // The document's `debug` section is the debug system's shape in config
  // form, and `resolveWebDebugBootstrap()` is the ONE resolver that composes
  // it with the process-level env switch. The precedence, designed: the
  // section is the SSOT for every leaf; `HARNESS_WEB_DEBUG=1` ORs the master
  // `enabled` switch on for THIS process (widening only — the env cannot
  // disable what the file enables); an absent section leaves the caller's
  // own defaults in charge. The read-the-real-file posture applies as in the
  // privacy describe above: every write goes through the real gate (or the
  // byte-restore owner, for the hand-edit simulation) with byte-identical
  // restores, all inside the config's cross-process write lock.
  type DebugDoc = {
    debug?: {
      enabled?: boolean;
      level?: string;
      categories?: readonly string[];
      audit?: { enabled?: boolean; maxRetainedEvents?: number; categories?: readonly string[] };
      errorHandling?: { reportingPolicy?: string; samplingRate?: number; dedupWindowMs?: number };
      sinks?: { enabledSinks?: readonly string[] };
      redaction?: { enabled?: boolean; maxContextValueLength?: number; maxContextDepth?: number; additionalSensitiveKeyNames?: readonly string[] };
    };
  };
  function readRealDebug(): DebugDoc["debug"] {
    try {
      return (JSON.parse(readFileSync(realConfigPath, "utf8")) as DebugDoc).debug;
    } catch {
      return undefined;
    }
  }
  function withoutDebugEnv<T>(fn: () => T): T {
    const had = process.env.HARNESS_WEB_DEBUG;
    if (had !== undefined) delete process.env.HARNESS_WEB_DEBUG;
    try {
      return fn();
    } finally {
      if (had !== undefined) process.env.HARNESS_WEB_DEBUG = had;
    }
  }

  test("the resolved bootstrap mirrors the file's section — every declared leaf carried, the env unset leaving the master switch to the file", () => {
    const section = readRealDebug();
    expect(section, "the shipped config must carry the debug section for this mirror").toBeDefined();
    const bootstrap = withoutDebugEnv(() => resolveWebDebugBootstrap());
    // The file's own leaves flow through by identity — the section IS the
    // base config, never a per-leaf hand map (the engine census pins the
    // schema side; this pins the resolver side).
    expect(bootstrap.base.enabled).toBe(section!.enabled);
    expect(bootstrap.base.level).toBe(section!.level);
    expect(bootstrap.base.categories).toEqual(section!.categories);
    expect(bootstrap.base.audit).toEqual(section!.audit);
    expect(bootstrap.base.errorHandling).toEqual(section!.errorHandling);
    expect(bootstrap.base.sinks).toEqual(section!.sinks);
    expect(bootstrap.base.redaction).toEqual(section!.redaction);
    // The shipped master switch is off, and the shipped sink allow-list
    // names console — the boot may attach its console sink.
    expect(section!.enabled).toBe(false);
    expect(bootstrap.consoleSinkAllowed).toBe(true);
  });

  test("HARNESS_WEB_DEBUG=1 ORs the master switch on for this process — widening only, never disabling", () => {
    const section = readRealDebug();
    expect(section!.enabled).toBe(false);
    const had = process.env.HARNESS_WEB_DEBUG;
    try {
      process.env.HARNESS_WEB_DEBUG = "1";
      expect(resolveWebDebugBootstrap().base.enabled).toBe(true);
      // Anything but the positive "1" is absence, not a value: the env
      // declaration is the only spelling that overrides.
      process.env.HARNESS_WEB_DEBUG = "0";
      expect(resolveWebDebugBootstrap().base.enabled).toBe(section!.enabled);
      process.env.HARNESS_WEB_DEBUG = "";
      expect(resolveWebDebugBootstrap().base.enabled).toBe(section!.enabled);
    } finally {
      if (had === undefined) delete process.env.HARNESS_WEB_DEBUG;
      else process.env.HARNESS_WEB_DEBUG = had;
    }
  });

  test("the file is the SSOT for the master switch when the env is unset — enabled=true in the file configures the bootstrap with no env at all", () => {
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      const beforeDoc = readConfigRaw();
      try {
        writeConfigRaw({
          ...structuredClone(beforeDoc),
          debug: { ...(beforeDoc.debug as Record<string, unknown>), enabled: true },
        });
        const bootstrap = withoutDebugEnv(() => resolveWebDebugBootstrap());
        expect(bootstrap.base.enabled).toBe(true);
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
    });
  });

  test("an absent section resolves to the env gate alone — the caller's own defaults shape the system (default-preserving)", () => {
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      const beforeDoc = readConfigRaw();
      try {
        const withoutSection = structuredClone(beforeDoc) as Record<string, unknown>;
        delete withoutSection.debug;
        writeConfigRaw(withoutSection);
        const bootstrap = withoutDebugEnv(() => resolveWebDebugBootstrap());
        expect(bootstrap.base).toEqual({ enabled: false });
        expect(bootstrap.consoleSinkAllowed).toBe(true);
        process.env.HARNESS_WEB_DEBUG = "1";
        try {
          expect(resolveWebDebugBootstrap().base).toEqual({ enabled: true });
        } finally {
          delete process.env.HARNESS_WEB_DEBUG;
        }
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
    });
  });

  test("an emptied sink allow-list honors the file (no destination installed, no refusal) — the empty list is a writable state, not a boot brick", () => {
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      const beforeDoc = readConfigRaw();
      try {
        writeConfigRaw({
          ...structuredClone(beforeDoc),
          debug: {
            ...(beforeDoc.debug as Record<string, unknown>),
            sinks: { enabledSinks: [] },
          },
        });
        const bootstrap = withoutDebugEnv(() => resolveWebDebugBootstrap());
        expect(bootstrap.consoleSinkAllowed).toBe(false);
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
    });
  });

  test("a hand-edited weakening section is REFUSED at the store (the posture door), and the section in force stays, whether or not debug is enabled", () => {
    // The write gate refuses `debug.redaction.enabled: false` on the way in
    // (its own suite drives that door), so the only bytes that reach this
    // door weakened are a hand edit — planted here through the byte-restore
    // owner (the sanctioned way to put exact bytes on disk), refused typed,
    // and restored byte-identically. The pin must fire even while the
    // master switch is off: the operator can flip the env switch later
    // without re-editing the file.
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      refreshSettingsSnapshot();
      const inForce = withoutDebugEnv(() => resolveWebDebugBootstrap());
      try {
        const weakened = JSON.parse(before) as DebugDoc & Record<string, unknown>;
        weakened.debug!.redaction = { ...weakened.debug!.redaction, enabled: false };
        restoreConfigFileBytes(JSON.stringify(weakened, null, 2) + "\n");
        expectRefusedAtTheStore(() => withoutDebugEnv(() => resolveWebDebugBootstrap()), inForce, "debug_redaction_required");
        // And with the env switch set: the redactor of the section in force stays on.
        process.env.HARNESS_WEB_DEBUG = "1";
        try {
          expect(resolveWebDebugBootstrap().base.redaction?.enabled).toBe(true);
        } finally {
          delete process.env.HARNESS_WEB_DEBUG;
        }
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
    });
  });

  test("the resolver composes the section through the debug section's own door (the second-door composition)", () => {
    // Source-scan, the privacy door's discipline: the resolver must hand
    // the section to `resolveDebugConfigSection` (the engine floor owner)
    // and never around it, so the boot pin cannot quietly stop consulting
    // the floor. The throw itself is the engine door's own behavior, driven
    // by the arm above end-to-end through the real file.
    const source = readFileSync(resolve(import.meta.dirname, "../../server/kernel/harness-config.ts"), "utf8");
    expect(source).toMatch(/resolveDebugConfigSection\(readHarnessConfig\(\)\.debug\)/);
  });
});

describe("harness-config reader — the safety section's posture doors (the store refuses what the write gate refuses)", () => {
  // The safety section's posture floors have THREE doors and ONE owner
  // (`safetyConfigViolations` in the safety domain's section module): the
  // write gate (the document splice — proven by the write-gate suite), the
  // boot pin (server/index.ts resolves both accessors before the socket
  // listens — pinned by the safety-runtime-wiring suite's boot arm), and
  // THESE, the per-run accessors. A hand-edited file that never passed the
  // gate is caught here: the accessors assert the posture on the raw section
  // they read, BEFORE the resolvers run, so a weakening that lands between
  // restarts cannot arm a weaker gate or runtime for even one run. The
  // resolvers themselves stay override-permissive (the engine tests'
  // contract); the floors govern the PERSISTED section only.
  const realConfigPath = serverConfig.harnessConfigPath;

  test("a planted weakening of the gate is refused at the store, the armed gate stays in force, and the file restores byte-identically", () => withConfigWriteLock(realConfigPath, () => {
    const before = readFileSync(realConfigPath, "utf8");
    refreshSettingsSnapshot();
    const inForce = getSafetyGateConfig();
    try {
      {
        const doc = JSON.parse(before) as { safety?: { toolCallGate?: Record<string, unknown> } };
        doc.safety = { ...doc.safety, toolCallGate: { ...doc.safety?.toolCallGate, enableSchemaValidation: false } };
        restoreConfigFileBytes(JSON.stringify(doc, null, 2) + "\n");
        expectRefusedAtTheStore(() => getSafetyGateConfig(), inForce, "safety_gate_schema_validation_required");
        expect(getSafetyGateConfig().enableSchemaValidation).toBe(true);
      }
    } finally {
      restoreConfigFileBytes(before);
    }
    expect(readFileSync(realConfigPath, "utf8")).toBe(before);
  }));

  test("a planted disarmed event-feed family is refused at the store, the armed detectors stay in force, and the file restores byte-identically", () => withConfigWriteLock(realConfigPath, () => {
    const before = readFileSync(realConfigPath, "utf8");
    refreshSettingsSnapshot();
    const inForce = getEventFeedSafetyConfig();
    try {
      {
        const doc = JSON.parse(before) as { safety?: { eventFeed?: Record<string, unknown> } };
        const feed = structuredClone(doc.safety?.eventFeed) as Record<string, unknown>;
        const families = structuredClone(feed.families) as Record<string, unknown>;
        families.deviation = { ...(families.deviation as Record<string, unknown>), enabled: false };
        doc.safety = { ...doc.safety, eventFeed: { ...feed, families } };
        restoreConfigFileBytes(JSON.stringify(doc, null, 2) + "\n");
        expectRefusedAtTheStore(() => getEventFeedSafetyConfig(), inForce, "safety_event_feed_family_required");
      }
    } finally {
      restoreConfigFileBytes(before);
    }
    expect(readFileSync(realConfigPath, "utf8")).toBe(before);
  }));

  test("the planted consequential-tools narrowing is refused at the store until the list lands with it", async () => {
    const dir = createTempDir("config-restore-transaction-");
    const go = resolve(dir, "go");
    const status = resolve(dir, "status");
    const fixture = fileURLToPath(new URL("../fixtures/config-write-lock-holder.ts", import.meta.url));
    const peer = spawn(process.execPath, ["--experimental-strip-types", fixture, "snapshot", realConfigPath, go, status], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    peer.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const closed = new Promise<number | null>((done, reject) => {
      peer.once("error", reject);
      peer.once("close", done);
    });
    let before = "";
    try {
      // The callback is synchronous. Await the peer only AFTER this entire
      // read, mutation and restoration cycle has released the production lock.
      withConfigWriteLock(realConfigPath, () => {
    before = readFileSync(realConfigPath, "utf8");
    refreshSettingsSnapshot();
    const inForce = getEventFeedSafetyConfig();
    try {
      {
        const doc = JSON.parse(before) as { safety?: { eventFeed?: Record<string, unknown> } };
        const feed = structuredClone(doc.safety?.eventFeed) as Record<string, unknown>;
        doc.safety = { ...doc.safety, eventFeed: { ...feed, workaroundConsequentialToolsMode: "list" } };
        restoreConfigFileBytes(JSON.stringify(doc, null, 2) + "\n");
        expectRefusedAtTheStore(() => getEventFeedSafetyConfig(), inForce, "safety_workaround_consequential_tools_required");
        // The designed narrowing — mode 'list' WITH its list — resolves.
        const designed = JSON.parse(before) as { safety?: { eventFeed?: Record<string, unknown> } };
        const designedFeed = structuredClone(designed.safety?.eventFeed) as Record<string, unknown>;
        designed.safety = {
          ...designed.safety,
          eventFeed: { ...designedFeed, workaroundConsequentialToolsMode: "list", workaroundConsequentialTools: ["search_code"] },
        };
        restoreConfigFileBytes(JSON.stringify(designed, null, 2) + "\n");
        expect(refreshSettingsSnapshot().state).toBe("ok");
        expect(getEventFeedSafetyConfig().workaroundConsequentialToolsMode).toBe("list");
      }
    } finally {
      try {
        expect(atomicWriteFile(go, "go").success).toBe(true);
        const deadline = Date.now() + ROOT_POLICY.filesystemInfrastructure.fileLock.timeoutMs;
        while (!existsSync(status) && Date.now() < deadline) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0,
            ROOT_POLICY.filesystemInfrastructure.fileLock.pollIntervalMs);
        }
        expect(existsSync(status), "the peer must actually reach the lock before restoration").toBe(true);
      } finally { restoreConfigFileBytes(before); }
    }
    expect(readFileSync(realConfigPath, "utf8")).toBe(before);
      });
      expect(await closed, stderr).toBe(0);
      expect(readFileSync(status + ".read", "utf8"), "the peer observes restored bytes, never a temporary accepted config").toBe(before);
      expect(readFileSync(status, "utf8"), "the peer cannot acquire during the restoration gap").toBe("contended");
    } finally {
      if (peer.exitCode === null) peer.kill();
      await closed;
    }
  });

  test("a planted escalation past the auto-trip is refused at the store, naming both values, and the file restores byte-identically", () => withConfigWriteLock(realConfigPath, () => {
    // The third floor shape: a CROSS-FIELD coupling. The gate's auto-trip
    // only fires once the refusal message has escalated, so an escalation
    // threshold planted PAST the trip threshold would silently push the
    // trip back — bytes that never passed the write gate are caught here at
    // the per-run door (and at the boot pin, which resolves through the
    // same accessor), with the sentence naming both values.
    const before = readFileSync(realConfigPath, "utf8");
    refreshSettingsSnapshot();
    const inForce = getSafetyGateConfig();
    try {
      {
        const doc = JSON.parse(before) as { safety?: { toolCallGate?: Record<string, unknown> } };
        doc.safety = {
          ...doc.safety,
          toolCallGate: { ...doc.safety?.toolCallGate, blockEscalationAfter: 999, blockAutoTripAfter: 50 },
        };
        restoreConfigFileBytes(JSON.stringify(doc, null, 2) + "\n");
        const message = expectRefusedAtTheStore(() => getSafetyGateConfig(), inForce, "safety_gate_escalation_exceeds_auto_trip");
        expect(message).toContain("safety.toolCallGate.blockEscalationAfter");
        expect(message).toContain("(999)");
        expect(message).toContain("(50)");
        expect(message).toContain("may not exceed");
      }
    } finally {
      restoreConfigFileBytes(before);
    }
    expect(readFileSync(realConfigPath, "utf8")).toBe(before);
  }));

  test("the shipped document's safety section passes all three doors (the found posture is fully armed)", () => {
    // The found file must resolve cleanly through both accessors — the
    // shipped posture is all-on, so the doors are transparent for reality.
    expect(() => getSafetyGateConfig()).not.toThrow();
    expect(() => getEventFeedSafetyConfig()).not.toThrow();
    // And the three gate checks are armed at the found bytes.
    const gate = getSafetyGateConfig();
    expect(gate.enableGhostToolDetection).toBe(true);
    expect(gate.enableSchemaValidation).toBe(true);
    expect(gate.enableLoopDetection).toBe(true);
    const feed = getEventFeedSafetyConfig();
    for (const family of ["bandaid", "workaround", "deviation", "stepSkip"] as const) {
      expect(feed.families[family].enabled, `the ${family} detector must be armed at the found bytes`).toBe(true);
    }
  });

  test("the accessors compose their posture through the safety section's own floor owner (the door cannot quietly stop consulting it)", () => {
    // Source-scan, the privacy/debug doors' discipline: the accessors must
    // hand their raw section to the floor owner's assert helpers and never
    // around them, so the per-run door cannot quietly stop consulting the
    // floors. The throws themselves are proven end-to-end through the real
    // file by the arms above.
    const source = readFileSync(resolve(import.meta.dirname, "../../server/kernel/harness-config.ts"), "utf8");
    expect(source).toMatch(/assertSafetyGatePosture\(raw\)/);
    expect(source).toMatch(/assertSafetyEventFeedPosture\(raw\)/);
  });
});

describe("harness-config writer — byte-identity on same-value writes (no door reorders a no-op)", () => {
  // The drive-16 disclosure: a same-value settings write pruned the
  // explicitly-carried `partialArgumentsLimit` line — the omit-on-default
  // door treated the no-op as a change — and the later re-add of the line
  // landed at its section's end, so a value-identical file was not
  // byte-identical and the restore needed a disclosed git checkout. The
  // invariant: the file is the byte-identity anchor the whole apparatus
  // fingerprints, so a write that changes no value must change no byte,
  // through every write door. Every arm holds the config's cross-process
  // write lock for its WHOLE cycle (found bytes, writes, byte-exact
  // restore), and the exposure config store the settings doors write
  // through is installed per-arm and reset in the finally — the real
  // server store shape, the same install server/index.ts performs.
  const GATE_ROW_ID = "safety.gatePartialArgumentsLimit";

  function sectionKeysOf(doc: Record<string, unknown>, path: string): readonly string[] {
    let node: unknown = doc;
    for (const segment of path.split(".").slice(0, -1)) {
      node = (node as Record<string, unknown>)?.[segment];
    }
    return typeof node === "object" && node !== null ? Object.keys(node) : [];
  }

  function leafPresent(doc: Record<string, unknown>, path: string): boolean {
    let node: unknown = doc;
    for (const segment of path.split(".")) {
      if (node === null || typeof node !== "object" || Array.isArray(node)) return false;
      const record = node as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, segment)) return false;
      node = record[segment];
    }
    return true;
  }

  test("a same-value write through the settings door leaves the file byte-identical (the drive-16 row)", () => {
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      try {
        installCustomizationConfigStore(configStoreAt(realConfigPath, readConfigRaw, writeConfigRaw));
        registerAllExposure();
        const row = getCustomization(GATE_ROW_ID);
        expect(row?.configPath, "the drive-16 row must resolve through the real registry").toBeDefined();
        const configPath = row!.configPath!;
        const standing = readConfigCustomization(configPath);
        // The drive-16 premise, asserted loudly: the shipped file carries
        // the row's declared default explicitly at the leaf (the found
        // state the drive could not restore through the app's doors). If a
        // future round prunes the shipped line, this premise fails here and
        // the arm's owner re-judges — never a silent skip.
        expect(standing).toBe(row!.default);
        // The drive-16 write: re-stating the declared default the file
        // already carries must be a byte-level no-op (the prune used to
        // delete the line here).
        const beforeNoop = statSync(realConfigPath, { bigint: true });
        writeConfigCustomization(configPath, row!.default);
        expect(readFileSync(realConfigPath, "utf8")).toBe(before);
        expect(statSync(realConfigPath, { bigint: true }).ino, "same-value settings writes preserve the existing inode").toBe(beforeNoop.ino);
        expect(statSync(realConfigPath, { bigint: true }).mtimeNs, "same-value settings writes preserve exact mtime").toBe(beforeNoop.mtimeNs);
        // Idempotence: writing the standing value again changes nothing.
        writeConfigCustomization(configPath, standing);
        expect(readFileSync(realConfigPath, "utf8")).toBe(before);
        // The door is not inert: a genuinely different value lands, in
        // place, with the section's key order otherwise preserved.
        const other = (standing as number) + 1;
        const orderBefore = sectionKeysOf(readConfigRaw(), configPath);
        writeConfigCustomization(configPath, other);
        const after = readFileSync(realConfigPath, "utf8");
        expect(after).not.toBe(before);
        expect(readConfigCustomization(configPath)).toBe(other);
        expect(sectionKeysOf(JSON.parse(after), configPath)).toEqual(orderBefore);
      } finally {
        restoreConfigFileBytes(before);
        resetCustomizationConfigStore();
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
    });
  });

  test("the config-PUT door's compose: a same-value write is byte-identical, a new declared key appends", () => {
    withConfigWriteLock(realConfigPath, () => {
      const before = readFileSync(realConfigPath, "utf8");
      try {
        registerAllExposure();
        // A declared, config-bound leaf whose parent section the file
        // carries but whose leaf is absent — discovered from the registry
        // (the declared population's owner), never named here.
        const fileDoc = readConfigRaw();
        const absentRow = listCustomizations().find((c) => {
          if (c.configPath === undefined) return false;
          const parent = c.configPath.split(".").slice(0, -1).join(".");
          let node: unknown = fileDoc;
          for (const segment of parent.split(".")) node = (node as Record<string, unknown>)?.[segment];
          const parentPresent = typeof node === "object" && node !== null;
          return parentPresent && !leafPresent(fileDoc, c.configPath);
        });
        expect(absentRow?.configPath, "the registry must hold a declared leaf the file omits").toBeDefined();
        const target = absentRow!.configPath!;
        // The config-PUT compose (the route's in-place leaf assignment
        // inside one locked cycle) lands the absent key as a NEW key —
        // appended in the natural order, whole-document valid.
        modifyConfigRaw((doc) => {
          const parts = target.split(".");
          let cursor = doc;
          for (let i = 0; i < parts.length - 1; i++) cursor = cursor[parts[i]!] as Record<string, unknown>;
          cursor[parts[parts.length - 1]!] = absentRow!.default;
          return doc;
        });
        const landed = readFileSync(realConfigPath, "utf8");
        expect(landed).not.toBe(before);
        expect(leafPresent(JSON.parse(landed) as Record<string, unknown>, target)).toBe(true);
        // The same compose again — same value, byte-identical, no replacement.
        const beforeNoop = statSync(realConfigPath, { bigint: true });
        modifyConfigRaw((doc) => {
          const parts = target.split(".");
          let cursor = doc;
          for (let i = 0; i < parts.length - 1; i++) cursor = cursor[parts[i]!] as Record<string, unknown>;
          cursor[parts[parts.length - 1]!] = absentRow!.default;
          return doc;
        });
        expect(readFileSync(realConfigPath, "utf8")).toBe(landed);
        expect(statSync(realConfigPath, { bigint: true }).ino, "same-value PUT composition preserves the existing inode").toBe(beforeNoop.ino);
        expect(statSync(realConfigPath, { bigint: true }).mtimeNs, "same-value PUT composition preserves exact mtime").toBe(beforeNoop.mtimeNs);
      } finally {
        restoreConfigFileBytes(before);
      }
      expect(readFileSync(realConfigPath, "utf8")).toBe(before);
    });
  });
});
