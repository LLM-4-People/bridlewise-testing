import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "workspace",
  run: async ({ root, rest }) => {
    const { runWorkspaceCli } = await import("../workspace-cli.ts");
    return { result: await runWorkspaceCli(root, rest) };
  },
};
