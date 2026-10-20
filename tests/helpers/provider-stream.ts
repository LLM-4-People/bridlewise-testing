/**
 * Terminal provider evidence for a stubbed `SharedLLMClient.stream` stream.
 *
 * The engine's `ResponseTurn` settles only with a native `response` event as
 * well as the streamed finish. Tests that yield a hand-written stream must
 * carry the same terminal resource a real provider does; this helper builds it
 * from the canonical Responses fixtures instead of hand-shaping a second
 * response format.
 */
import { nativeResponseEvent, responseResource, type ResponsesFixture } from "../../engine/test/support/mock-provider.ts";
import { parseResponseResource } from "../../engine/src/shared/llm/responses.ts";
import type { StreamChunk } from "../../engine/src/shared/llm/client.ts";

export function completedResponse(options: ResponsesFixture = {}): Extract<StreamChunk, { type: "response" }> {
  return nativeResponseEvent(parseResponseResource(responseResource(options)), "completed");
}
