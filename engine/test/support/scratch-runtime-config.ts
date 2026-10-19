import { readFileSync } from "node:fs";

import { getConfigDocumentSchema, type ConfigDocument } from "../../src/kernel/config-contracts.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

/**
 * A CONFIG DOCUMENT WITH A SCRATCH PROVIDER — the fixture the agent and
 * orchestrator tests declare for themselves.
 *
 * The checked-in `bridlewise.config.json` deliberately ships NO provider,
 * no default provider and no default model (the provider decision: a vendor
 * value in the repository answers a question the user never answered), so
 * its agent profiles cannot resolve until a user declares a provider — and
 * tests that consumed the repository's provider as a fixture were leaning on
 * exactly the vendor default that was removed. These tests exercise
 * orchestration and agent mechanics over a MOCK adapter, so what they need
 * is a provider-shaped value, not a vendor: this helper takes the real
 * document (everything else stays honest — limits, schema validation) and
 * declares a scratch provider serving a scratch model, plus the three
 * fixture profiles the agent suites drive. The base URL is `.invalid`
 * (RFC 2606) so nothing can resolve it even if a test accidentally reaches
 * for the network.
 *
 * THE PROFILES ARE DECLARED HERE, NOT READ FROM THE FILE — the same
 * declare-by-user decision that emptied `runtime.providers` also emptied
 * `agents.profiles`: a shipped profile names a model and a provider, which
 * answers a question the user never answered, so the checked-in list is
 * empty and a user's profiles reference providers THEY saved. These three
 * were the shipped samples; they were always really a test fixture, and now
 * they live where the fixture lives.
 */
export const SCRATCH_PROVIDER_ID = "test-provider";
export const SCRATCH_MODEL_ID = "test-model";

const SCRATCH_PROFILES: ReadonlyArray<Record<string, unknown>> = [
  {
    name: "researcher",
    model: SCRATCH_MODEL_ID,
    provider: SCRATCH_PROVIDER_ID,
    systemPrompt: "You are a research agent. Read files and gather information. Do not modify files.",
    tools: ["read_file", "list_files"],
    capabilities: ["read"],
    writeSet: [],
    maxTurns: 10,
  },
  {
    name: "implementer",
    model: SCRATCH_MODEL_ID,
    provider: SCRATCH_PROVIDER_ID,
    systemPrompt: "You are an implementation agent. Read and modify source files within your write set.",
    tools: [
      "read_file",
      "list_files",
      // The ONE edit tool (every edit shape — replace, insert, delete,
      // whole-file, create — collapses to it).
      "edit",
    ],
    capabilities: ["read", "write"],
    writeSet: ["src/"],
    maxTurns: 20,
  },
  {
    name: "reviewer",
    model: SCRATCH_MODEL_ID,
    provider: SCRATCH_PROVIDER_ID,
    systemPrompt: "You are a review agent. Read files and provide feedback. Do not modify files.",
    tools: ["read_file", "list_files"],
    capabilities: ["read"],
    writeSet: [],
    maxTurns: 10,
  },
];

export function scratchAgentsConfigDocument(): ConfigDocument {
  const raw = JSON.parse(
    readFileSync(new URL("../../bridlewise.config.json", import.meta.url), "utf8"),
  ) as {
    runtime?: Record<string, unknown>;
    agents?: { profiles?: Array<Record<string, unknown>> };
  };
  if (raw.runtime !== undefined) {
    raw.runtime.providers = [{
      id: SCRATCH_PROVIDER_ID,
      baseUrl: "https://provider.invalid/v1",
      apiKeyEnvVar: "TEST_PROVIDER_KEY",
      timeoutMs: 120_000,
      retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10_000, backoffMultiplier: 2 },
      responsesPath: "/responses",
      models: [{ id: SCRATCH_MODEL_ID, maxTokens: 16_384, temperature: 0 }],
    }];
    raw.runtime.defaultProvider = SCRATCH_PROVIDER_ID;
    raw.runtime.defaultModel = SCRATCH_MODEL_ID;
  }
  if (raw.agents !== undefined) {
    raw.agents.profiles = structuredClone(SCRATCH_PROFILES) as Array<Record<string, unknown>>;
  }
  // Parsed through the REAL schema, so the scratch fixture cannot drift into
  // a shape production would refuse.
  return CONFIG_DOCUMENT_SCHEMA.parse(raw);
}
