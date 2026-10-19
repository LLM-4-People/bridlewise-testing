/**
 * Hostile fixture: duplicated "input_error" string literal.
 * The test scans this file with the `error-code:input_error` concept
 * (position: "any") and asserts the detector finds the `"input_error"`
 * StringLiteral. This file is NOT in the allowlist baseline, so the
 * detector reports it as a finding.
 */
export function hostileInputErrorDup(): string {
  return "input_error";
}
