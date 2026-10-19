/**
 * Hostile fixture: duplicated 4096 in a.max(4096) position.
 * The test scans this file with the `path-length:max_4096` concept
 * (position: "max-arg") and asserts the detector finds the `4096`
 * NumericLiteral as an argument to `.max`.
 */
const hostileMax4096Schema = { max: (n: number) => n };
export function hostileMax4096Dup(): number {
  return hostileMax4096Schema.max(4096);
}
