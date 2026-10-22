import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "diagnostic",
  run: async ({ rest }) => {
    const { runDiagnosticCli } = await import("../../performance/diagnostic-cli.ts");
    return runDiagnosticCli(rest);
  },
};
