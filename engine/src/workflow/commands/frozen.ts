import type { HarnessCommand } from "../harness-command.ts";


export const COMMAND: HarnessCommand = {
  verb: "frozen",
  run: async ({ root, rest }) => {
    const { harnessFrozen } = await import("../harness-commands.ts");
    return { result: harnessFrozen(root, rest) };
  },
};
