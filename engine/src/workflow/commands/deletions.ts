import type { HarnessCommand } from "../harness-command.ts";


export const COMMAND: HarnessCommand = {
  verb: "deletions",
  run: async ({ root, rest }) => {
    const { harnessDeletions } = await import("../harness-commands.ts");
    return { result: harnessDeletions(root, rest) };
  },
};
