import { responsesSse } from "../support/mock-provider.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createProviderAdapter,
  buildProviderConfig,
  type ProviderConfig,
} from "../../src/runtime/provider-adapter.ts";
import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import { forgetKnownSecret } from "../../src/privacy/secret-intelligence.ts";

/**
 * THE ENGINE'S LLM DOOR, DRIVEN TO A REAL WIRE.
 *
 * `provider-adapter.ts` was the engine's second outbound door and it shipped
 * with ZERO redaction: the orchestrator, the interactive session, agent
 * tools and the evaluation CLI all streamed their messages verbatim while
 * the web bridge's door masked the same classes. The fix is the
 * `RedactedMessages` brand (compile-time: the client's doors demand it) plus
 * one engine-side redaction call in the adapter (runtime: the mint actually
 * redacts). A brand can be forged with a cast, so THIS file is the
 * enforcement that cannot be: it captures the bytes an actual
 * `http.createServer` on 127.0.0.1 receives and judges those.
 *
 * §36 WITNESS DISCIPLINE, in every absence assertion here: the canary that
 * must SURVIVE sits in the same string as the credential that must NOT, so
 * "the credential is absent" is only ever concluded from a body that
 * provably contains the rest of that same sentence. A bare absence check is
 * indistinguishable from an instrument pointed at the wrong place.
 *
 * INERT-SHAPE MUTATION (documented kill): with the adapter's mint replaced
 * by the no-scan brand-attach (`mintRedactedMessages` — brand without
 * redaction, everything still compiling), every wire assertion below fails
 * on the credential reaching the server verbatim. The evidence judged is
 * the mint's own product — the policy's replacement marker and the masked
 * value — never ordering or call counts.
 */

const POLICY = createPrivacyPolicy();

/** A capture server speaking just enough SSE for the adapter to finish. */
async function withCaptureServer(
  run: (baseUrl: string, captured: { body: string; authorization: string }[]) => Promise<void>,
): Promise<void> {
  const captured: { body: string; authorization: string }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    req.on("end", () => {
      captured.push({ body, authorization: String(req.headers.authorization ?? "") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(responsesSse({ content: "ok" }));
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function providerAt(baseUrl: string, id: string): ProviderConfig {
  return buildProviderConfig({
    id,
    baseUrl,
    timeoutMs: 5000,
    retries: { maxRetries: 0, initialBackoffMs: 1, maxBackoffMs: 10, backoffMultiplier: 2 },
  });
}

test("engine door: the adapter's own API key is masked ON THE WIRE while the witness beside it survives", async () => {
  // Long enough for the identity registry, and shaped like nothing else in
  // the request so an accidental match cannot fake the result.
  const ownKey = "OWNKEY-a8f31x9q7Zt2mQv4";
  const providerId = "capture-own-key";
  await withCaptureServer(async (baseUrl, captured) => {
    const adapter = createProviderAdapter({
      provider: providerAt(baseUrl, providerId),
      apiKey: ownKey,
    });
    const result = await adapter.chatCompletion({
      model: "test-model",
      messages: [{
        role: "user",
        content: `deploy notes WITNESS-9f2c1a: the configured key is ${ownKey} and must not appear downstream`,
      }],
    });
    assert.equal(result.content, "ok", "the driven request must actually complete");
    assert.equal(captured.length, 1, "exactly one request must have reached the capture server");
    const wire = captured[0]!;
    // The witness FIRST: only a body that provably carries the rest of the
    // sentence can support an absence claim about the credential.
    assert.ok(wire.body.includes("WITNESS-9f2c1a"), "the witness beside the credential must survive redaction");
    assert.ok(!wire.body.includes(ownKey), "the adapter's own API key must not reach the wire in message content");
    assert.ok(
      wire.body.includes(POLICY.redactionPrefix),
      `the wire body must carry the redaction engine's own marker (${POLICY.redactionPrefix}…) — evidence only the real redaction path produces`,
    );
    // The AUTH HEADER is the one place the key belongs — a redactor that
    // masked it would break every request while looking safer.
    assert.equal(wire.authorization, `Bearer ${ownKey}`, "the Authorization header must still carry the real key");
  });
  forgetKnownSecret(`llm-provider-api-key:${providerId}`);
});

test("engine door: an 8-character declared secret is masked turn-wide, not accepted-then-leaked", async () => {
  // Below the 12-character identity-registry floor and above the 6-character
  // remembering floor — the exact band the two-floors defect leaked: the
  // declaration was accepted and counted, and the bare repetition went out
  // verbatim because the variant builder filtered at the wrong floor.
  const declared = "Zk4q7Pa8";
  const providerId = "capture-declared";
  await withCaptureServer(async (baseUrl, captured) => {
    const adapter = createProviderAdapter({
      provider: providerAt(baseUrl, providerId),
      apiKey: "adapter-key-for-declared-turn",
    });
    await adapter.chatCompletion({
      model: "test-model",
      messages: [
        { role: "user", content: `my password may be ${declared}` },
        { role: "assistant", content: `you told me ${declared} earlier, witness WITNESS-77e0c2` },
      ],
    });
    assert.equal(captured.length, 1);
    const wire = captured[0]!;
    assert.ok(wire.body.includes("WITNESS-77e0c2"), "the witness beside the repeated secret must survive");
    assert.ok(!wire.body.includes(declared), "a declared 8-char secret must be masked in EVERY message of the turn");
    assert.ok(wire.body.includes(POLICY.redactionPrefix), "the mask must be the engine's own marker");
  });
  forgetKnownSecret(`llm-provider-api-key:${providerId}`);
});

test("engine door: tool-call arguments are redacted like content", async () => {
  const ownKey = "OWNKEY-toolarg-b7Qk2m9Xw1pR";
  const providerId = "capture-tool-args";
  await withCaptureServer(async (baseUrl, captured) => {
    const adapter = createProviderAdapter({
      provider: providerAt(baseUrl, providerId),
      apiKey: ownKey,
    });
    await adapter.chatCompletion({
      model: "test-model",
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "notes-WITNESS-3d1b44.txt", text: `key=${ownKey}` }),
            },
          }],
        },
        { role: "tool", content: "written", tool_call_id: "call-1" },
      ],
    });
    assert.equal(captured.length, 1);
    const wire = captured[0]!;
    assert.ok(wire.body.includes("WITNESS-3d1b44"), "the witness inside the tool-call arguments must survive");
    assert.ok(!wire.body.includes(ownKey), "an own credential inside tool-call arguments must not reach the wire");
  });
  forgetKnownSecret(`llm-provider-api-key:${providerId}`);
});
