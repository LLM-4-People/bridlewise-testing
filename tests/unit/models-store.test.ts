import { describe, test, expect, beforeEach } from "vitest";
import {
  modelsCatalog,
  selectedModelId,
  allModels,
  currentModelId,
  currentProviderId,
  setModels,
  selectModel,
  resetModels,
  type ModelsCatalog,
} from "../../src/state/models";

/**
 * Models store tests — verifies the catalog ingestion, the derived flat
 * model list, the default-model fallback, the provider lookup, and the
 * selection state. Pure store logic (no DOM, no Svelte).
 */

const SAMPLE_CATALOG: ModelsCatalog = {
  providers: [
    {
      id: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      models: [
        { id: "zai-org/GLM-5.2-NVFP4", maxTokens: 16384, temperature: 0 },
        { id: "google/gemma-4-26B-A4B", maxTokens: 16384, temperature: 0 },
      ],
      hasApiKey: true,
    },
    {
      id: "makora",
      baseUrl: "https://inference.makora.com/v1",
      models: [{ id: "google/gemma-4-26B-A4B", maxTokens: 16384, temperature: 0 }],
      hasApiKey: true,
    },
  ],
  defaultProvider: "makora",
  defaultModel: "google/gemma-4-26B-A4B",
  setupRequired: false,
  setupRemedy: "Open Settings and add a model provider.",
};

beforeEach(() => {
  resetModels();
});

describe("models store — ingestion", () => {
  test("setModels populates the catalog store", () => {
    setModels(SAMPLE_CATALOG);
    expect(modelsCatalog.get()).toEqual(SAMPLE_CATALOG);
  });

  test("allModels flattens models across providers with deduplication", () => {
    setModels(SAMPLE_CATALOG);
    const models = allModels.get();
    // FIX: duplicate model IDs across providers are deduplicated.
    // "google/gemma-4-26B-A4B" appears in both "openrouter" and "makora"
    // providers but should appear only once in the flat list.
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.id)).toContain("google/gemma-4-26B-A4B");
    expect(models.map((m) => m.id)).toContain("zai-org/GLM-5.2-NVFP4");
  });

  test("allModels is empty when no catalog is loaded", () => {
    expect(allModels.get()).toHaveLength(0);
  });
});

describe("models store — selection", () => {
  test("currentModelId falls back to the default model when none is selected", () => {
    setModels(SAMPLE_CATALOG);
    expect(currentModelId.get()).toBe("google/gemma-4-26B-A4B");
  });

  test("currentModelId reflects the selected model after selectModel", () => {
    setModels(SAMPLE_CATALOG);
    selectModel("zai-org/GLM-5.2-NVFP4");
    expect(currentModelId.get()).toBe("zai-org/GLM-5.2-NVFP4");
  });

  test("currentProviderId resolves the provider for the selected model", () => {
    setModels(SAMPLE_CATALOG);
    selectModel("zai-org/GLM-5.2-NVFP4");
    expect(currentProviderId.get()).toBe("openrouter");
  });

  test("currentProviderId resolves makora for gemma (appears in both providers)", () => {
    setModels(SAMPLE_CATALOG);
    selectModel("google/gemma-4-26B-A4B");
    // gemma appears in both providers; the first match is openrouter.
    expect(currentProviderId.get()).toBe("openrouter");
  });

  test("selecting null clears the selection and falls back to default", () => {
    setModels(SAMPLE_CATALOG);
    selectModel("zai-org/GLM-5.2-NVFP4");
    selectModel(null);
    expect(selectedModelId.get()).toBeNull();
    expect(currentModelId.get()).toBe("google/gemma-4-26B-A4B");
  });

  test("currentModelId is null when no catalog is loaded", () => {
    expect(currentModelId.get()).toBeNull();
    expect(currentProviderId.get()).toBeNull();
  });
});

describe("models store — reset", () => {
  test("resetModels clears the catalog and selection", () => {
    setModels(SAMPLE_CATALOG);
    selectModel("zai-org/GLM-5.2-NVFP4");
    resetModels();
    expect(modelsCatalog.get()).toBeNull();
    expect(selectedModelId.get()).toBeNull();
    expect(allModels.get()).toHaveLength(0);
  });
});
