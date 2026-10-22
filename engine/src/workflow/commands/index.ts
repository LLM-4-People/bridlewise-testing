import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "index",
  run: async ({ root, rest }) => {
    const { harnessIndex } = await import("../harness-commands.ts");
    return { result: harnessIndex(root, rest) };
  },
};
