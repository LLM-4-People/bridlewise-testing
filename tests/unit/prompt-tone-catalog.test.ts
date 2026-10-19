// @vitest-environment node
/**
 * THE TONE SENTENCE HAS ONE SOURCE (specs/prompt-registry.md §10 F-PR-3).
 *
 * The system prompt's "Response style" lines for a tone restated, byte for
 * byte, the instructions of the prompt composer's tone catalog
 * (`webUi.promptGenerator.tones`). The prompt now reads the catalog entry, so
 * an edit of the catalog is the edit of the prompt, and no second copy can
 * drift. A tone the catalog does not carry adds no line.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { buildSystemPrompt } from "../../server/context/project-context.ts";
import { isolateHarnessConfig, plantSettingsDocument } from "../helpers/isolated-config.ts";

const path = isolateHarnessConfig("prompt-tone-catalog-");
const original = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const prompt = (tone: string) => buildSystemPrompt({ projectName: "p", projectPath: process.cwd(), tools: [] }, { tone });

function plantTones(tones: readonly Readonly<{ id: string; label: string; instruction: string }>[]): void {
  const webUi = { ...original.webUi, promptGenerator: { ...original.webUi.promptGenerator, tones } };
  plantSettingsDocument(path, `${JSON.stringify({ ...original, webUi }, null, 2)}\n`);
}

describe("the system prompt's tone line", () => {
  test("is the tone catalog's instruction, read live", () => {
    plantTones([
      { id: "detailed", label: "Detailed", instruction: "CATALOG-DETAILED sentence." },
      { id: "friendly", label: "Friendly", instruction: "CATALOG-FRIENDLY sentence." },
    ]);
    expect(prompt("detailed")).toContain("- CATALOG-DETAILED sentence.");
    expect(prompt("friendly")).toContain("- CATALOG-FRIENDLY sentence.");
    expect(prompt("detailed")).not.toContain("Be thorough and detailed; explain your reasoning.");
  });

  test("a tone the catalog does not carry adds no line, and the default tone adds none", () => {
    plantTones([{ id: "friendly", label: "Friendly", instruction: "CATALOG-FRIENDLY sentence." }]);
    expect(prompt("detailed")).not.toContain("CATALOG-");
    expect(prompt("concise")).not.toContain("## Response style");
  });
});
