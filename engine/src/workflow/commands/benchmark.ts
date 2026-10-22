import type { HarnessCommand } from "./command.ts";


export const COMMAND: HarnessCommand = {
  verb: "benchmark",
  run: async ({ rest }) => {
    const { runBenchmarkCli } = await import("../../performance/benchmark-cli.ts");
    return runBenchmarkCli(rest);
  },
};
