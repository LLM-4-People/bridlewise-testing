/**
 * Hostile fixture: duplicated "application/json" string literal.
 * The test scans this file with the `content-type:application_json` concept
 * (position: "any") and asserts the detector finds the `"application/json"`
 * StringLiteral.
 */
export function hostileApplicationJsonDup(): string {
  return "application/json";
}
