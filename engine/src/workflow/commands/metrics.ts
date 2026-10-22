import { type HarnessCommand, unknownFlag } from "./command.ts";

export const COMMAND: HarnessCommand = {
  verb: "metrics",
  run: async ({ root, rest }) => {
    if (rest.length > 0) throw unknownFlag("metrics", rest[0]!, []);
    const { harnessMetrics } = await import("../harness-commands.ts");
    return { result: harnessMetrics(root) };
  },
};
