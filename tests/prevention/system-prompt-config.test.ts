// @vitest-environment node
/**
 * Prevention test: the system prompt's per-user preferences — stored in the
 * encrypted DB and honoured on every run.
 *
 * A system prompt override + response-style preferences (tone, sentence case,
 * emoji, icons) are stored PER-USER in the encrypted `user_prompt_prefs`
 * table (the user_model_prefs pattern), written through
 * `PUT /api/settings/prompt-prefs`, and injected into the system prompt for
 * every run. There is NO Settings-tab control for them yet (the client
 * wrappers are uncalled; prompt-registry F-PR-2 — the UI arrives with PRM-6).
 * The config file's `runtime.userPreferences` is the GLOBAL DEFAULT seed; the
 * per-user DB override wins field-by-field. There is no global override
 * (`runtime.systemPromptOverride` was never a declared leaf — F-PR-1).
 *
 * Tests against the REAL harness config + the real project directory + a
 * real DbClient (in-memory) for the per-user prefs round-trip. Verifies:
 * getUserPreferences returns typed preferences with the task-spec
 * values (concise/detailed/friendly + normal/title/upper) + defaults
 * the undeclared runtime keys (systemPromptOverride, listing) have no reader
 * buildDefaultPromptPrefs combines the config override + prefs
 * resolvePromptPrefs merges a per-session DB override over the config
 * defaults (field-by-field; non-empty DB override fully replaces the
 * config override)
 * coercePromptPrefs drops invalid fields to the defaults
 * buildSystemPrompt includes the Response style section when prefs
 * differ from defaults, and the Additional instructions section when
 * an override is set
 * The per-user DB prefs survive a "refresh" (new DbClient reads the
 * same encrypted blob back) — the persistence guarantee
 * buildSystemPrompt mentions quick_view and slice
 */

import { describe, it, expect } from "vitest";
import { join } from "node:path";

import * as harnessConfig from "../../server/kernel/harness-config.ts";
import { getUserPreferences } from "../../server/kernel/harness-config.ts";
import { getConfigDocumentSchema } from "../../engine/src/kernel/config.ts";
import { readFileSync } from "node:fs";
import { serverConfig } from "../../server/kernel/config.ts";
import {
  buildSystemPrompt,
  buildDefaultPromptPrefs,
  resolvePromptPrefs,
  coercePromptPrefs,
  type PromptPrefs,
} from "../../server/context/project-context.ts";
import { DbClient } from "../../server/db/client.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

// Use the web UI's own directory as a real project for the prompt test.
const REAL_PROJECT = process.cwd();

const CONFIG_DEFAULT_PREFS: PromptPrefs = {
  systemPromptOverride: "",
  tone: "concise",
  sentenceCase: "normal",
  emoji: false,
  icons: true,
};

describe("system prompt configurable from web", () => {
  it("the undeclared runtime keys have no reader: the strict schema refuses them, and no accessor answers them (prompt-registry F-PR-1)", () => {
    const document = JSON.parse(readFileSync(serverConfig.harnessConfigPath, "utf8")) as Record<string, any>;
    for (const extra of [{ systemPromptOverride: "x" }, { listing: { maxDepth: 9, maxEntries: 9 } }]) {
      const result = getConfigDocumentSchema().safeParse({ ...document, runtime: { ...document.runtime, ...extra } });
      expect(result.success, `runtime.${Object.keys(extra)[0]} is not a settable leaf`).toBe(false);
    }
    expect(Object.keys(harnessConfig)).not.toContain("getSystemPromptOverride");
    expect(Object.keys(harnessConfig)).not.toContain("getListingBounds");
  });

  it("getUserPreferences returns the task-spec values with valid defaults", () => {
    const prefs = getUserPreferences();
    // Task-spec tone values: concise/detailed/friendly.
    expect(["concise", "detailed", "friendly"]).toContain(prefs.tone);
    expect(typeof prefs.emoji).toBe("boolean");
    expect(typeof prefs.icons).toBe("boolean");
    // Task-spec sentenceCase values: normal/title/upper.
    expect(["normal", "title", "upper"]).toContain(prefs.sentenceCase);
  });

  it("buildDefaultPromptPrefs combines the config override + prefs", () => {
    const prefs = buildDefaultPromptPrefs();
    expect(prefs.systemPromptOverride, "no global override exists").toBe("");
    expect(["concise", "detailed", "friendly"]).toContain(prefs.tone);
    expect(["normal", "title", "upper"]).toContain(prefs.sentenceCase);
    expect(typeof prefs.emoji).toBe("boolean");
    expect(typeof prefs.icons).toBe("boolean");
  });

  it("buildSystemPrompt produces a non-empty prompt with project context", () => {
    const prompt = buildSystemPrompt({
      projectName: "test-project",
      projectPath: REAL_PROJECT,
      tools: [],
    });
    expect(prompt.length).toBeGreaterThan(50);
    expect(prompt).toContain("test-project");
    expect(prompt).toContain("## Available tools");
    expect(prompt).toContain("## Instructions");
  });

  it("buildSystemPrompt mentions quick_view and slice tools in instructions", () => {
    const prompt = buildSystemPrompt({
      projectName: "test",
      projectPath: REAL_PROJECT,
      tools: [],
    });
    expect(prompt).toContain("quick_view");
    expect(prompt).toContain("slice");
  });

  it("buildSystemPrompt includes a Response style section when prefs differ from defaults", () => {
    const prompt = buildSystemPrompt({
      projectName: "test",
      projectPath: REAL_PROJECT,
      tools: [],
    });
    const hasPrefsSection = prompt.includes("## Response style");
    const hasOverrideSection = prompt.includes("## Additional instructions");
    // No override is set (the config has no global one), so no override section.
    expect(hasOverrideSection).toBe(false);
    // The prefs section appears iff at least one pref differs from defaults.
    const defaults = CONFIG_DEFAULT_PREFS;
    const resolved = buildDefaultPromptPrefs();
    const hasNonDefaultPref =
      resolved.tone !== defaults.tone ||
      resolved.emoji !== defaults.emoji ||
      resolved.icons !== defaults.icons ||
      resolved.sentenceCase !== defaults.sentenceCase;
    expect(hasPrefsSection).toBe(hasNonDefaultPref);
  });
});

describe("resolvePromptPrefs — per-session DB override merge", () => {
  it("returns config defaults when the session override is null/undefined", () => {
    expect(resolvePromptPrefs(CONFIG_DEFAULT_PREFS, null)).toEqual(CONFIG_DEFAULT_PREFS);
    expect(resolvePromptPrefs(CONFIG_DEFAULT_PREFS, undefined)).toEqual(CONFIG_DEFAULT_PREFS);
  });

  it("merges each DB field over the config defaults", () => {
    const merged = resolvePromptPrefs(CONFIG_DEFAULT_PREFS, {
      systemPromptOverride: "be terse",
      tone: "friendly",
      sentenceCase: "title",
      emoji: true,
      icons: false,
    });
    expect(merged.tone).toBe("friendly");
    expect(merged.sentenceCase).toBe("title");
    expect(merged.emoji).toBe(true);
    expect(merged.icons).toBe(false);
    expect(merged.systemPromptOverride).toBe("be terse");
  });

  it("a non-empty DB override fully replaces the config override", () => {
    const configWithOverride: PromptPrefs = { ...CONFIG_DEFAULT_PREFS, systemPromptOverride: "config-instruction" };
    // Non-empty DB override wins entirely (not appended).
    const merged = resolvePromptPrefs(configWithOverride, { systemPromptOverride: "db-instruction" });
    expect(merged.systemPromptOverride).toBe("db-instruction");
    // Empty DB override falls back to the config override.
    const mergedEmpty = resolvePromptPrefs(configWithOverride, { systemPromptOverride: "" });
    expect(mergedEmpty.systemPromptOverride).toBe("config-instruction");
  });

  it("buildSystemPrompt applies the session prefs (override section + tone)", () => {
    const prompt = buildSystemPrompt(
      { projectName: "test", projectPath: REAL_PROJECT, tools: [] },
      { systemPromptOverride: "Always cite file paths.", tone: "detailed", sentenceCase: "normal", emoji: false, icons: true },
    );
    expect(prompt).toContain("## Additional instructions");
    expect(prompt).toContain("Always cite file paths.");
    expect(prompt).toContain("## Response style");
    expect(prompt).toContain("thorough and detailed");
  });
});

describe("coercePromptPrefs — untrusted input", () => {
  it("drops invalid tone/sentenceCase to the defaults", () => {
    const coerced = coercePromptPrefs(
      { systemPromptOverride: "x", tone: "casual", sentenceCase: "case_sentence", emoji: "yes", icons: 1 },
      CONFIG_DEFAULT_PREFS,
    );
    expect(coerced.tone).toBe("concise"); // invalid → default
    expect(coerced.sentenceCase).toBe("normal"); // invalid → default
    expect(coerced.emoji).toBe(false); // non-boolean → default
    expect(coerced.icons).toBe(true); // non-boolean → default
    expect(coerced.systemPromptOverride).toBe("x");
  });

  it("returns defaults for null/array/object-without-override", () => {
    expect(coercePromptPrefs(null, CONFIG_DEFAULT_PREFS)).toEqual(CONFIG_DEFAULT_PREFS);
    expect(coercePromptPrefs([], CONFIG_DEFAULT_PREFS)).toEqual(CONFIG_DEFAULT_PREFS);
    expect(coercePromptPrefs({ tone: "friendly" }, CONFIG_DEFAULT_PREFS).tone).toBe("friendly");
  });
});

describe("per-user prompt prefs persistence (encrypted DB round-trip)", () => {
  it("a user's prompt prefs survive a 'refresh' (new DbClient reads the same blob)", () => {
    const dir = createTempDir("harness-prompt-prefs-");
    const dbPath = join(dir, "prefs.db");
    const prefs: PromptPrefs = {
      systemPromptOverride: "Be concise and cite paths.",
      tone: "friendly",
      sentenceCase: "title",
      emoji: true,
      icons: false,
    };
    // Process 1: save the user's prefs.
    {
      const db = new DbClient({ path: dbPath });
      try {
        db.upsertUserPromptPrefs("sess-A", prefs);
        const read = db.getUserPromptPrefs("sess-A");
        expect(read).not.toBeNull();
        expect((read as Record<string, unknown>).tone).toBe("friendly");
      } finally {
        db.close();
      }
    }
    // Process 2 (refresh): new DbClient, same key file → decrypts the blob.
    {
      const db = new DbClient({ path: dbPath });
      try {
        const read = db.getUserPromptPrefs("sess-A");
        expect(read).not.toBeNull();
        const resolved = resolvePromptPrefs(CONFIG_DEFAULT_PREFS, read);
        expect(resolved.tone).toBe("friendly");
        expect(resolved.sentenceCase).toBe("title");
        expect(resolved.emoji).toBe(true);
        expect(resolved.icons).toBe(false);
        expect(resolved.systemPromptOverride).toBe("Be concise and cite paths.");
      } finally {
        db.close();
      }
    }
  });

  it("session isolation: user B cannot read user A's prefs", () => {
    const dir = createTempDir("harness-prompt-prefs-iso-");
    const dbPath = join(dir, "iso.db");
    const db = new DbClient({ path: dbPath });
    try {
      db.upsertUserPromptPrefs("sess-A", { systemPromptOverride: "A-only", tone: "friendly" });
      expect(db.getUserPromptPrefs("sess-B")).toBeNull();
      expect((db.getUserPromptPrefs("sess-A") as Record<string, unknown>).systemPromptOverride).toBe("A-only");
    } finally {
      db.close();
    }
  });
});
