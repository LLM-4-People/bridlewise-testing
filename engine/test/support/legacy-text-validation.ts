import { InputError } from "../../src/kernel/errors.ts";

export function requireText(value: string): void {
  if (value.trim() === "") throw new InputError("Text values cannot be empty");
}
