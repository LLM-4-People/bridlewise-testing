import type { HarnessCommand } from "../harness-command.ts";


export const COMMAND: HarnessCommand = {
  verb: "release",
  run: async ({ root, rest }) => {
    // The product's release train (src/workflow/promotion/release-cli.ts): the promotion envelope and exit codes.
    const { runReleaseCli } = await import("../promotion/release-cli.ts");
    return runReleaseCli(root, rest);
  },
};
