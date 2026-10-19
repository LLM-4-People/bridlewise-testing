/** Explicit normalized scripts translated to native HTTP fixtures. The real client owns preparation. */
import { vi } from "vitest";
import { responseEvents } from "../../engine/test/support/mock-provider.ts";
import type { SharedLLMClientOptions } from "../../engine/src/shared/llm/client.ts";
import { address, serve, type UpstreamHandler } from "../../engine/test/support/loopback-upstream.ts";
export const stubLlmProviderScript: Readonly<Record<string, unknown>>[] = [];
export let stubLlmProviderAttempts = 1;
export function setStubLlmProviderAttempts(count: number): void { stubLlmProviderAttempts = count; }
/** Actual parsed native HTTP bodies, never pre-client input. */
export const stubLlmProviderCalls: Record<string, unknown>[] = [];
export function resetStubLlmProvider(): void { stubLlmProviderScript.length = 0; stubLlmProviderCalls.length = 0; stubLlmProviderAttempts = 1; }
/** Each stubbed provider's answer, by the origin it pretends to be (the loopback upstream answers them all). */
const byOrigin = new Map<string, UpstreamHandler>();
function answerByOrigin(url: string, init: Parameters<UpstreamHandler>[1]): unknown {
  const handler = byOrigin.get(new URL(url).origin);
  if (handler === undefined) throw new Error(`no stubbed provider answers ${new URL(url).origin}`);
  return handler(url, init);
}
export async function stubLlmClientModule() {
  const actual = await vi.importActual<typeof import("../../engine/src/shared/llm/client.ts")>("../../engine/src/shared/llm/client.ts");
  class SharedLLMClient extends actual.SharedLLMClient {
    constructor(config: SharedLLMClientOptions) {
      let attempt = 0;
      // A REAL upstream answers (the door owns its transport): the provider's
      // address becomes the loopback server's, which is a private address.
      super({ ...config, baseUrl: address(config.baseUrl), allowPrivateAddress: true, maxRetries: { ...config.maxRetries, server: 10 }, backoff: {baseMs:1,maxMs:1,factor:1,jitter:0} });
      serve(answerByOrigin);
      byOrigin.set(new URL(config.baseUrl).origin, async (_url, init) => {
        const request = JSON.parse(String(init.body)) as Record<string, unknown>;
        stubLlmProviderCalls.push(request);
        if (++attempt < stubLlmProviderAttempts) return new Response(JSON.stringify({error:{message:"fixture retry"}}), {status:503,headers:{"content-type":"application/json"}});
        attempt = 0;
        const calls = new Map<number, {id:string;type:"function";function:{name:string;arguments:string}}>();
        const chunks: string[] = []; let terminal = false;
        for (const chunk of stubLlmProviderScript) {
          if (chunk.type === "content") chunks.push(String(chunk.text));
          if (chunk.type === "tool_call_start") calls.set(Number(chunk.index), {id:String(chunk.id),type:"function",function:{name:String(chunk.name),arguments:""}});
          if (chunk.type === "tool_call_delta") calls.get(Number(chunk.index))!.function.arguments += String(chunk.arguments ?? "");
          if (chunk.type === "finish") terminal = true;
        }
        const events = responseEvents({chunks, model:typeof request.model === "string" ? request.model : "fixture-model", toolCalls:[...calls.values()]});
        // Explicit finish authorizes the fixture's terminal. EOF remains hostile.
        const selected = terminal ? events : events.filter(event => event.type !== "response.completed");
        return new Response(selected.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {headers:{"content-type":"text/event-stream"}});
      });
    }
  }
  return {...actual, SharedLLMClient};
}
