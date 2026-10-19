// @vitest-environment node
/**
 * A USER'S OWN PROVIDER KEY ECHOED BY THE PROVIDER REACHES NO PATH OF THE RUN
 * (SECC-V-A3, the verifier's `seccv-echo-server` repro made a guard): a
 * shapeless 32-hex key — no detector fires on it — echoed in the answer text
 * and inside a tool call's arguments, split across two argument deltas. The
 * held set of the run masks it in the streamed events, in the REST/SSE
 * egress, in the ledger's response document and in the timeline database's
 * bytes on disk.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

vi.mock("../../engine/src/shared/llm/client.ts", async () => {
  const { stubLlmClientModule } = await import("../helpers/stub-llm-client.ts");
  return stubLlmClientModule();
});

import { serverConfig } from "../../server/kernel/config.ts";
import { getTimelineQuery } from "../../server/observability/timeline-bridge.ts";
import { withRecordingContext } from "../../server/kernel/canonical.ts";
import { streamChat } from "../../server/llm/llm-bridge.ts";
import { parseProviderStore, resolveProviderCredential } from "../../server/llm/providers.ts";
import { redactContent, redactForUserDisplay } from "../../server/llm/redaction.ts";
import { resetStubLlmProvider, stubLlmProviderScript } from "../helpers/stub-llm-client.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
import { TIMELINE_LLM_RESPONSE_DOCUMENT } from "../../shared/constants.ts";

function bytesOnDisk(needle: string): number {
  let count = 0;
  for (const file of [serverConfig.timelineDbPath, `${serverConfig.timelineDbPath}-wal`]) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + 1)) count += 1;
  }
  return count;
}

beforeAll(() => {
  expect(serverConfig.timelineDbPath.startsWith(process.cwd()), "the ledger under test is a scratch one").toBe(false);
  getTimelineQuery();
});

describe("the run's held set covers every path", () => {
  test("a shapeless key echoed in content and split across tool-call deltas reaches no event, egress, document or ledger byte", async () => {
    resetStubLlmProvider();
    const key = randomUUID().replaceAll("-", "");
    expect(redactContent(`x ${key} y`), "no detector fires on this shape").toContain(key);
    const witness = `held-echo-${randomUUID()}`;
    const args = JSON.stringify({ command: `echo ${key} > notes.txt ${witness}` });
    const cut = args.indexOf(key) + 11;
    stubLlmProviderScript.push(
      { type: "content", text: `here it is ${key} (${witness})` },
      { type: "tool_call_start", index: 0, id: "call_1", name: "execute_command" },
      { type: "tool_call_delta", index: 0, arguments: args.slice(0, cut) },
      { type: "tool_call_delta", index: 0, arguments: args.slice(cut) },
      { type: "finish", reason: "tool_calls" },
    );
    const store = parseProviderStore({ providers: [{ id: `echo-${randomUUID()}`, baseUrl: "https://provider.invalid/v1", apiKey: key, models: [{ id: "echo-model" }] }] });
    const credential = resolveProviderCredential(store, "echo-model", PROVIDER_FIXTURE_OWNER);
    const events: unknown[] = [];
    const actorId = `held-echo-${randomUUID()}`;
    await withRecordingContext({ actor: { kind: "user", id: actorId } }, async () => {
      for await (const event of streamChat("hello", { credential, systemPrompt: "p",
        tools: [{ type: "function", function: { name: "execute_command", description: "d", parameters: { type: "object", properties: { command: { type: "string" } } } } }] as never })) events.push(event);
    });
    await new Promise((resolve) => setImmediate(resolve));
    const raw = JSON.stringify(events);
    expect(raw, "the run happened (the witness crossed)").toContain(witness);
    expect(raw, "no streamed event carries the key").not.toContain(key);
    expect(JSON.stringify(redactForUserDisplay(events))).not.toContain(key);
    const done = events.find((event) => (event as { type: string }).type === "tool_call_done") as { arguments: { command: string } } | undefined;
    expect(done?.arguments.command, "the executed command carries the mask, not the key").toBe(`echo [REDACTED:secret] > notes.txt ${witness}`);
    const recorded = getTimelineQuery().byEventType("provider", { ascending: false, limit: 500 }).events.filter((event) => event.actorId === actorId);
    const document = (recorded[0]?.documents ?? []).find((doc) => doc.name === TIMELINE_LLM_RESPONSE_DOCUMENT)?.contentJson ?? "";
    expect(document, "the response document was recorded").toContain(witness);
    expect(document).not.toContain(key);
    expect(bytesOnDisk(witness), "the ledger holds the run").toBeGreaterThan(0);
    expect(bytesOnDisk(key), "no byte of the ledger on disk is the key").toBe(0);
    resetStubLlmProvider();
  });
});
