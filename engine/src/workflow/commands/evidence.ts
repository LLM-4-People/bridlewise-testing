import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "evidence",
  run: async ({ root, rest }) => {
    const { harnessEvidence } = await import("../harness-commands.ts");
    return { result: harnessEvidence(root, rest) };
  },
};
