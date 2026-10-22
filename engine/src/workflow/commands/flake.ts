import type { HarnessCommand } from "../harness-command.ts";


export const COMMAND: HarnessCommand = {
  verb: "flake",
  run: async ({ rest }) => {
    const { runFlakeCli } = await import("../flake-cli.ts");
    return runFlakeCli(rest);
  },
};
