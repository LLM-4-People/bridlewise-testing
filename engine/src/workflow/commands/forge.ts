import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "forge",
  run: async ({ root, rest, onProgress }) => {
    // GitHub, the one forge (src/workflow/forge/): its own answers and codes.
    const { runForgeCli } = await import("../forge/cli.ts");
    return runForgeCli(root, rest, onProgress);
  },
};
