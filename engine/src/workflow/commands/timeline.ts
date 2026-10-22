import { type HarnessCommand, unknownFlag } from "./command.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import type { HarnessTimelineOptions } from "../harness-commands.ts";

function parseTimelineOptions(argv: readonly string[]): HarnessTimelineOptions {
  let runId: string | undefined;
  let limit: number | undefined;
  let eventType: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--run-id" && index + 1 < argv.length) {
      runId = argv[index + 1];
      index += 1;
    } else if (arg === "--limit" && index + 1 < argv.length) {
      const parsed = Number(argv[index + 1]);
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = Math.floor(parsed);
      }
      index += 1;
    } else if (arg === "--event-type" && index + 1 < argv.length) {
      eventType = argv[index + 1];
      index += 1;
    } else {
      throw unknownFlag("timeline", arg, ["--run-id", "--limit", "--event-type"]);
    }
  }
  const options: { runId?: string; limit?: number; eventType?: string } = {};
  if (runId !== undefined) options.runId = runId;
  if (limit !== undefined) options.limit = limit;
  if (eventType !== undefined) options.eventType = eventType;
  return deepFreeze(options);
}

export const COMMAND: HarnessCommand = {
  verb: "timeline",
  run: async ({ root, rest }) => {
    const { harnessTimeline } = await import("../harness-commands.ts");
    return { result: await harnessTimeline(root, parseTimelineOptions(rest)) };
  },
};
