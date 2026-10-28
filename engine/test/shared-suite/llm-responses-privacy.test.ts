import assert from "node:assert/strict";
import { mintTestRequest } from "../support/mock-provider.ts";
import test from "node:test";
import { admitMintedRequest, observeMintedRequest, projectRequestForInputTokens, ForgedRedactedRequestError } from "../../src/privacy/redacted-messages.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { registerKnownSecret } from "../../src/privacy/secret-intelligence.ts";
import { mapStringValues } from "../../src/shared/string-values.ts";

const secret = "native-privacy-credential-000123";
registerKnownSecret(secret, "test-native-privacy");
test("Responses mint rejects hostile structures and cross-operation forgeries before transport", () => {
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const accessor = Object.defineProperty({}, "input", { get() { throw new Error("getter invoked"); }, enumerable: true });
  for (const body of [cyclic, accessor, { input: [undefined] }, { input: Infinity }]) assert.throws(() => mintTestRequest("create", body), error => error instanceof InputError && error.code === "responses_request_structure_invalid");
  const request = mintTestRequest("create", { input: "safe" });
  const forged = (error: unknown) => error instanceof ForgedRedactedRequestError && error.code === "redacted_request_not_minted";
  assert.throws(() => admitMintedRequest({ ...request }, "create"), forged);
  assert.throws(() => admitMintedRequest(Object.create(request), "create"), forged);
  assert.throws(() => admitMintedRequest(request, "compact" as "create"), forged);
  assert.strictEqual(admitMintedRequest(request, "create"), request.request);
  assert(Object.isFrozen(request)); assert(Object.isFrozen(request.request));
});

test("Only actual native semantic slots preserve opaque media and protocol credentials", () => {
  const request = mintTestRequest("create", {
    model: "test-model", instructions: `keep witness ${secret}`, metadata: { encrypted_content: secret },
    tools: [{ type: "mcp", server_label: "remote", server_url: "https://remote.test", authorization: secret }],
    input: [
      { type: "reasoning", id: "reasoning_1", encrypted_content: secret, summary: [] },
      { type: "message", role: "user", content: [
        { type: "reasoning", encrypted_content: secret },
        { type: "input_image", image_url: `https://media.test/a?token=${secret}&width=500` },
      ], payload: { type: "reasoning", encrypted_content: secret } },
    ],
  });
  const body = request.request as Record<string, any>;
  assert.equal(body.tools[0].authorization, secret); assert.equal(body.input[0].encrypted_content, secret);
  assert.ok(body.input[1].content[1].image_url.includes(secret));
  assert.ok(!body.instructions.includes(secret)); assert.ok(!body.metadata.encrypted_content.includes(secret));
  assert.ok(!body.input[1].content[0].encrypted_content.includes(secret)); assert.ok(!body.input[1].payload.encrypted_content.includes(secret));
  const observation = JSON.stringify(observeMintedRequest(request)); assert.ok(!observation.includes(secret)); assert.ok(!observation.includes("width=500"));
});

test("Function arguments preserve original bytes unless a decoded leaf needs redaction", () => {
  const original = '{ "numeric": 1e3, "text": "ordinary witness" }';
  const safe = mintTestRequest("create", { input: [{ type: "function_call", id: "fc", call_id: "call", name: "read", arguments: original }] });
  assert.equal((safe.request.input as any[])[0].arguments, original);
  const escaped = secret.split("").map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const masked = mintTestRequest("create", { input: [{ type: "function_call", id: "fc", call_id: "call", name: "read", arguments: `{"secret":"${escaped}","witness":"survives"}` }] });
  const text = (masked.request.input as any[])[0].arguments;
  assert.ok(!JSON.stringify(JSON.parse(text)).includes(secret)); assert.equal(JSON.parse(text).witness, "survives");
  assert.throws(() => mintTestRequest("create", { conversation: { id: secret }, input: "safe" }), { code: "responses_identity_sensitive" });
});

test("Count projection retains documented controls and original structural admission bounds", () => {
  let nested: unknown = "safe"; for (let i = 0; i < 50; i++) nested = { nested };
  const limits = { maximumDepth: 60, capturedResponseHeaders: ["x-request-id"] };
  const create = mintTestRequest("create", { model: "test", input: [{ type: "future_item", nested }], personality: "none", temperature: 0.5 }, { limits });
  limits.maximumDepth = 2; limits.capturedResponseHeaders.push("x-later");
  const count = projectRequestForInputTokens(create);
  assert.equal(count.request.personality, "none"); assert.equal(count.request.temperature, undefined);
  assert.deepEqual(count.request.input, create.request.input);
});

test("Shared string mapper preserves own __proto__ keys without mutating prototypes", () => {
  const input = JSON.parse('{"__proto__":{"text":"witness"},"other":"safe"}');
  const mapped = mapStringValues(input, text => text.toUpperCase()) as Record<string, unknown>;
  assert.ok(Object.hasOwn(mapped, "__proto__")); assert.deepEqual(mapped.__proto__, { text: "WITNESS" });
  assert.equal(Object.getPrototypeOf(mapped), Object.prototype);
});

test("Native object keys refuse sensitive identities instead of transmitting or renaming them", () => {
  for (const body of [{ metadata: { [secret]: "value" } }, { prompt: { id: "prompt_1", variables: { [secret]: "value" } } }]) {
    assert.throws(() => mintTestRequest("create", body), { code: "responses_identity_sensitive" });
  }
});

test("Native identity context preserves opaque IDs while retaining credential, declaration and PII evidence", async () => {
  const { createHash } = await import("node:crypto");
  const { detectSecretSpans, detectProtocolIdentitySensitiveSpans } = await import("../../src/privacy/redaction-engine.ts");
  const { assertResponseIdentity } = await import("../../src/privacy/responses-redaction.ts");
  const { forgetKnownSecret } = await import("../../src/privacy/secret-intelligence.ts");
  const hash = createHash("sha512").update("response identifier deterministic fixture").digest("hex");
  for (const prefix of ["resp_", "rs_", "call_"]) for (const length of [24, 48, 64, 68, 80, 96]) {
    const id = prefix + hash.slice(0, length);
    assert.doesNotThrow(() => assertResponseIdentity(id));
    const request = mintTestRequest("create", { previous_response_id: id, input: [{ type: "reasoning", id, summary: [] }] });
    assert.equal(request.request.previous_response_id, id);
    if (prefix !== "call_" && ![64, 96].includes(length)) assert.ok(detectSecretSpans(id).some(span => span.detectorId === "value-intrinsic"), "fixture must reproduce the text heuristic false positive");
    assert.equal(detectProtocolIdentitySensitiveSpans(id).length, 0);
  }
  const registered = "resp_" + hash.slice(0, 68);
  registerKnownSecret(registered, "native-id-test");
  try { assert.throws(() => assertResponseIdentity(registered), { code: "responses_identity_sensitive" }); }
  finally { forgetKnownSecret("native-id-test"); }
  for (const value of ["alice@example.com", ("sk" + "-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]) assert.throws(() => assertResponseIdentity(value), { code: "responses_identity_sensitive" });
  assert.throws(() => mintTestRequest("create", { input: "my password may be admin44xyz", previous_response_id: "admin44xyz" }), { code: "responses_identity_sensitive" });
  assert.throws(() => mintTestRequest("create", { metadata: { ["resp_" + hash.slice(0, 48)]: "witness" } }), { code: "responses_identity_sensitive" }, "arbitrary keys must not acquire protocol identity authority");
});

test("Native program identities and tool-result media use only documented replay slots", async () => {
  const { createHash } = await import("node:crypto");
  const caller = "prog_" + createHash("sha512").update("program identity fixture").digest("hex").slice(0, 48);
  const signedUrl = `https://media.test/screenshot?token=${secret}`;
  const minted = mintTestRequest("create", { input: [
    { type: "program", id: "program_item", call_id: caller, fingerprint: secret, code: "print(1)" },
    { type: "function_call", call_id: "call_replay", name: "read", arguments: "{}", caller: { type: "program", caller_id: caller } },
    { type: "function_call_output", call_id: "call_replay", caller: { type: "program", caller_id: caller }, output: [{ type: "input_image", image_url: signedUrl }, { type: "input_file", file_data: secret }] },
    { type: "custom_tool_call_output", call_id: "custom_replay", output: [{ type: "input_file", file_url: signedUrl }] },
    { type: "computer_call_output", call_id: "computer_replay", output: { type: "computer_screenshot", image_url: signedUrl } },
    { type: "program_output", call_id: caller, result: secret, fingerprint: secret, status: "completed" },
    { type: "future_item", output: [{ type: "input_image", image_url: signedUrl }], caller: { type: "program", caller_id: secret } },
  ] });
  const items = minted.request.input as any[];
  assert.equal(items[0].fingerprint, secret); assert.equal(items[1].caller.caller_id, caller);
  assert.equal(items[2].caller.caller_id, caller);
  assert.equal(items[2].output[0].image_url, signedUrl); assert.equal(items[2].output[1].file_data, secret);
  assert.equal(items[3].output[0].file_url, signedUrl); assert.equal(items[4].output.image_url, signedUrl);
  // The exact replacements: the undocumented slots are masked whole, and the
  // signed URL keeps its shape with only the credential masked.
  assert.equal(items[5].result, "[REDACTED:token]"); assert.equal(items[5].fingerprint, "[REDACTED:token]");
  assert.equal(items[6].output[0].image_url, "https://media.test/screenshot?token=[REDACTED:secret]");
  assert.equal(items[6].caller.caller_id, "[REDACTED:token]");
  assert.ok(!JSON.stringify(observeMintedRequest(minted)).includes(secret));
});

test("Program caller identity survives every documented call and result slot without extending to arbitrary objects", async () => {
  const { createHash } = await import("node:crypto");
  const { messagesToResponseInput } = await import("../../src/shared/llm/response-transcript.ts");
  const caller = { type: "program", caller_id: "prog_" + createHash("sha512").update("caller roundtrip fixture").digest("hex").slice(0, 48) };
  const input = messagesToResponseInput([
    { role: "assistant", content: "", responseItems: [{ type: "function_call", call_id: "call_original", name: "read", arguments: "{}", caller }] },
    { role: "tool", tool_call_id: "call_original", content: "" },
  ]);
  assert.deepEqual(mintTestRequest("create", { input }).request.input, input);
  const legalTypes = ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", "shell_call", "shell_call_output", "apply_patch_call", "apply_patch_call_output"];
  for (const type of legalTypes) {
    const item = { type, call_id: "call_replay", name: "read", arguments: "{}", output: "ok", caller };
    assert.deepEqual((mintTestRequest("create", { input: [item] }).request.input as any[])[0].caller, caller, type);
    assert.throws(() => mintTestRequest("create", { input: [{ ...item, caller: { ...caller, caller_id: secret } }] }), { code: "responses_identity_sensitive" }, type);
  }
  for (const type of ["future_item", "message", "computer_call_output", "mcp_call", "program_output"]) {
    const item = { type, caller };
    assert.notEqual((mintTestRequest("create", { input: [item] }).request.input as any[])[0].caller.caller_id, caller.caller_id, type);
  }
  const nested = mintTestRequest("create", { input: [{ type: "function_call_output", output: { type: "shell_call", caller } }] });
  assert.notEqual((nested.request.input as any[])[0].output.caller.caller_id, caller.caller_id);
});

test("Decoded function argument keys cannot reintroduce credentials when redacted values rebuild JSON", () => {
  for (const argumentsText of [
    JSON.stringify({ [secret]: secret, witness: "ok" }),
    JSON.stringify({ items: [{ [secret]: secret }] }).replaceAll(secret, secret.split("").map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")),
    JSON.stringify({ admin44xyz: secret }),
  ]) assert.throws(() => mintTestRequest("create", {
    instructions: "my password may be admin44xyz",
    input: [{ type: "function_call", call_id: "call_keys", name: "read", arguments: argumentsText }],
  }), { code: "responses_identity_sensitive" });
});

test("Media URL observations redact path credentials while native transmission preserves the exact URL", () => {
  const declared = "admin44xyz";
  for (const value of [secret, declared]) for (const path of [value, value.split("").map(char => `%${char.charCodeAt(0).toString(16)}`).join("")]) {
    const imageUrl = `https://media.test/${path}/image.png?access=${value}#fragment`;
    const minted = mintTestRequest("create", {
      instructions: `my password may be ${declared}`,
      input: [{ role: "user", content: [{ type: "input_image", image_url: imageUrl }] }],
    });
    assert.equal((minted.request.input as any[])[0].content[0].image_url, imageUrl);
    for (const observation of [observeMintedRequest(minted), observeMintedRequest(projectRequestForInputTokens(minted))]) {
      const text = decodeURIComponent(JSON.stringify(observation));
      assert.ok(!text.includes(value), "media reference observation must not disclose known or turn-declared path secrets");
      assert.ok(text.includes("media.test"));
    }
  }
  const contextual = mintTestRequest("create", { instructions: `my password may be ${declared}`,
    input: [{ role: "user", content: [{ type: "input_image", image_url: `https://${declared}.media.test/image.png` }] }] });
  assert.ok(!JSON.stringify(observeMintedRequest(contextual)).includes(declared), "origin must retain the original turn's declarations");
});

test("Native credentials provide local copy and identity protection below the global registration floor", () => {
  for (const credential of ["admin44xyz", "abcd"]) {
    const tools = [{ type: "mcp", server_label: "remote", server_url: "https://remote.test", authorization: credential }];
    const request = mintTestRequest("create", { tools, input: [
      { type: "message", role: "user", content: credential },
      { type: "function_call", name: "read", call_id: "call", arguments: JSON.stringify({ value: credential }) },
    ] });
    const body = request.request as any;
    assert.equal(body.tools[0].authorization, credential);
    assert.notEqual(body.input[0].content, credential); assert.notEqual(JSON.parse(body.input[1].arguments).value, credential);
    for (const extra of [{ model: credential }, { metadata: { [credential]: "value" } }]) {
      assert.throws(() => mintTestRequest("create", { tools, ...extra }), { code: "responses_identity_sensitive" });
    }
  }
  const credential = "media77xyz";
  const url = `https://media.test/image?token=${credential}`;
  const request = mintTestRequest("create", { instructions: `copied ${credential}`, input: [{ role: "user", content: [{ type: "input_image", image_url: url }] }] });
  assert.ok(!request.request.instructions!.includes(credential));
  assert.equal((request.request.input as any[])[0].content[0].image_url, url);
});

test("Rejected credential-bearing native keys never become public registration labels", async () => {
  const { knownSecretLabels } = await import("../../src/privacy/secret-intelligence.ts");
  assert.throws(() => mintTestRequest("create", {
    tools: [{ type: "mcp", server_label: "remote", headers: { [secret]: "different-fixture-credential" } }],
  }), { code: "responses_identity_sensitive" });
  // The witness: this is the live registry, holding this file's own label.
  assert.ok(knownSecretLabels().includes("test-native-privacy"));
  assert.ok(!JSON.stringify(knownSecretLabels()).includes(secret));
});

test("Hosted container domain credentials are exact only in admitted native slots", async () => {
  const { privacyCounters } = await import("../../src/privacy/pii-registry.ts");
  for (const type of ["code_interpreter", "shell"] as const) {
    const name = type === "shell" ? "environment" : "container";
    // `a7b8c9` is at the held floor (privacy.heldCredentialMinimumLength, 6):
    // matched wherever it appears. `a7` is below it: replaced in its own
    // slot only, never matched in text (a2-correctness §2: a one-letter
    // held value masked every "a" and refused the request).
    for (const [value, masked] of [["a7b8c9", true], ["a7", false]] as const) {
      const config = { type: type === "shell" ? "container_auto" : "auto", network_policy: { type: "allowlist", allowed_domains: ["fixture.test"], domain_secrets: [{ domain: "fixture.test", name: "fixture", value }] } };
      const original = { type, [name]: config, extension: { [name]: config } };
      const before = privacyCounters.heldSlotOnly;
      const minted = mintTestRequest("create", { input: `prefix ${value} suffix`, tools: [original] });
      const body = admitMintedRequest(minted, "create") as Record<string, any>;
      assert.equal(body.tools[0][name].network_policy.domain_secrets[0].value, value);
      assert.equal(body.input, masked ? "prefix [REDACTED:secret] suffix" : `prefix ${value} suffix`);
      assert.equal(privacyCounters.heldSlotOnly - before, masked ? 0 : 1, "a held value below the floor is counted, never silent");
      assert.notEqual(body.tools[0].extension[name].network_policy.domain_secrets[0].value, value, "an unadmitted slot is replaced exactly");
      const observed = observeMintedRequest(minted) as Record<string, any>;
      assert.notEqual(observed.tools[0][name].network_policy.domain_secrets[0].value, value, "the observation never shows the credential slot");
      if (masked) assert.equal(JSON.stringify(observed).includes(value), false);
    }
  }
});

test("URL credentials register both spellings, including a password that is not valid percent-encoding", async () => {
  const { redactResponsesBody } = await import("../../src/privacy/responses-redaction.ts");
  const { DEFAULT_PRIVACY_POLICY } = await import("../../src/privacy/privacy-policy.ts");
  const held = (imageUrl: string) => redactResponsesBody({ input: [{ role: "user", content: [{ type: "input_image", image_url: imageUrl }] }] },
    DEFAULT_PRIVACY_POLICY, {}, { maximumDepth: 48, maximumNodes: 50_000 }).heldCredentials.matched();
  assert.ok(held("https://user:%ZZsecretpw@media.test/a.png").includes("%ZZsecretpw"), "a malformed-encoding password is still a held secret");
  const encoded = held("https://user:p%40sswordzz@media.test/a.png");
  assert.ok(encoded.includes("p%40sswordzz") && encoded.includes("p@sswordzz"), "raw and decoded spellings are both held");
  assert.deepEqual([...held("data:image/png;base64,aGVsbG8=")], []);
  assert.deepEqual([...held("not a url at all")], []);
  assert.deepEqual([...held("https://user:pw@media.test/a.png?width=500#top")], [], "a username beside a password, a plain query value and a fragment word are not credentials (and `pw` is below the floor)");
});

// verify/a2-correctness.md §2: every spelling a text can carry a URL's
// credential in — the TEXT's raw bytes, not the WHATWG parser's normalised
// form — must be masked when a message echoes it: raw `@`/`{`/space/unicode
// beside an invalid escape, a double encoding, a tab the parser strips, a
// query `+`, a username-only token, and URLs no parser accepts.
test("URL credentials are masked in every spelling a text carries them, parseable or not", () => {
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    ["plain", "https://user:plainsecretpw@h.test/a.png", ["plainsecretpw"]],
    ["invalid %ZZ", "https://user:%ZZsecretpw@h.test/a.png", ["%ZZsecretpw"]],
    ["encoded @", "https://user:p%40sswordzz@h.test/a.png", ["p%40sswordzz", "p@sswordzz"]],
    ["lowercase hex %2f", "https://user:ab%2fcdsecret@h.test/a.png", ["ab%2fcdsecret", "ab/cdsecret"]],
    ["double-encoded %2540", "https://user:x%2540ysecret@h.test/a.png", ["x%2540ysecret", "x%40ysecret", "x@ysecret"]],
    ["raw @ in pw", "https://user:p@ssw0rdraw@h.test/a.png", ["p@ssw0rdraw"]],
    ["raw @ + %ZZ", "https://user:p@ss%ZZword@h.test/a.png", ["p@ss%ZZword"]],
    ["raw space", "https://user:pa ss word@h.test/a.png", ["pa ss word"]],
    ["raw brace + %ZZ", "https://user:pa{ss}%ZZw@h.test/a.png", ["pa{ss}%ZZw"]],
    ["unicode raw", "https://user:pässwörd123@h.test/a.png", ["pässwörd123"]],
    ["unicode raw + %ZZ", "https://user:pässwörd%ZZ@h.test/a.png", ["pässwörd%ZZ"]],
    ["unicode percent", "https://user:p%C3%A4ss1234@h.test/a.png", ["p%C3%A4ss1234", "päss1234"]],
    ["mixed valid + invalid %", "https://user:a%40b%ZZsecret@h.test/a.png", ["a%40b%ZZsecret", "a@b%ZZsecret"]],
    ["lone surrogate", "https://user:x%ED%A0%80secret@h.test/a.png", ["x%ED%A0%80secret"]],
    ["ipv6 host", "https://user:ipv6secretpw@[::1]:8443/a.png", ["ipv6secretpw"]],
    ["ipv6 zone (no parser accepts it)", "https://user:zonesecretpw@[fe80::1%25eth0]/a.png", ["zonesecretpw"]],
    ["colon in pw", "https://user:pa:ss:wordzz@h.test/a.png", ["pa:ss:wordzz"]],
    ["tab (the parser strips it)", "https://user:sec\tretpwzz@h.test/a.png", ["sec\tretpwzz", "secretpwzz"]],
    ["no user", "https://:nouserpwzz@h.test/a.png", ["nouserpwzz"]],
    ["username-only token", "https://xusernamesecretzz@h.test/a.png", ["xusernamesecretzz"]],
    ["query token raw +", "https://h.test/a.png?token=abc+defsecret", ["abc+defsecret", "abc defsecret"]],
    ["query token %2B", "https://h.test/a.png?token=abc%2Bdefsecret", ["abc%2Bdefsecret", "abc+defsecret"]],
    ["query token %ZZ", "https://h.test/a.png?token=abc%ZZdefsecret", ["abc%ZZdefsecret"]],
    ["fragment token", "https://h.test/cb#access_token=fragsecret99", ["fragsecret99"]],
    ["space in host (no parser accepts it)", "https://user:badhostsecret@exa mple.test/a.png", ["badhostsecret"]],
    ["file url", "file://user:filesecretpw@h.test/a.png", ["filesecretpw"]],
    ["non-special scheme", "foo://user:foosecretpw@h.test/a.png", ["foosecretpw"]],
    // What a URL PARSER still reads as a URL (a2b-correctness M-1: held before A2b, leaked after it).
    ["leading space", " https://user:leadspacepw@h.test/a.png", ["leadspacepw"]],
    ["tab in the scheme", "ht\ttps://user:schemetabpw@h.test/a.png", ["schemetabpw"]],
    ["backslashes", "https:\\\\user:backslashpw@h.test/a.png", ["backslashpw"]],
    ["no slashes", "https:user:noslashespw@h.test/a.png", ["noslashespw"]],
    ["one slash", "https:/user:oneslashpw@h.test/a.png", ["oneslashpw"]],
    // A token as the username beside an empty or placeholder password (a2b-correctness M-2). The
    // tokens below are secret-SHAPED yet invisible to the text detectors, so only the holding masks them.
    ["token, empty password", "https://ABCDEFGH12345678:@h.test/a.png", ["ABCDEFGH12345678"]],
    ["token, placeholder password", "https://abcdefgh12345678:x-oauth-basic@github.com/a.png", ["abcdefgh12345678"]],
    // What the concealment treats as a credential, the mint holds (a2b-design M5).
    ["webhook path token", "https://hooks.example.com/services/T01ABCD/B02EFGH/Ab1Ab1Ab1Ab1Ab1Ab1", ["Ab1Ab1Ab1Ab1Ab1Ab1"]],
    ["signature under a plain name", "https://cdn.example.com/img.png?s=Qwertyuiopasdfgh", ["Qwertyuiopasdfgh"]],
    ["bare fragment token", "https://cdn.example.com/img.png#tokenvalue123456", ["tokenvalue123456"]],
  ];
  for (const [label, url, spellings] of cases) {
    const minted = mintTestRequest("create", { input: [{ role: "user", content: [
      { type: "input_image", image_url: url },
      ...spellings.map((spelling) => ({ type: "input_text", text: `echo:[${spelling}]` })),
    ] }] });
    const content = (minted.request.input as any[])[0].content as any[];
    assert.equal(content[0].image_url, url, `${label}: the URL itself is sent exactly`);
    spellings.forEach((spelling, index) => {
      assert.ok(!content[index + 1].text.includes(spelling), `${label}: the spelling ${JSON.stringify(spelling)} leaked: ${content[index + 1].text}`);
    });
    assert.ok(!JSON.stringify(observeMintedRequest(minted)).includes(spellings[0]!), `${label}: the observation shows only the origin`);
  }
});

test("URL credential spellings stay linear in the URL: a nested encoding is decoded a bounded number of times (a2b-correctness H-1)", async () => {
  const { urlCredentialSpellings } = await import("../../src/privacy/secret-parts.ts");
  const { DEFAULT_PRIVACY_POLICY } = await import("../../src/privacy/privacy-policy.ts");
  const levels = DEFAULT_PRIVACY_POLICY.urlDecodeLevels;
  assert.equal(levels, 2, "the default covers a double-encoded value");
  const nested = `https://u:%${"25".repeat(16_000)}41@h.test/a.png`;
  const held = urlCredentialSpellings(nested, levels);
  assert.ok(held.length <= levels + 1, `at most one spelling per decode level (${held.length})`);
  assert.ok(held.reduce((bytes, spelling) => bytes + spelling.length, 0) <= (levels + 1) * nested.length, "held bytes stay a small multiple of the URL");
  // The request is minted (a fixed-point decode held every level and the mint refused it as too large, after stalling).
  const minted = mintTestRequest("create", { input: [{ role: "user", content: [{ type: "input_image", image_url: nested }, { type: "input_text", text: "a picture" }] }] });
  assert.equal(((minted.request.input as any[])[0].content as any[])[0].image_url, nested);
  // Double encoding is still covered at the default bound.
  assert.ok(urlCredentialSpellings("https://user:x%2540ysecret@h.test/a.png", levels).includes("x@ysecret"));
});

test("The held floor lives in the held-set owner: every producer's short value is replaced in its own slot only, never matched in text (a2b-design H1)", async () => {
  const { providerHeldSet } = await import("../../src/shared/llm/provider-observation.ts");
  const { heldValues } = await import("../../src/privacy/held-set.ts");
  const { createPrivacyPolicy } = await import("../../src/privacy/privacy-policy.ts");
  const { privacyCounters } = await import("../../src/privacy/pii-registry.ts");
  const text = "a cab in a lab";
  const before = privacyCounters.heldSlotOnly;
  const provider = providerHeldSet({ id: "p", apiKey: "provider-api-key-long-enough-000", headers: { "x-api-key": "ab" } });
  assert.equal(privacyCounters.heldSlotOnly - before, 1, "the provider's short value is counted where the set is built");
  const parent = heldValues("parent:credential", ["ab"]);
  for (const [label, held] of [["provider-held", provider], ["parent-held", parent]] as const) {
    assert.equal(held.scrub(text, "[X]"), text, `${label}: the set itself never matches a short value`);
    const minted = mintTestRequest("create", { input: [{ role: "user", content: [{ type: "input_text", text }] }] }, { detection: { heldCredentials: held } });
    assert.equal(((minted.request.input as any[])[0].content as any[])[0].text, text, `${label}: ordinary words survive the mint`);
  }
  // A long value is matched by every producer, merged or not.
  const long = heldValues("parent:credential", ["parent-held-credential-9f8e7d"]);
  assert.equal(long.merge(provider).scrub("x parent-held-credential-9f8e7d y", "[X]"), "x [X] y");
  // The ceiling is the policy's own, not only the schema's: raising the floor past the registry's is refused.
  assert.throws(() => createPrivacyPolicy({ heldCredentialMinimumLength: 13 }), /heldCredentialMinimumLength must be a safe integer <= 12/u);
  assert.throws(() => createPrivacyPolicy({ urlDecodeLevels: 9 }), /urlDecodeLevels must be a safe integer <= 8/u);
});

test("A held credential shorter than the floor is sent exactly but neither shreds the turn nor refuses the request", () => {
  for (const url of ["https://user:a@h.test/a.png", "https://user:%61@h.test/a.png", "https://user:@h.test/a.png", "https://user:the@h.test/a.png"]) {
    const minted = mintTestRequest("create", { input: [{ role: "user", content: [
      { type: "input_image", image_url: url },
      { type: "input_text", text: "a cat and the dog" },
    ] }] });
    const content = (minted.request.input as any[])[0].content as any[];
    assert.equal(content[0].image_url, url, url);
    assert.equal(content[1].text, "a cat and the dog", `${url}: a short held value must not mask ordinary words`);
  }
});

test("data classification reads a malformed percent-encoded key raw without a best-effort failure", async () => {
  const { classifyData } = await import("../../src/privacy/data-policy.ts");
  const { DATA_CLASSIFICATION } = await import("../../src/privacy/classification-catalog.ts");
  const { getDebugSignals, resetDebugSystem } = await import("../../src/shared/debug/debug-system.ts");
  resetDebugSystem();
  try {
    const decision = classifyData({ "%ZZtoken": "value" }, DATA_CLASSIFICATION.public);
    assert.equal(decision.classification, DATA_CLASSIFICATION.credentialSecret);
    assert.equal(getDebugSignals().bestEffortFailures, 0, "an undecodable key is a normal outcome, not a failure");
  } finally { resetDebugSystem(); }
});
