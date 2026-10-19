export type CommandClass = "build" | "generate" | "check";
export type CommandEffect =
  | "child-process"
  | "cryptography"
  | "filesystem-read"
  | "filesystem-write"
  | "git"
  | "network"
  | "process-status";
export type CommandEffectMode = Readonly<{
  availability: "available" | "blocked";
  effects: readonly CommandEffect[];
  invocation: "default-or-explicit" | "explicit-only";
  name: string;
  unavailableCode: string | undefined;
}>;
export type CommandEffectContract = Readonly<{
  schemaVersion: "bridlewise-command-effect-contract/v1";
  commandClass: CommandClass;
  commandId: string;
  defaultMode: string;
  modes: readonly CommandEffectMode[];
}>;
export type CommandEffectContractInput = Readonly<{
  commandClass: CommandClass;
  commandId: string;
  defaultMode: string;
  modes: readonly Readonly<{
    availability: "available" | "blocked";
    effects: readonly CommandEffect[];
    invocation: "default-or-explicit" | "explicit-only";
    name: string;
    unavailableCode: string | undefined;
  }>[];
}>;

export const COMMAND_EFFECT_CONTRACT_SCHEMA_VERSION: "bridlewise-command-effect-contract/v1";
export class CommandEffectContractError extends Error {
  readonly code: string;
}
export function defineCommandEffectContract(input: CommandEffectContractInput): CommandEffectContract;
export function resolveCommandEffectMode(
  contract: CommandEffectContract,
  argv: readonly string[],
): CommandEffectMode;
