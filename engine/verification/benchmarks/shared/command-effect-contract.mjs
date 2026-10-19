export const COMMAND_EFFECT_CONTRACT_SCHEMA_VERSION = "bridlewise-command-effect-contract/v1";

/** @typedef {"child-process"|"cryptography"|"environment-access"|"filesystem-read"|"filesystem-write"|"git"|"network"|"process-control"|"process-status"} CommandEffect */
const COMMAND_CLASSES = Object.freeze(["build", "generate", "check"]);
/** @type {ReadonlyArray<CommandEffect>} */
const EFFECTS = Object.freeze([
  "child-process",
  "cryptography",
  "environment-access",
  "filesystem-read",
  "filesystem-write",
  "git",
  "network",
  "process-control",
  "process-status"
]);
const READ_ONLY_DEFAULT_EFFECTS = new Set(["cryptography", "filesystem-read", "process-status"]);

export class CommandEffectContractError extends Error {
  constructor(code) {
    super(code);
    this.name = "CommandEffectContractError";
    this.code = code;
  }
}

export function defineCommandEffectContract(input) {
  if (!hasExactKeys(input, ["commandClass", "commandId", "defaultMode", "modes"]) ||
    !COMMAND_CLASSES.includes(input.commandClass) ||
    typeof input.commandId !== "string" || !/^[a-z0-9][a-z0-9./-]*$/u.test(input.commandId) ||
    typeof input.defaultMode !== "string" || !Array.isArray(input.modes) || input.modes.length === 0) {
    fail("command_effect_contract_invalid");
  }
  const names = new Set();
  const modes = input.modes.map((mode) => {
    if (!hasExactKeys(mode, ["availability", "effects", "invocation", "name", "unavailableCode"]) ||
      typeof mode.name !== "string" || !/^[a-z][a-z0-9-]*$/u.test(mode.name) || names.has(mode.name) ||
      !Array.isArray(mode.effects) || mode.effects.length === 0 ||
      new Set(mode.effects).size !== mode.effects.length || mode.effects.some((effect) => !EFFECTS.includes(effect)) ||
      !["default-or-explicit", "explicit-only"].includes(mode.invocation) ||
      !["available", "blocked"].includes(mode.availability) ||
      (mode.availability === "blocked") !== (typeof mode.unavailableCode === "string") ||
      (typeof mode.unavailableCode === "string" && !/^[a-z][a-z0-9_]*$/u.test(mode.unavailableCode))) {
      fail("command_effect_mode_invalid");
    }
    const requiresExplicitEffectMode = mode.effects.some((effect) => !READ_ONLY_DEFAULT_EFFECTS.has(effect));
    if (requiresExplicitEffectMode && mode.invocation !== "explicit-only") {
      fail("command_mutation_mode_not_explicit");
    }
    names.add(mode.name);
    return Object.freeze({
      availability: mode.availability,
      effects: Object.freeze([...mode.effects]),
      invocation: mode.invocation,
      name: mode.name,
      unavailableCode: mode.unavailableCode
    });
  });
  const defaultMode = modes.find((mode) => mode.name === input.defaultMode);
  if (defaultMode === undefined || defaultMode.invocation !== "default-or-explicit" ||
    defaultMode.availability !== "available" ||
    defaultMode.effects.some((effect) => !READ_ONLY_DEFAULT_EFFECTS.has(effect))) {
    fail("command_default_effect_mode_not_read_only");
  }
  return Object.freeze({
    schemaVersion: COMMAND_EFFECT_CONTRACT_SCHEMA_VERSION,
    commandClass: input.commandClass,
    commandId: input.commandId,
    defaultMode: input.defaultMode,
    modes: Object.freeze(modes)
  });
}

export function resolveCommandEffectMode(contract, argv) {
  if (!Array.isArray(argv)) fail("command_effect_arguments_invalid");
  const modeName = argv.length === 0 ? contract.defaultMode :
    argv.length === 1 && typeof argv[0] === "string" && argv[0].startsWith("--effect-mode=") ?
      argv[0].slice("--effect-mode=".length) : null;
  if (modeName === null || modeName.length === 0) fail("command_effect_arguments_invalid");
  const mode = contract.modes.find((candidate) => candidate.name === modeName);
  if (mode === undefined) fail("command_effect_mode_unknown");
  if (argv.length === 0 && mode.invocation !== "default-or-explicit") {
    fail("command_effect_mode_requires_explicit_invocation");
  }
  return mode;
}

function hasExactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).toSorted()) === JSON.stringify([...expected].toSorted());
}

function fail(code) {
  throw new CommandEffectContractError(code);
}
