/** Build-only authored fixture inputs through canonical registration and Git owners. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { editorToolEntries, normalizeToolInputSchema } from "../server/tools/tool-manifest-data.ts";
import { createBuiltInToolManifestEntries } from "../engine/src/tools/built-in-tool-manifest.ts";
import { validateToolManifestEntry } from "../engine/src/tools/tool-manifest.ts";
import { createWriteSetDeniedFeedback, feedbackToStructured } from "../engine/src/editor/edit-feedback.ts";
import { gitRead } from "../server/intelligence/git-bridge.ts";
import { resolvePreimageToRange } from "../engine/src/editor/edit-resolve.ts";
import { computeEdit } from "../engine/src/editor/edit-operations.ts";
import { projectToolPresentation } from "../shared/tool-presentation.ts";
import { CODING_EXAMPLE, type CodingFixtureRecording } from "../src/demo/fixture.ts";

/** No model or tool executor is started. Only two deliberately authored files are compared. */
export function codingFixtureRecording(outputParent: string): CodingFixtureRecording {
  const editors = editorToolEntries();
  const commands = createBuiltInToolManifestEntries().filter((entry) => entry.outputShape === "command" && entry.capabilities.includes("execute"));
  if (editors.length !== 1 || commands.length !== 1) throw new TypeError("The public example needs unambiguous canonical editor and command registrations");
  const entries = [...editors, ...commands].map(normalizeToolInputSchema);
  for (const entry of entries) {
    const violations = validateToolManifestEntry(entry);
    if (violations.length !== 0) throw new TypeError("The public example has an invalid canonical tool registration: " + violations.join("; "));
  }
  const resolved = resolvePreimageToRange(CODING_EXAMPLE.before, CODING_EXAMPLE.oldString, { healCascadeEnabled: false });
  if (!resolved.ok) throw new TypeError("The authored coding example edit no longer matches its source");
  const after = computeEdit(CODING_EXAMPLE.before, { kind: "replaceRange", startByte: resolved.startByte, endByte: resolved.endByte, text: CODING_EXAMPLE.newString }).newContent;
  const scratch = mkdtempSync(join(outputParent, ".bridlewise-demo-example-"));
  try {
    mkdirSync(join(scratch, "a"), { mode: 0o700 });
    mkdirSync(join(scratch, "b"), { mode: 0o700 });
    writeFileSync(join(scratch, "a", CODING_EXAMPLE.path), CODING_EXAMPLE.before, { flag: "wx", mode: 0o600 });
    writeFileSync(join(scratch, "b", CODING_EXAMPLE.path), after, { flag: "wx", mode: 0o600 });
    const answer = gitRead(scratch, ["diff", "--no-index", "--no-prefix", "--", "a/" + CODING_EXAMPLE.path, "b/" + CODING_EXAMPLE.path], [1]);
    if (answer.kind !== "ran") throw new TypeError("The authored example patch could not be generated: " + answer.reason);
    if (answer.stdout.length === 0) throw new TypeError("The authored example change produced no patch");
    return {
      tools: entries.map(projectToolPresentation),
      patch: answer.stdout,
      refusal: { success: false, path: "package.json", feedback: feedbackToStructured(createWriteSetDeniedFeedback("package.json", CODING_EXAMPLE.path)) },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
