// @vitest-environment node
/**
 * Parse/extract batch jobs go through `runIsolatedProcess` — the crash-
 * isolated farm. A second fork-pool in intelligence is the class this
 * catches. Tree-sitter languages come from the registry, not a JS/TS list.
 */
import { describe, test, expect } from "vitest";
import { readdirSync } from "node:fs";
import { readSourceView } from "../../engine/scripts/verification/source-view.ts";
import { join } from "node:path";
import { modulePathMatching } from "../helpers/module-resolver.ts";
import { getTreeSitterLanguages } from "../../engine/src/intelligence/language-registry.ts";

const INTEL = join(process.cwd(), "engine/src/intelligence");

/** The code view — comments and string interiors blanked. */
function codeOf(path: string): string {
  return readSourceView(path).code();
}

/** The strings view — quoted interiors kept (a `type: "…"` subject lives there). */
function codeWithStringsOf(path: string): string {
  return readSourceView(path).codeWithStrings();
}

function intelFiles(): string[] {
  return readdirSync(INTEL).filter((f) => f.endsWith(".ts"));
}

describe("isolated extract farm — one door", () => {
  test("the only fork in intelligence is process-farm.ts", () => {
    const forks: string[] = [];
    for (const f of intelFiles()) {
      const text = codeOf(join(INTEL, f));
      if (/\bfork\s*\(/.test(text) && f !== "process-farm.ts") forks.push(f);
    }
    expect(forks, "a second child-process pool for extract").toEqual([]);
    expect(codeOf(join(INTEL, "process-farm.ts"))).toContain("export async function runIsolatedProcess");
  });

  test("the map worker extracts through Isolated, not the in-process loop", () => {
    const worker = codeOf(modulePathMatching("server/intelligence/repository-map-worker.ts"));
    expect(worker).toContain("generateRepositoryMapIsolated");
    // The farm watchdogs come from the bridge's settings snapshot through
    // workerData: the worker isolate never imports the config owner (a store
    // that went bad after boot would otherwise fail every build it reads).
    expect(worker).toContain("input.farm");
    expect(worker).not.toMatch(/harness-config/u);
    expect(codeOf(modulePathMatching("server/intelligence/intelligence-bridge.ts"))).toContain("farm: getFarmConfig()");
    expect(worker).not.toMatch(/generateRepositoryMap\(/);
  });

  test("Isolated extract inits the languages present in that project", () => {
    const map = codeOf(join(INTEL, "repository-map.ts"));
    expect(map).toContain("runIsolatedProcess(work, [...langs]");
    expect(map).toContain("getLanguageByExtension");
    const child = codeWithStringsOf(join(INTEL, "farm-child.ts"));
    expect(child).toContain("initTreeSitterForExtract([id])");
    expect(child).toContain('type: "loading"');
  });

  test("farm-child defaults to the registry, not a JS/TS pair", () => {
    const child = codeWithStringsOf(join(INTEL, "farm-child.ts"));
    expect(child).toContain("getTreeSitterLanguages");
    const langs = getTreeSitterLanguages();
    expect(langs.length).toBeGreaterThan(2);
    expect(langs.some((s) => s.id === "python")).toBe(true);
    expect(langs.every((s) => s.treeSitter && s.treeSitterWasm !== null)).toBe(true);
  });

  test("an empty language list means none, not every registered grammar", () => {
    const child = codeWithStringsOf(join(INTEL, "farm-child.ts"));
    expect(child).toMatch(/m\.languages !== undefined\s*\n\s*\? m\.languages/);
    expect(child).not.toMatch(/m\.languages\.length > 0/);
  });

  test("the farm drops a poison language instead of failing the whole run", () => {
    const farm = codeWithStringsOf(join(INTEL, "process-farm.ts"));
    expect(farm).toContain("dropPoisonLanguage");
    expect(farm).toContain("liveLanguages");
    expect(farm).toContain('type: "loading"');
  });

  test("server intelligence never batch-extracts in-process", () => {
    const worker = codeOf(modulePathMatching("server/intelligence/repository-map-worker.ts"));
    expect(worker).toContain("generateRepositoryMapIsolated");
    const intelDir = join(process.cwd(), "server/intelligence");
    const files = readdirSync(intelDir).filter((f) => f.endsWith(".ts"));
    const inProcess: string[] = [];
    for (const f of files) {
      const text = codeOf(join(intelDir, f));
      if (/\bgenerateRepositoryMap\s*\(/.test(text)) inProcess.push(f);
    }
    expect(inProcess, "a server extract loop that is not Isolated").toEqual([]);
  });
});
