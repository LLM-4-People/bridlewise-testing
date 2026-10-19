import { InputError } from "../../../src/kernel/errors.ts";

export function fail(code: string, message: string): never {
  throw new InputError(message, code);
}

export function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code, "Foundation values must be unique");
}
