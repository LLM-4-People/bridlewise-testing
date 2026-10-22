import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "eval",
  run: async ({ rest, onProgress }) => {
    const { runEvalCli } = await import("../../evaluation/cli.ts");
    return runEvalCli(rest, onProgress);
  },
};
