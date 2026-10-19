/**
 * ONE place every experiment runner reads its LLM endpoint and key from: the
 * environment (D-09: a key reaches a process only through the environment,
 * loaded from a private file outside the repository, never printed). The
 * runners once read a JSON key file from the shared `/tmp`
 * (`/tmp/bridlewise/llm-api-config.json`), where any local user could plant one.
 */
export const EXPERIMENT_API_ENVIRONMENT = Object.freeze({
  baseUrl: "BRIDLEWISE_EXPERIMENT_LLM_BASE_URL",
  apiKey: "BRIDLEWISE_EXPERIMENT_LLM_API_KEY",
} as const);

/** The endpoint and key of an experiment run, from {@link EXPERIMENT_API_ENVIRONMENT}; refuses by name when one is unset. */
export function experimentApiFromEnvironment(env: NodeJS.ProcessEnv = process.env): Readonly<{ baseUrl: string; apiKey: string }> {
  const read = (name: string): string => {
    const value = env[name];
    if (value === undefined || value.length === 0) throw new Error(`set ${name} in the environment (never in a file under /tmp): the experiment has no ${name === EXPERIMENT_API_ENVIRONMENT.apiKey ? "API key" : "base URL"}`);
    return value;
  };
  return Object.freeze({ baseUrl: read(EXPERIMENT_API_ENVIRONMENT.baseUrl), apiKey: read(EXPERIMENT_API_ENVIRONMENT.apiKey) });
}
