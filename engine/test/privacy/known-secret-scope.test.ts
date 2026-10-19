/**
 * THE PROCESS-WIDE KNOWN-SECRET REGISTRY HOLDS THE HARNESS'S OWN SECRETS ONLY
 * (cred-audit CRED-F2/F3, reproduced by its probe `cred-notes/probe-registry.mts`).
 *
 * A value from one user's request — a URL password, a hosted-tool credential
 * slot — used to be registered process-wide: it masked every OTHER user's
 * text for the life of the process, and 64 of them filled the registry so a
 * new own-credential was silently not learned. Request values are now held
 * for their own call only (the minted request's held list), and the minted
 * request still masks them.
 */
import { mintTestRequest } from "../support/mock-provider.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { admitMintedRequest } from "../../src/privacy/redacted-messages.ts";
import { clearKnownSecrets, forgetKnownSecret, knownSecretCount, registerKnownSecret } from "../../src/privacy/secret-intelligence.ts";
import { redactForLLMContext } from "../../src/privacy/redaction-engine.ts";

const request = (url: string, text: string) => ({ model: "m", input: [{ role: "user", content: [
  { type: "input_image", image_url: url }, { type: "input_text", text },
] }] });

test("known-secret scope: a request's URL password is held for that call, never registered process-wide", () => {
  clearKnownSecrets();
  const password = "userAlicePassw0rd99";
  const minted = mintTestRequest("create", request(`https://alice:${password}@img.example/a.png`, `my pw is ${password}`));
  assert.equal(knownSecretCount(), 0, "the registry is unchanged by request data");
  const text = JSON.stringify(admitMintedRequest(minted, "create").input);
  assert.ok(!text.includes(`my pw is ${password}`), "the call itself still masks its own held value");
  assert.ok(redactForLLMContext(`bob text mentions ${password}`).includes(password), "another user's unrelated text is not shaped by it");
});

test("known-secret scope: seventy requests' credentials do not stop the harness learning its own key", () => {
  clearKnownSecrets();
  for (let i = 0; i < 70; i += 1) mintTestRequest("create", request(`https://u:pw${i}xxxxxxxxxxxxxxxx@h.example/a.png`, "x"));
  assert.equal(knownSecretCount(), 0);
  const outcome = registerKnownSecret("sk-live-NEWPROVIDERKEY-abcdefghijk", "llm-provider-api-key");
  assert.equal(outcome.registered, true, JSON.stringify(outcome));
  assert.equal(redactForLLMContext("key=zzz sk-live-NEWPROVIDERKEY-abcdefghijk"), "key=zzz [REDACTED:token]");
  forgetKnownSecret("llm-provider-api-key");
});

test("known-secret floor (CRED-F8): no switch turns off masking of the harness's own credentials; other tiers stay switchable", async () => {
  const { setPrivacyTierEnabled, setPrivacyTypeEnabled, privacyTierEnabled, privacyTypeEnabled } = await import("../../src/privacy/pii-registry.ts");
  const { registerPrivacyExposure } = await import("../../src/shared/exposure/registrations/privacy.ts");
  const { executeAction } = await import("../../src/shared/exposure/action.ts");
  const { setCustomizationValue } = await import("../../src/shared/exposure/customization.ts");
  const refused = (error: unknown) => (error as { code?: string }).code === "privacy_floor_refused";
  clearKnownSecrets();
  const own = "hk-own-credential-4f2d9a8c7b6e5d";
  registerKnownSecret(own);
  try {
    assert.throws(() => setPrivacyTierEnabled("known-values", false), refused);
    assert.throws(() => setPrivacyTypeEnabled("known-secret", false), refused);
    registerPrivacyExposure();
    // No switch is OFFERED for the floor (a control that can only refuse is inert) …
    assert.throws(() => setCustomizationValue("privacy.knownValues", false), (error: unknown) => /not registered/u.test(String((error as Error).message)), "no admin toggle");
    assert.throws(() => setCustomizationValue("privacy.hide.knownSecret", false), (error: unknown) => /not registered/u.test(String((error as Error).message)), "no type toggle");
    // … and the signal and the report still reach the owner, which refuses.
    await assert.rejects(executeAction("privacy.setTier", { tier: "known-values", enabled: false }), refused, "the setTier action");
    await assert.rejects(executeAction("privacy.reportWrongRedaction", { type: "known-secret" }), refused, "a wrong-redaction report");
    assert.equal(privacyTierEnabled("known-values"), true);
    assert.equal(privacyTypeEnabled("known-secret"), true);
    assert.ok(!redactForLLMContext(`key ${own}`).includes(own), "still masked after every attempt");
    // The floor is exactly that: a trade-off tier remains the operator's to switch.
    assert.equal(setPrivacyTierEnabled("value-intrinsic", false), false);
    setPrivacyTierEnabled("value-intrinsic", true);
  } finally {
    forgetKnownSecret(own);
  }
});
