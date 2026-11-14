/** The same production history projection, supplied only with this fixture's admitted context. */
import { projectRecordedTranscript } from "../cockpit/flow/ingest.ts";
import { toolPresentationByName } from "../../shared/tool-presentation.ts";
import type { PublicReplay } from "./replay.ts";

export function replayBeats(record: PublicReplay): ReturnType<typeof projectRecordedTranscript> {
  return projectRecordedTranscript(record.messages, 0, {
    tools: toolPresentationByName(record.tools),
    effects: new Map(record.effects.map((effect) => [effect.messageId, effect.patch])),
  });
}
