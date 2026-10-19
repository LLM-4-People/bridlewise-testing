import { posix } from "node:path";

const EXACT_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!.*[*?\[\]{}\\])[^\0]+$/u;
const INVISIBLE_PATH_CODE_POINT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function exactPath(value: unknown): value is string {
  return typeof value === "string" && value.normalize("NFC") === value &&
    !INVISIBLE_PATH_CODE_POINT.test(value) && EXACT_PATH_PATTERN.test(value) && posix.normalize(value) === value;
}

export function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value);
}

export function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function nonemptyEvidenceLinks(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every(nonempty) && value.every(resolvableEvidenceLink);
}

export function resolvableEvidenceLink(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol.length > 1 && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function codePointCompare(left: string, right: string): number {
  const leftPoints = [...left].map((character) => character.codePointAt(0)!);
  const rightPoints = [...right].map((character) => character.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

export function compareTuple(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = codePointCompare(left[index]!, right[index]!);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

export function applicabilityKey(
  authorityId: string,
  dimension: string,
  member: string,
): string {
  return JSON.stringify([authorityId, dimension, member]);
}

export function extraKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
): readonly string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function array(value: unknown): readonly any[] {
  return Array.isArray(value) ? value : [];
}
