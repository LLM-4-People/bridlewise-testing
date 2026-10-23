// @vitest-environment node
/** Web builds private native input; the real client prepares and mints the dispatched body.
 * Behavioral checks inspect fetch bytes. Separate web display helpers retain their own tests.
 */
import { describe, test, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "../helpers/temp-dir.ts";
import * as fileRead from "../../server/filesystem/file-read.ts";
import { SharedLLMClient } from "../../engine/src/shared/llm/client.ts";
import { responseJsonResponse, responseSseResponse } from "../../engine/test/support/mock-provider.ts";
import { address, serve } from "../../engine/test/support/loopback-upstream.ts";
import { getPrivacyPolicy, refreshSettingsSnapshot } from "../../server/kernel/harness-config.ts";
import { buildNativeRequest, type StreamChatOptions } from "../../server/llm/llm-bridge.ts";
import { parseProviderStore, resolveProviderCredential } from "../../server/llm/providers.ts";
import {
  redactToolCallArguments,
  toolCallArgumentsMemoStats,
  redactStringValues,
  redactForUserDisplay,
  redactMessage,
  redactTurnTogether,
  isHiddenFromUserDisplay,
} from "../../server/llm/redaction.ts";
import { getToolCallArgumentsCacheEntries } from "../../server/kernel/harness-config.ts";
// The config file's cross-process write lock: the memo arm's occupancy
// window below is config-SENSITIVE (the memo empties when the resolved
// policy object changes, and a parallel fork's config write rebuilds it),
// so the window holds the lock against every writer for its duration.
import { withConfigWriteLock } from "../../engine/src/kernel/config-write-lock.ts";
import { serverConfig, resetServerConfig } from "../../server/kernel/config.ts";
import {
  registerKnownSecret,
  forgetKnownSecret,
} from "../../engine/src/privacy/secret-intelligence.ts";
// `../../../` and not `../../`: from `tests/prevention/` the shorter path
// resolves to `<web-repo>/harness-main-v1/…`, which does not exist. It was
// an `import type`, so it ERASED and the suite stayed green for as long as
// it has been wrong — `tsc --noEmit -p tsconfig.tests.json` reported it as
// TS2307 the whole time. Of 136 relative cross-repository pairs in this
// tree, exactly one resolved to nothing, and this was it.
import type { ChatMessage } from "../../engine/src/shared/llm/config.ts";
import { read } from "../helpers/source-scan.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
import { PROVIDER_FIXTURE_OWNER } from "../helpers/multi-user.ts";
// A realistic long secret (redacted-value-substituted to a test fixture —
// never a real key). Uses the `sk-` hyphen format (OpenAI / NeuralWatt
// style) that the credential-assignment signal catches.
const SK_SECRET = ("sk" + "-AAAAAAAAAAAAAAAAAAAAAAAA");

// buildNativeRequest demands the branded credential at the door (a call that
// cannot name its provider is a compile error by design). The builder never
// contacts the provider — the credential rides the options only — so one
// fixture minted through the real path serves every call here.
const CREDENTIAL = resolveProviderCredential(
  parseProviderStore({
    providers: [{ id: "p", baseUrl: "https://provider.invalid/v1", apiKey: "sk-redaction-fixture", models: [{ id: "m" }] }],
    defaultProvider: "p",
    defaultModel: "m",
  }),
  "m", PROVIDER_FIXTURE_OWNER
);

async function providerInput(prompt: string, options: StreamChatOptions): Promise<readonly Record<string, any>[]> {
  const {request, context} = buildNativeRequest(prompt, options);
  let input: readonly Record<string, any>[] = [];
  serve(async (_url, init) => { input = JSON.parse(String(init.body)).input; return responseJsonResponse({content:"done"}); });
  const client = new SharedLLMClient({baseUrl:address(options.credential.baseUrl), allowPrivateAddress:true, apiKey:options.credential.apiKey(), model:options.credential.modelId});
  await client.create(request, {privacy:{policy:getPrivacyPolicy(), ...(context === undefined ? {} : {context})}});
  return input;
}

describe("PII redaction owner — native provider wire", () => {
  test("system, history and prompt are redacted at the actual client dispatch", async () => {
    const history: ChatMessage[] = [
      {role:"user",content: `history api_key = "${SK_SECRET}"`},
      {role:"assistant",content:"ordinary answer",tool_calls:[{id:"call_1",type:"function",function:{name:"read_file",arguments:"{}"}}]},
      {role:"tool",tool_call_id:"call_1",content: `const API_KEY = "${SK_SECRET}";`},
    ];
    Object.assign(history[1]!, {internalNote: SK_SECRET});
    const before = JSON.stringify(history);
    const input = await providerInput(`prompt api_key = "${SK_SECRET}"`, {credential:CREDENTIAL,systemPrompt:`system api_key = "${SK_SECRET}"`,conversationHistory:history});
    for (const role of ["system","user"]) { const rows=input.filter(item=>item.role===role); expect(rows.length).toBeGreaterThan(0); for(const row of rows) {expect(row.content).toContain("[REDACTED:");expect(row.content).not.toContain(SK_SECRET);} }
    const tool=input.find(item=>item.type==="function_call_output")!;
    expect(tool.call_id).toBe("call_1"); expect(tool.output).toContain("API_KEY"); expect(tool.output).toContain("[REDACTED:");
    expect(JSON.stringify(input)).not.toContain(SK_SECRET); expect(JSON.stringify(input)).not.toContain("internalNote"); expect(JSON.stringify(history)).toBe(before);
  });
  test("decoded arguments share turn declarations without contaminating another invocation", async () => {
    const token="admin44", witness="orchard canoe";
    const call: ChatMessage={role:"assistant",content:"",tool_calls:[{id:"call_context",type:"function",function:{name:"edit",arguments:JSON.stringify({content:`${witness} ${token}`,count:2})}}]};
    const history: ChatMessage[]=[{role:"user",content:`my password may be ${token}`},call];
    for(const conversationHistory of [history,[...history].reverse()]) {
      const input=await providerInput("",{credential:CREDENTIAL,conversationHistory});const native=input.find(item=>item.type==="function_call")!;
      expect(native.call_id).toBe("call_context");expect(native.name).toBe("edit");
      expect(JSON.parse(native.arguments)).toEqual({content:`${witness} [REDACTED:secret]`,count:2});
    }
    const other=await providerInput("",{credential:CREDENTIAL,conversationHistory:[call]});
    expect(JSON.parse(other.find(item=>item.type==="function_call")!.arguments)).toEqual({content:`${witness} ${token}`,count:2});
  });
  test("empty prompt is omitted and harmless native content remains exact", async () => {
    expect(await providerInput("",{credential:CREDENTIAL})).toEqual([]);
    expect(await providerInput("Explain this project.",{credential:CREDENTIAL,systemPrompt:"You are a helpful assistant.",conversationHistory:[{role:"user",content:"What does this function do?"}]})).toEqual([
      {type:"message",role:"system",content:"You are a helpful assistant."},{type:"message",role:"user",content:"What does this function do?"},{type:"message",role:"user",content:"Explain this project."},
    ]);
  });
});

describe("PII request ownership wiring", () => {
  test("web assembles private native input and the client alone mints actual attempts", () => {
    const bridge=read(modulePath("llm-bridge.ts"));
    expect(bridge).toMatch(/buildNativeRequest\(prompt,\s*options\)/);
    expect(bridge).toMatch(/client\.stream\(request,\s*transportOptions\)/);
    expect(bridge).not.toContain("redactAndMintRequest");
    const client=read(modulePathMatching("llm/client.ts"));
    const preparation=read(modulePath("responses-preparation.ts"));
    expect(client).toMatch(/prepareResponseRequest\(/);expect(preparation).toMatch(/redactAndMintRequest\(/);
    expect(bridge).toContain("JSON.stringify(event.request)");
  });
});

describe("PII redaction owner — single owner (No Scattered Helpers)", () => {
  // The redaction helpers must be defined in exactly ONE module
  // (server/redaction.ts) and imported elsewhere — never redefined.
  const redactionOwner = read(modulePathMatching("server/llm/redaction.ts"));
  const contextBridge = read(modulePath("context-bridge.ts"));
  const llmBridge = read(modulePath("llm-bridge.ts"));

  test("server/redaction.ts is the single owner of the redaction helpers", () => {
    expect(redactionOwner).toMatch(/export\s+function\s+redactContent\b/);
    expect(redactionOwner).toMatch(/export\s+function\s+redactToolCallArguments\b/);
    expect(redactionOwner).toMatch(/export\s+function\s+redactStringValues\b/);
    expect(redactionOwner).toMatch(/export\s+function\s+redactMessage\b/);
  });

  test("server/redaction.ts reuses the canonical redactForLLMContext (no second detector)", () => {
    expect(redactionOwner).toContain("redactForLLMContext");
    expect(redactionOwner).toContain("privacy/redaction-engine.ts");
  });

  test("context-bridge.ts IMPORTS the helpers (does not redefine them)", () => {
    expect(contextBridge).toMatch(/import\s*\{[^}]*redactContent[^}]*\}\s*from\s*"\.\.\/llm\/redaction\.ts"/);
    expect(contextBridge).not.toMatch(/function\s+redactContent\s*\(/);
    expect(contextBridge).not.toMatch(/function\s+redactToolCallArguments\s*\(/);
    expect(contextBridge).not.toMatch(/function\s+redactStringValues\s*\(/);
  });

  test("llm-bridge.ts IMPORTS the helpers (does not redefine them)", () => {
    // The bridge imports its redaction from the owner and defines none of it.
    // It uses `redactTurnTogether` (the turn-wide pass) rather than
    // `redactContent` (the per-string one) — the import assertion follows the
    // helper the bridge actually calls, so it keeps testing a real edge.
    expect(llmBridge).toMatch(/import\s*\{[^}]*redactTurnTogether[^}]*\}\s*from\s*"\.\/redaction\.ts"/);
    expect(llmBridge).not.toMatch(/function\s+redactContent\s*\(/);
    expect(llmBridge).not.toMatch(/function\s+redactTurnTogether\s*\(/);
    expect(llmBridge).not.toMatch(/function\s+redactToolCallArguments\s*\(/);
    expect(llmBridge).not.toMatch(/function\s+redactMessage\s*\(/);
  });
});

describe("PII redaction owner — tool-call-argument memo (content-addressed, bounded, registry-aware)", () => {
  /**
   * The memo inside `redactToolCallArguments` exists because loops, retries
   * and parallel batches replay byte-identical argument payloads. The arms
   * below pin the memo's CONTRACT: an exact replay returns the memoised
   * redaction without re-detecting; the memoised value is the redacted
   * form, never the raw input; distinct payloads never collide; the memo is
   * bounded with oldest-first eviction; and a known-secret registry
   * mutation (a credential the process learned, rotated or forgot) empties
   * it, so an answer memoised before the process knew a secret is never
   * served after it did.
   *
   * Every assertion reads the stats accessor as a DELTA, so the arms hold
   * in any test order and despite the memo being shared process-wide with
   * the bridge-level describes above.
   */

  /** A payload nobody else uses (the marker namespaces the cache key). */
  const memoPayload = (marker: string): string =>
    JSON.stringify({ path: `src/memo/${marker}.ts`, content: `// payload ${marker}` });

  test("an identical replay is redacted ONCE and served from the memo afterwards", () => {
    const args = memoPayload("run-once");
    const before = toolCallArgumentsMemoStats();
    const first = redactToolCallArguments(args);
    const mid = toolCallArgumentsMemoStats();
    const second = redactToolCallArguments(args);
    const after = toolCallArgumentsMemoStats();
    expect(second).toBe(first);
    // Detection ran exactly once: one miss for the first call, one hit for
    // the replay, and no second miss — the replay never re-entered the
    // parse → redact → re-stringify path.
    expect(mid.misses - before.misses).toBe(1);
    expect(after.misses - mid.misses).toBe(0);
    expect(after.hits - mid.hits).toBe(1);
  });

  test("a memo-replayed payload is the REDACTED form — the memo stores post-redaction output, never raw input", () => {
    const args = JSON.stringify({ content: `const API_KEY = "${SK_SECRET}"; // memo-pii-replay` });
    const first = redactToolCallArguments(args);
    const before = toolCallArgumentsMemoStats();
    const replayed = redactToolCallArguments(args);
    const after = toolCallArgumentsMemoStats();
    // The second call is provably memo-served…
    expect(after.hits - before.hits).toBe(1);
    // …and what it served is the redacted form of the payload, not the raw
    // string with the live secret inside it. A memo that served raw output
    // is the INERT shape of this defect (computed, then discarded).
    expect(replayed).not.toContain(SK_SECRET);
    expect(replayed).toContain("[REDACTED:");
    expect(first).not.toContain(SK_SECRET);
    expect(JSON.parse(replayed)).toEqual(JSON.parse(first));
  });

  test("distinct payloads occupy distinct entries (no aliasing across inputs)", () => {
    const a = memoPayload("distinct-a");
    const b = memoPayload("distinct-b");
    const before = toolCallArgumentsMemoStats();
    const redactedA = redactToolCallArguments(a);
    const redactedB = redactToolCallArguments(b);
    const after = toolCallArgumentsMemoStats();
    expect(redactedA).not.toBe(redactedB);
    expect(redactedA).toContain("distinct-a");
    expect(redactedB).toContain("distinct-b");
    expect(after.misses - before.misses).toBe(2);
    expect(after.entries - before.entries).toBe(2);
  });

  test("a known-secret registry mutation empties the memo — an answer memoised before the secret was known is never served after", () => {
    // The token is PROVEN unmasked-when-unregistered and masked-when-
    // registered (fixture verified against the live engine), so the two
    // calls below have observably different correct answers, and only the
    // generation check can deliver the right one each time.
    const label = "s62-memo-registry-swap";
    const token = "my-cat-is-called-biscuit";
    const args = JSON.stringify({ content: `console.log("tick ${token} tock")` });
    const unmasked = redactToolCallArguments(args);
    expect(unmasked).toContain(token); // liveness: nothing detects it yet
    const beforeMutation = toolCallArgumentsMemoStats();
    try {
      expect(registerKnownSecret(token, label).registered).toBe(true);
      const masked = redactToolCallArguments(args);
      const afterMutation = toolCallArgumentsMemoStats();
      // The registry bump emptied the memo: this call was a fresh miss,
      // not a replay of the unmasked entry cached a line above…
      expect(afterMutation.misses - beforeMutation.misses).toBe(1);
      expect(afterMutation.hits - beforeMutation.hits).toBe(0);
      // …and the fresh answer masks the credential the process now knows.
      expect(masked).not.toContain(token);
      expect(masked).toContain("[REDACTED:");
    } finally {
      forgetKnownSecret(label);
    }
  });

  test("the memo is bounded at the configured capacity and evicts the oldest entry first", () => {
    // The whole occupancy/eviction window holds the config's cross-process
    // write lock. The memo's invalidation inputs include the privacy POLICY
    // in force, compared by object reference — a config write in ANY
    // concurrent fork bumps the shared file's mtime, the re-parse builds a
    // new policy object, and the memo EMPTIES at the next call (fail-safe by
    // design). Without the lock, a parallel fork's write+restore cycle
    // (byte-identical or not) can land inside this arm's fill/assert window
    // and evict everything mid-proof — measured once against this round's
    // new config-writing arms. Holding the lock serializes this
    // occupancy-sensitive window against every writer: the lock exists so
    // config cycles cannot interleave, and this arm is a config-SENSITIVE
    // cycle even though it never writes.
    withConfigWriteLock(serverConfig.harnessConfigPath, () => {
      const capacity = getToolCallArgumentsCacheEntries();
      expect(capacity).toBeGreaterThan(0);
      const overflow = 64;
      const firstEver = memoPayload("evict-first");
      redactToolCallArguments(firstEver);
      for (let i = 0; i < capacity + overflow; i++) {
        redactToolCallArguments(memoPayload(`evict-${i}`));
      }
      const filled = toolCallArgumentsMemoStats();
      // More distinct payloads than the capacity inserted, so the memo sits
      // exactly at its bound — never above it, however long the run gets.
      expect(filled.entries).toBe(capacity);
      // LRU eviction is oldest-first, not random: the first payload is gone…
      redactToolCallArguments(firstEver);
      const afterFirst = toolCallArgumentsMemoStats();
      expect(afterFirst.misses - filled.misses).toBe(1);
      // …while the most recent one is still resident.
      redactToolCallArguments(memoPayload(`evict-${capacity + overflow - 1}`));
      const afterLast = toolCallArgumentsMemoStats();
      expect(afterLast.hits - afterFirst.hits).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// The config-governed policy — the document's `privacy` section is the
// masker's policy, and this suite owns the proof that the wiring is REAL
// and DEFAULT-PRESERVING. The config-writing arms live elsewhere by
// design: a masker-governing leaf (the marker) written into the SHARED
// config file would red every concurrently-running redaction suite inside
// the write window — measured, once, in this round: two suites'
// read-modify-write cycles interleaved and left a narrowed
// `enabledCategories` on disk, which the write gate's narrowing floor then
// refused on every subsequent write (the floor held; the bytes needed
// manual restoration). The suites therefore pin each hop WITHOUT a
// behavior-changing shared-file window:
//
//   config leaf → policy options → policy   (engine privacy-config-fields,
//                                            behavioral, constructed sections)
//   policy field → masker output            (engine suites, behavioral)
//   config file → getPrivacyPolicy          (harness-config.test.ts,
//                                            behavioral on the real file,
//                                            window-safe leaves + the found
//                                            file's own non-default leaf)
//   gate refuses the weakening write        (config-write-gate-owner,
//                                            behavioral, never touches disk)
//   boot refuses the hand-edited file       (the source-scan below — the
//                                            severed-pin red)
//   the doors consult the RESOLVED policy    (the source-scan below — the
//                                            severed-door red)
//   the end-to-end marker write → the wire  (the LIVE DRIVE: a real server,
//                                            one process, no suite to poison)
// ---------------------------------------------------------------------------
import { redactContent } from "../../server/llm/redaction.ts";
import { redactForLLMContext } from "../../engine/src/privacy/redaction-engine.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../engine/src/privacy/privacy-policy.ts";

describe("PII redaction owner — the config-governed policy (the privacy section reaches both egress paths)", () => {
  // The corpus the default-preserving arm runs over: a planted
  // provider-shaped secret, clean prose, and the escaped-JSON credential
  // case (the shape only the JSON-aware pass catches).
  const CORPUS = [
    `Pasted secret: ${SK_SECRET}`,
    "Explain this project. No secrets here — plain prose, code identifiers, a path (src/kernel/config.ts).",
    JSON.stringify({ content: `const API_KEY = "${SK_SECRET}";` }),
  ] as const;

  test("at the found config the masker's output is byte-identical to the engine's defaults-only policy", () => {
    // The wiring must be default-preserving: a config that does not change
    // a masker-governing leaf produces EXACTLY the output the constants
    // produced before the wiring existed — not almost, byte-identical.
    // (The found file's only non-default leaf, failClosedOnUncertainty, is
    // viewer-governed and masker-inert; the accessor suite pins its
    // mirror at the policy door.)
    for (const text of CORPUS) {
      expect(redactContent(text)).toBe(redactForLLMContext(text, DEFAULT_PRIVACY_POLICY));
    }
  });

  test("source-scan: the masker's doors pass the CONFIG-RESOLVED policy, never the engine's constant singleton", () => {
    // The severed-wiring red: if `redactContent` goes back to calling
    // `redactForLLMContext(text)` bare (the constant-default parameter), a
    // written privacy leaf reaches the file, the reader, the resolver —
    // and then changes nothing. This scan is the standing proof the last
    // hop exists.
    const owner = read(modulePathMatching("server/llm/redaction.ts") ?? modulePath("llm/redaction.ts"));
    expect(owner).toMatch(/redactForLLMContext\(text,\s*maskerPolicy\(\)\)/);
    expect(owner).toMatch(/redactMessagesTogether\(texts,\s*policy\)/);
    expect(owner).toMatch(/explainRedaction\(original,\s*maskerPolicy\(\)\)/);
  });

  test("source-scan: startup resolves the masker's policy before the socket listens", () => {
    // The boot refusal: the write gate judges bytes that pass through it,
    // so a weakening privacy section hand-edited into the file reaches the
    // disk unjudged. The eager `getPrivacyPolicy()` at boot is what turns
    // that hand-edit into a typed refusal (naming the refused values)
    // BEFORE the socket accepts traffic, instead of a failure at the
    // first egress call. Sever the call and the resolution merely moves
    // to that first call — every behavioral suite stays green, so only
    // this scan holds the boot-order face.
    const boot = read(modulePathMatching("server/index.ts"));
    expect(boot).toMatch(/getPrivacyPolicy\(\)/);
    expect(boot.indexOf("getPrivacyPolicy()")).toBeLessThan(boot.indexOf("server.listen("));
  });

  test("source-scan: the marker counters read the RESOLVED policy's marker (no hardcoded [REDACTED: consumer)", () => {
    // The producer/consumer split: the masker masks under whatever marker
    // the config resolved, and the two counters that decide "which pass
    // masked more" and "how many were already masked upstream" must count
    // the SAME spelling. A counter that hardcodes `[REDACTED:` reads a
    // configured marker as "nothing was masked" — the tiebreak then always
    // picks the plain pass and the escaped-secret leak the JSON-aware
    // pass exists to close comes back through the config door.
    const owner = read(modulePathMatching("server/llm/redaction.ts") ?? modulePath("llm/redaction.ts"));
    expect(owner).toMatch(/function countMaskedValues\(text: string, policy: PrivacyPolicy = maskerPolicy\(\)\)/);
    expect(owner).toMatch(/function countRedactionMarkers\(text: string, policy: PrivacyPolicy\)/);
    // And neither counter reaches for the hardcoded spelling.
    expect(owner).not.toMatch(/indexOf\("\[REDACTED:"/);
  });

  test("source-scan: the tool-arguments memo invalidates on a POLICY change, not only on a registry generation bump", () => {
    // The memo's output is a function of the input string, the registry
    // generation AND the resolved policy (the marker changes what the
    // memoised copy looks like). The clear condition must compare the
    // policy reference, or a config edit mid-run serves payloads masked
    // under the retired marker.
    const owner = read(modulePathMatching("server/llm/redaction.ts") ?? modulePath("llm/redaction.ts"));
    expect(owner).toMatch(/toolCallArgumentsMemoPolicy !== policy/);
    expect(owner).toMatch(/toolCallArgumentsMemoPolicy = policy/);
    // Drive fresh policy through the real byte reader and every composed
    // operation. One operation uses one policy; the next must see edits.
    // A private config prevents changing other workers' redaction policy.
    const env = { ...process.env };
    const path = join(createTempDir("redaction-policy-"), "config.json");
    const witness = "orchard canoe";
    const input = `${witness}\nconst API_KEY = "${SK_SECRET}";`;
    const args = JSON.stringify({ a: input, b: input });
    const reads = vi.spyOn(fileRead, "readFileText");
    try {
      resetServerConfig({ ...env, HARNESS_CONFIG_PATH: path });
      const outcomes = [];
      for (const prefix of ["[HIDDEN:", "[MASKED:"]) {
        writeFileSync(path, JSON.stringify({ privacy: { redactionPrefix: prefix } }), { mode: 0o600 });
        // What the next request's start does; egress itself never reads the file.
        refreshSettingsSnapshot();
        expect(redactContent(witness), "the witness is inert under each policy").toBe(witness);
        const operations = [
          { name: "values", masks: 2, run: () => JSON.stringify(redactStringValues({ a: input, b: [input] })) },
          { name: "tool JSON", masks: 2, run: () => redactToolCallArguments(args) },
          { name: "tool raw", masks: 1, run: () => redactToolCallArguments(input) },
          { name: "display JSON", masks: 2, run: () => JSON.stringify(redactForUserDisplay({ a: input, b: [JSON.stringify({ c: input })] })) },
          { name: "message", masks: 3, run: () => JSON.stringify(redactMessage({
            role: "assistant", content: input,
            tool_calls: [{ id: "call", type: "function", function: { name: "edit", arguments: args } }],
          })) },
          { name: "turn", masks: 3, run: () => JSON.stringify(redactTurnTogether([{
            role: "assistant", content: input,
            tool_calls: [{ id: "call", type: "function", function: { name: "edit", arguments: args } }],
          }]).redacted) },
        ];
        for (const operation of operations) {
          reads.mockClear();
          const output = operation.run();
          outcomes.push({
            name: `${prefix}${operation.name}`, leaks: output.includes(SK_SECRET),
            witnesses: output.split(witness).length - 1,
            masks: output.split(prefix).length - 1, expectedMasks: operation.masks,
            reads: reads.mock.calls.filter(([readPath]) => readPath === path).length,
          });
        }
        reads.mockClear();
        expect(isHiddenFromUserDisplay({ a: input, b: input })).toBe(true);
        outcomes.push({ name: `${prefix}hidden`, reads: reads.mock.calls.filter(([readPath]) => readPath === path).length });
        const before = toolCallArgumentsMemoStats();
        const replay = redactToolCallArguments(args);
        expect(replay).toContain(prefix);
        expect(replay).not.toContain(SK_SECRET);
        expect(toolCallArgumentsMemoStats().hits - before.hits).toBe(1);
      }
      expect(outcomes, "each egress uses the refreshed policy, returns its actual masks, and never reads the file itself").toEqual(outcomes.map((outcome) =>
        "expectedMasks" in outcome
          ? { ...outcome, leaks: false, witnesses: outcome.expectedMasks, masks: outcome.expectedMasks, reads: 0 }
          : { ...outcome, reads: 0 },
      ));
    } finally {
      reads.mockRestore();
      resetServerConfig(env);
    }
  });
});

test("native preparation retains declarations that actual block dedup removes",async()=>{
  const configuration=await import("../../server/kernel/harness-config.ts");
  const {streamChat,resetProviderClients}=await import("../../server/llm/llm-bridge.ts");
  const spy=vi.spyOn(configuration,"getDedupCompressionSection").mockReturnValue({enabled:true,llmInputDedup:true,dedupMode:"block"});
  let input: unknown, notices=0;
  // A REAL upstream answers (the door owns its transport): this arm's provider lives at the loopback address.
  serve(async(_url,init)=>{input=JSON.parse(String(init.body)).input;return responseSseResponse({content:"done"});});
  const LOOPBACK_CREDENTIAL=resolveProviderCredential(parseProviderStore({providers:[{id:"p",baseUrl:address("https://provider.invalid/v1"),apiKey:"sk-redaction-fixture",models:[{id:"m"}]}],defaultProvider:"p",defaultModel:"m"}),"m",PROVIDER_FIXTURE_OWNER);
  resetProviderClients();
  const shared=Array.from({length:20},(_,i)=>`Shared ordinary orchard canoe content line ${i}`).join("\n");
  const prompt=`${shared}\n\n${shared}\nmy password may be admin44\n\nprefix admin44 suffix`;
  try {
    const built=buildNativeRequest(prompt,{credential:CREDENTIAL});
    expect(built.dedupReports.some(report=>report!==null)).toBe(true);
    expect(JSON.stringify(built.request)).not.toContain("my password may be");
    expect(JSON.stringify(built.context)).toContain("my password may be admin44");
    for await(const event of streamChat(prompt,{credential:LOOPBACK_CREDENTIAL,onRedaction(notice){notices++;expect(notice.maskedCount).toBe(1);}})) {
      expect(event.type === "error" ? event : undefined).toBeUndefined();
    }
    expect(notices).toBe(1);
    expect(JSON.stringify(input)).toContain("prefix [REDACTED:secret] suffix");
    expect(JSON.stringify(input)).not.toContain("admin44");expect(JSON.stringify(input)).not.toContain("my password may be");
  } finally {spy.mockRestore();resetProviderClients();}
});
