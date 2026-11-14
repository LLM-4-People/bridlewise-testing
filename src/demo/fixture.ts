/** A tiny authored coding task. These bytes are public example material, not a live execution. */
import type { ToolPresentation } from "../../shared/tool-presentation.ts";
import { PUBLIC_REPLAY_SCHEMA, validatePublicReplay, type PublicReplay, type ReplaySource } from "./replay.ts";

/** One source for the request, edit and build-time diff inputs. */
export const CODING_EXAMPLE = Object.freeze({
  path: "first.mjs",
  before: "export function first(items) {\n  return items[1];\n}\n",
  oldString: "return items[1];",
  newString: "return items[0];",
  checkPath: "first.test.mjs",
  checkSource: [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { first } from "./first.mjs";',
    'test("returns the first item", () => assert.equal(first(["alpha", "beta"]), "alpha"));',
    'test("keeps an empty array empty", () => assert.equal(first([]), undefined));',
    "",
  ].join("\n"),
});

export type CodingFixtureRecording = Readonly<{
  tools: readonly ToolPresentation[];
  patch: string;
  refusal: Readonly<Record<string, unknown>>;
}>;

/** Illustrative ordering only; no performance or provider measurements are fabricated. */
const EXAMPLE_AT = Date.UTC(2026, 0, 1, 12);

export function publicFixture(source: ReplaySource, recording: CodingFixtureRecording, github: PublicReplay["github"]): PublicReplay {
  const writers = recording.tools.filter((tool) => tool.fileEffect);
  const commands = recording.tools.filter((tool) => tool.outputShape === "command");
  if (writers.length !== 1 || commands.length !== 1) throw new TypeError("The coding fixture needs one canonical editor and one command presentation");
  const editor = writers[0]!.name;
  const command = commands[0]!.name;
  return validatePublicReplay({
    schemaVersion: PUBLIC_REPLAY_SCHEMA,
    provenance: "fixture",
    title: "Return the first item",
    source,
    github,
    tools: recording.tools,
    effects: [{ messageId: "example-edit", patch: recording.patch }],
    guide: {
      purpose: "Try a tiny coding task. Inspect what changes, what is blocked and what gets checked.",
      outcome: "The example shows the change, the refused extra edit and the check output together. Your own project needs a connected workspace.",
      steps: [
        { title: "Set the goal", label: "Goal", explanation: "The request names the result and grants a change to one file. Read the original code before continuing.", messageIds: ["example-request", "example-plan"], focusMessageId: "example-request" },
        { title: "Inspect the change", label: "Change", explanation: "One index changes. Compare the removed line with its replacement.", messageIds: ["example-edit"], focusMessageId: "example-edit", focusKind: "effect" },
        { title: "Test the boundary", label: "Boundary", actionLabel: "Try the recorded out-of-scope edit", explanation: "The extra edit in this record was refused. Only " + CODING_EXAMPLE.path + " was granted. Reveal the recorded attempt to inspect why. No project is edited here.", messageIds: ["example-refused"], focusMessageId: "example-refused" },
        { title: "Read the check", label: "Checks", explanation: "The example check covers a populated array and an empty array. Its sample output is recorded here; nothing runs in your browser.", messageIds: ["example-check"], focusMessageId: "example-check" },
        { title: "Review the result", label: "Review", explanation: "Look at what changed, what was refused and what the check covers. Decide what you would accept before trying a task of your own.", messageIds: ["example-review", "example-boundary"], focusMessageId: "example-review" },
      ],
    },
    messages: [
      { id: "example-request", role: "user", content: "Fix first() to return the first item. Keep empty arrays returning undefined. Change only " + CODING_EXAMPLE.path + ", then check both cases.\n\n\u0060\u0060\u0060js\n" + CODING_EXAMPLE.before + "\u0060\u0060\u0060", timestamp: EXAMPLE_AT },
      { id: "example-plan", role: "assistant", content: "The function reads index 1, which selects the second item. I will change it to index 0, keep the edit in the granted file and inspect both check cases.", timestamp: EXAMPLE_AT + 1_000 },
      { id: "example-edit", role: "tool", content: "", timestamp: EXAMPLE_AT + 2_000, toolCall: { name: editor, input: { path: CODING_EXAMPLE.path, oldString: CODING_EXAMPLE.oldString, newString: CODING_EXAMPLE.newString }, output: { success: true, path: CODING_EXAMPLE.path, note: "Authored example result; inspect the recorded diff." }, status: "done", startedAt: EXAMPLE_AT + 2_000 } },
      { id: "example-refused", role: "tool", content: "", timestamp: EXAMPLE_AT + 3_000, toolCall: { name: editor, input: { path: "package.json", oldString: "<all>", newString: "{}\n" }, output: recording.refusal, status: "error", refused: true, startedAt: EXAMPLE_AT + 3_000 } },
      { id: "example-check", role: "tool", content: "", timestamp: EXAMPLE_AT + 4_000, toolCall: { name: command, input: { command: "node", args: ["--test", CODING_EXAMPLE.checkPath] }, output: { exitCode: 0, stdout: "Illustrative check output\nPASS returns the first item\nPASS keeps an empty array empty\n", stderr: "", cancelled: false }, status: "done", startedAt: EXAMPLE_AT + 4_000 } },
      { id: "example-review", role: "assistant", content: "The change is one index: items[1] becomes items[0]. The sample check covers a populated array and an empty array. The unrelated package.json edit was refused. No commit or release is implied; review the recorded change before accepting it.", timestamp: EXAMPLE_AT + 5_000 },
      { id: "example-boundary", role: "event", eventKind: "ui_control", content: "This published example cannot call a provider, edit a project or run a command. A connected workspace uses your project and configured provider.", timestamp: EXAMPLE_AT + 6_000 },
    ],
  });
}
