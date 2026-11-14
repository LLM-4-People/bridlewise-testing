export type StandaloneNodeTestEnvironmentOptions = Readonly<{
  omitWorkerId?: boolean;
  omitLegacyContext?: boolean;
}>;

export function standaloneNodeTestEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  omit?: StandaloneNodeTestEnvironmentOptions,
): Record<string, string | undefined>;

export function collectTestFiles(directory: string): string[];
export function supportsStripTypes(): boolean;

export type E2eRunOptions = Readonly<{
  integrationDir?: string;
  timeoutMs?: number;
  stripTypes?: boolean;
  concurrency?: number;
}>;

export type E2eRunResult = {
  passed: boolean;
  testCount: number;
  failCount: number;
  passCount: number;
  summary: string;
  files: string[];
  failures: { file: string | null; name: string }[];
  skipCount?: number;
  timedOut?: boolean;
  exitCode?: number;
  stripTypes?: boolean;
  tsFiles?: boolean;
  concurrency?: number;
};

export function runE2e(options?: E2eRunOptions): Promise<E2eRunResult>;
