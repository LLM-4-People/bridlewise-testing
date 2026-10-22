import type { HarnessCommand } from "../harness-command.ts";


export const COMMAND: HarnessCommand = {
  verb: "promote",
  run: async ({ root, rest }) => {
    // Exit code: the class of the answer's code (src/workflow/promotion/codes.ts); its own report.
    const { runPromoteCli } = await import("../promotion/promote-cli.ts");
    return runPromoteCli(root, rest);
  },
};
