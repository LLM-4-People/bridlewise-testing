// @vitest-environment node
/**
 * ADVERSARIAL tests for PII redaction before the LLM.
 *
 * Escalates difficulty 10×: real secret formats (OpenAI sk-,
 * GitHub ghp_, AWS AKIA, Bearer, PEM private keys, credential assignments),
 * multiple secrets in one block, tool_calls arguments JSON, summary
 * extraction, memory injection, and false-positive safety on ordinary code.
 *
 * "PII module must cover actual sensitive PII — passwords, API keys,
 * tokens, private keys, etc. Redact PII before sending to LLM AND before
 * showing to user. Keep consts/vars/env names."
 *
 * The core invariant: `const API_KEY = "sk-..."` → `const API_KEY =
 * "[REDACTED:credential]"` — the variable NAME is preserved so the LLM still
 * understands the code context; only the VALUE is masked.
 */
import { describe, test, expect, vi } from "vitest";
import * as harnessConfig from "../../server/kernel/harness-config.ts";
import {
  redactForLLMContext,
  hasSensitiveContent,
} from "../../engine/src/privacy/redaction-engine.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../engine/src/privacy/privacy-policy.ts";
import {
  buildTrimmedHistory,
  injectMemoriesIntoPrompt,
  createRunContextManager,
  seedContextManagerFromHistory,
  type RetrievedMemory,
} from "../../server/context/context-bridge.ts";

// A realistic long secret (the format from, redacted-value-substituted
// to a test fixture — never a real key). Uses the `sk-` hyphen format (OpenAI /
// NeuralWatt style) that the credential-assignment signal catches.
const SK_SECRET = "sk-AAAAAAAAAAAAAAAAAAAAAAAA";
const GHP_SECRET = "ghp_AAAAAAAAAAAAAAAAAAAAAAAA";
const AWS_SECRET = "AKIAIOSFODNN7EXAMPLE";
const BEARER_SECRET = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature";

describe("redactForLLMContext — value-only redaction", () => {
  test("credential assignment: keeps the variable name, redacts only the value", () => {
    const input = `const API_KEY = "${SK_SECRET}";`;
    const out = redactForLLMContext(input);
    expect(out).toContain("API_KEY");
    expect(out).toContain("[REDACTED:");
    expect(out).not.toContain(SK_SECRET);
    // The variable declaration structure is preserved.
    expect(out).toMatch(/const API_KEY\s*=\s*"\[REDACTED:[^\]]*\]"/);
  });

  test("password assignment redacts the value, keeps the name", () => {
    const input = `const password = "supersecretpassword123456";`;
    const out = redactForLLMContext(input);
    expect(out).toContain("password");
    expect(out).toContain("[REDACTED:");
    expect(out).not.toContain("supersecretpassword123456");
  });

  test("secret assignment in env style (KEY = value without const)", () => {
    const input = `api_key: "${SK_SECRET}"`;
    const out = redactForLLMContext(input);
    expect(out).toContain("api_key");
    expect(out).not.toContain(SK_SECRET);
  });

  test("GitHub PAT (ghp_ prefix) is redacted as a token", () => {
    const input = `token = "${GHP_SECRET}"`;
    const out = redactForLLMContext(input);
    expect(out).not.toContain(GHP_SECRET);
    expect(out).toContain("[REDACTED:");
  });

  test("AWS access key is redacted", () => {
    const input = `aws_access_key_id = "${AWS_SECRET}"`;
    const out = redactForLLMContext(input);
    expect(out).not.toContain(AWS_SECRET);
    expect(out).toContain("[REDACTED:");
  });

  test("Bearer token is redacted", () => {
    const input = `Authorization: ${BEARER_SECRET}`;
    const out = redactForLLMContext(input);
    expect(out).not.toContain(BEARER_SECRET);
  });

  test("PEM private key header is redacted", () => {
    const input = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...";
    const out = redactForLLMContext(input);
    expect(out).toContain("[REDACTED:");
    // The header line itself should not pass through verbatim.
    expect(out).not.toContain("-----BEGIN RSA PRIVATE KEY-----");
  });

  test("multiple secrets in one block are ALL redacted", () => {
    const input = [
      `const API_KEY = "${SK_SECRET}";`,
      `const db_password = "verylongpasswordvalue123";`,
      `const gh_token = "${GHP_SECRET}";`,
      `// normal comment`,
      `const aws_key = "${AWS_SECRET}";`,
    ].join("\n");
    const out = redactForLLMContext(input);
    expect(out).not.toContain(SK_SECRET);
    expect(out).not.toContain(GHP_SECRET);
    expect(out).not.toContain(AWS_SECRET);
    expect(out).not.toContain("verylongpasswordvalue123");
    // Variable names + normal comment survive.
    expect(out).toContain("API_KEY");
    expect(out).toContain("db_password");
    expect(out).toContain("gh_token");
    expect(out).toContain("aws_key");
    expect(out).toContain("// normal comment");
  });

  test("ordinary code with no secrets is unchanged", () => {
    const input = [
      "const x = 42;",
      "function add(a, b) { return a + b; }",
      'const greeting = "hello world";',
      "export default add;",
    ].join("\n");
    const out = redactForLLMContext(input);
    expect(out).toBe(input);
  });

  test("empty and non-string inputs are safe", () => {
    expect(redactForLLMContext("")).toBe("");
    // @ts-expect-error -- testing runtime guard against non-string
    expect(redactForLLMContext(null)).toBe("");
    // @ts-expect-error -- testing runtime guard against non-string
    expect(redactForLLMContext(undefined)).toBe("");
  });

  test("hasSensitiveContent detects secrets with the default policy", () => {
    expect(hasSensitiveContent(`api_key = "${SK_SECRET}"`, DEFAULT_PRIVACY_POLICY)).toBe(true);
    expect(hasSensitiveContent("const x = 42;", DEFAULT_PRIVACY_POLICY)).toBe(false);
    expect(hasSensitiveContent("", DEFAULT_PRIVACY_POLICY)).toBe(false);
  });

  test("short values below the 16-char threshold are NOT redacted (avoids false positives)", () => {
    // The credential-assignment signal requires 16+ char values. A short
    // password-like value should NOT be flagged (KISS — avoid noise).
    const input = 'const secret = "short";';
    const out = redactForLLMContext(input);
    expect(out).toBe(input);
  });
});

describe("buildTrimmedHistory — PII redaction in the LLM-bound history", () => {
  test("tool result with a secret is redacted before reaching the LLM", () => {
    const cm = createRunContextManager();
    const toolCallId = "call_1";
    const toolCalls = [{ id: toolCallId, type: "function" as const, function: { name: "read_file", arguments: '{"path":"/etc/config"}' } }];
    cm.addTurn({ role: "assistant", content: "", toolCalls });
    cm.addTurn({
      role: "tool",
      content: `const API_KEY = "${SK_SECRET}";\nconst other = "value";`,
      toolCallId,
    });
    const history = buildTrimmedHistory(cm);
    const toolMsg = history.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain(SK_SECRET);
    expect(toolMsg!.content).toContain("API_KEY");
    expect(toolMsg!.content).toContain("[REDACTED:");
  });

  test("user message with a pasted secret is redacted", () => {
    const cm = createRunContextManager();
    cm.addTurn({ role: "user", content: `Here is my key: api_key = "${SK_SECRET}"` });
    const history = buildTrimmedHistory(cm);
    expect(history[0]!.content).not.toContain(SK_SECRET);
    expect(history[0]!.content).toContain("[REDACTED:");
  });

  test("tool_calls arguments JSON with a secret is redacted", () => {
    const cm = createRunContextManager();
    const args = JSON.stringify({ content: `const API_KEY = "${SK_SECRET}";` });
    const toolCalls = [{ id: "call_a", type: "function" as const, function: { name: "write_file", arguments: args } }];
    cm.addTurn({ role: "assistant", content: "writing a file", toolCalls });
    // SPO: buildTrimmedHistory now filters orphaned tool CALLS
    // (an assistant with tool_calls but no matching tool result → OpenAI
    // 400). Add the matching tool result so the tool_calls survive the
    // filter and the redaction test can verify the arguments are masked.
    cm.addTurn({ role: "tool", content: "file written", toolCallId: "call_a" });
    const history = buildTrimmedHistory(cm);
    const assistantMsg = history.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    const redactedArgs = (assistantMsg as { tool_calls?: readonly { function: { arguments: string } }[] }).tool_calls?.[0]?.function.arguments;
    expect(redactedArgs).toBeDefined();
    expect(redactedArgs!).not.toContain(SK_SECRET);
    expect(redactedArgs!).toContain("[REDACTED:");
  });

  test("summary of dropped turns does not contain PII (redacting summarizer)", () => {
    // Seed enough turns to force a trim, with a secret in an early turn.
    const cm = createRunContextManager();
    cm.addTurn({ role: "user", content: `My API key is api_key = "${SK_SECRET}" please help` });
    cm.addTurn({ role: "assistant", content: "I will help you with that configuration." });
    // Add many turns to push the secret-bearing turn into the summarized prefix.
    for (let i = 0; i < 40; i++) {
      cm.addTurn({ role: "user", content: `turn ${i} question about normal code things that are long enough` });
      cm.addTurn({ role: "assistant", content: `turn ${i} answer with sufficient length to consume tokens normally` });
    }
    cm.trim();
    const history = buildTrimmedHistory(cm);
    // The secret must NOT appear anywhere in the LLM-bound history.
    const allContent = history.map((m) => m.content).join("\n");
    expect(allContent).not.toContain(SK_SECRET);
  });
});

describe("injectMemoriesIntoPrompt — PII redaction in memory injection", () => {
  test("memory content with a secret is redacted in the injected prompt", () => {
    const memories: RetrievedMemory[] = [
      {
        id: "mem_1",
        content: `Found config: const API_KEY = "${SK_SECRET}";`,
        tier: "short-term",
        timestamp: new Date().toISOString(),
        score: 0.9,
      },
    ];
    const result = injectMemoriesIntoPrompt("You are a helpful assistant.", memories);
    expect(result).not.toContain(SK_SECRET);
    expect(result).toContain("[REDACTED:");
    expect(result).toContain("API_KEY");
    expect(result).toContain("Recalled context");
  });

  test("multiple memories with different secrets are all redacted", () => {
    const memories: RetrievedMemory[] = [
      { id: "1", content: `api_key = "${SK_SECRET}"`, tier: "short-term", timestamp: "", score: 1 },
      { id: "2", content: `token = "${GHP_SECRET}"`, tier: "long-term", timestamp: "", score: 1 },
    ];
    const result = injectMemoriesIntoPrompt("system", memories);
    expect(result).not.toContain(SK_SECRET);
    expect(result).not.toContain(GHP_SECRET);
  });

  test("no memories → prompt unchanged", () => {
    const prompt = "You are a helpful assistant.";
    expect(injectMemoriesIntoPrompt(prompt, [])).toBe(prompt);
  });

  test("memory with long content is previewed AND redacted", () => {
    const longContent = `const API_KEY = "${SK_SECRET}";`.repeat(10);
    const memories: RetrievedMemory[] = [
      { id: "1", content: longContent, tier: "short-term", timestamp: "", score: 1 },
    ];
    const result = injectMemoriesIntoPrompt("system", memories);
    expect(result).not.toContain(SK_SECRET);
    const preview = vi.spyOn(harnessConfig, "getMemoryPreviewMaxChars");
    try {
      const useful = memories.map((memory) => ({ ...memory, content: "useful\ncontext preserved in the preview" }));
      useful.push({ ...useful[0]!, id: "second", tier: "long-term" });
      preview.mockReturnValue(14);
      const first = injectMemoriesIntoPrompt("system", useful);
      expect(first).toContain("- [short-term] useful context…");
      expect(first).toContain("- [long-term] useful context…");
      expect(preview).toHaveBeenCalledTimes(1);
      preview.mockReturnValue(24);
      const second = injectMemoriesIntoPrompt("system", useful);
      expect(second).toContain("- [short-term] useful context preserved…");
      expect(second).toContain("- [long-term] useful context preserved…");
      expect(preview).toHaveBeenCalledTimes(2);
      expect(injectMemoriesIntoPrompt("empty witness", [])).toBe("empty witness");
      expect(preview).toHaveBeenCalledTimes(2);
    } finally { preview.mockRestore(); }
  });
});
