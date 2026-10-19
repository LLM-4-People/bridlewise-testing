import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { classifyData, decideEgress } from "../../src/privacy/data-policy.ts";
import { createPreflightContext } from "../../src/kernel/preflight.ts";
import { removeOwnedTemporaryDirectories } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B05-CONTROL": () => {
    const publicDecision = classifyData({ documentation: "public example" }, "public");
    assert.equal(publicDecision.classification, "public");
    assert.equal(decideEgress("https://invalid.example", publicDecision).decision, "deny");
    const classified = classifyData({ source: "private source" }, "project-private");
    const denied = decideEgress("https://valid-but-disallowed.example", classified);
    assert.equal(denied.classification, "project-private");
    assert.equal(denied.code, "egress_disabled_by_root_policy");
    // KEY-NAME OWNERSHIP (U-42), part of the CONTROL scenario because the S1
    // spec's closed world is exactly three scenario kinds per behavior — a
    // fourth scenario id is unrepresentable in the trace schema, deliberately.
    // The inert canary matches no content pattern; its inertness is proven
    // in the same run (§36): under a neutral key it contributes NO signal,
    // so every refusal below is attributable to the KEY, not the value.
    const inert = "XQ4WV7ZMJ9RT2BKH";
    const control = classifyData({ harmless_note: inert }, "public");
    assert.equal(control.classification, "public");
    assert.deepEqual([...control.signalCategories], []);
    // The classifier consults the declared owner's WHOLE key question —
    // normalized parts AND the separator-bounded patterns — so SK_-keyed
    // data can no longer egress as public (U-42), in any casing.
    for (const key of ["SK_TEST", "sk_test", "Sk-Test", "MY_SK_KEY", "AUTH_HEADER"]) {
      const decision = classifyData({ [key]: inert }, "public");
      assert.equal(decision.classification, "credential-secret", key);
      assert.ok(decision.signalCategories.includes("sensitive-key"), key);
    }
    // A percent-encoded spelling is decoded BEFORE the owner is asked: the
    // raw text `sk%5Ftest` matches no pattern, the decoded `sk_test` does.
    const encoded = classifyData({ "sk%5Ftest": inert }, "public");
    assert.equal(encoded.classification, "credential-secret");
    assert.ok(encoded.signalCategories.includes("sensitive-key"));
    // Separator-decided negatives: the old hand-folded bigram REDACTED these;
    // the owner's pattern structurally cannot match them, and the part half
    // stays silent too. Witnessed by the positives above in the same subject.
    for (const key of ["disk_usage", "task-id", "risk_level"]) {
      const decision = classifyData({ [key]: inert }, "public");
      assert.equal(decision.classification, "public", key);
      assert.ok(!decision.signalCategories.includes("sensitive-key"), key);
    }
  },
  "S1-B05-FAILURE": () => {
    const canary = "S1_SYNTHETIC_CANARY_7a91";
    const encoded = Buffer.from(`authorization=Bearer ${canary}`, "utf8").toString("base64");
    const classified = classifyData({ nested: { chunks: ["Bearer ", canary], encoded } }, "public");
    assert.equal(classified.classification, "credential-secret");
    assert.ok(classified.signalCategories.includes("secret-value-shape"));
    assert.doesNotMatch(JSON.stringify(classified), new RegExp(canary));
  },
  "S1-B05-HOSTILE-REAL": async () => {
    let connections = 0;
    const server = createServer((_request, response) => {
      connections += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const context = createPreflightContext();
      const classified = context.classify({ classified: "payload" }, "project-private");
      assert.equal(context.decideEgress(`http://127.0.0.1:${address.port}`, classified).decision, "deny");
      // decideEgress is a pure decision function: it must not initiate any
      // network I/O. Verify synchronously (no time for an in-flight request
      // to arrive) and then again after server.close drains any in-flight
      // connections — close's callback fires only after all connections have
      // ended, so any request decideEgress initiated would be counted by then.
      assert.equal(connections, 0);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      assert.equal(connections, 0);
    } finally {
      // Best-effort cleanup if an assertion failed before the close above.
      // The second close fires its callback with ERR_SERVER_NOT_RUNNING,
      // which we swallow so cleanup never masks the real test failure.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
