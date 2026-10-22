import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "slot",
  run: async ({ rest }) => {
    const { runSlotCli } = await import("../slot-cli.ts");
    return runSlotCli(rest);
  },
};
