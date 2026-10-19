import { canonicalJson, deepFreeze } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import {
  snapshotJsonValue,
  snapshotUint8Array,
  type SnapshotJsonValue,
  type StructuralSnapshotLimits,
} from "../../../src/kernel/safe-structural.ts";

import { fail } from "./shared.ts";

const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type CandidateParserProtocol<Value> = Readonly<{
  structuralLimits: StructuralSnapshotLimits;
  maximumCandidateBytes: number;
  parse: (value: SnapshotJsonValue) => Value;
  codePrefix: string;
  label: string;
}>;

export function parseCanonicalCandidateBytes<Value>(
  protocol: CandidateParserProtocol<Value>,
  input: unknown,
): Value {
  let bytes: Uint8Array;
  try {
    bytes = snapshotUint8Array(input, protocol.maximumCandidateBytes);
  } catch {
    fail(`${protocol.codePrefix}_bytes_unsafe`, `${protocol.label} byte input is unsafe`);
  }
  let text: string;
  try {
    text = FATAL_UTF8.decode(bytes);
  } catch {
    fail(`${protocol.codePrefix}_utf8_invalid`, `${protocol.label} is not valid UTF-8`);
  }
  assertNoDuplicateJsonObjectKeys(
    text,
    `${protocol.label} contains a duplicate key`,
    `${protocol.codePrefix}_key_duplicate`,
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(text) as unknown;
  } catch {
    fail(`${protocol.codePrefix}_json_invalid`, `${protocol.label} is not valid JSON`);
  }
  const snapshot = snapshotJsonValue(
    decoded,
    protocol.structuralLimits,
    `${protocol.codePrefix}_structure_unsafe`,
  );
  const parsed = protocol.parse(snapshot);
  if (text !== `${canonicalJson(parsed)}\n`) {
    fail(`${protocol.codePrefix}_bytes_noncanonical`, `${protocol.label} bytes are not canonical`);
  }
  return deepFreeze(parsed);
}

export function parseCandidateObject<Value>(
  protocol: Omit<CandidateParserProtocol<Value>, "maximumCandidateBytes">,
  input: unknown,
): Value {
  const snapshot = snapshotJsonValue(
    input,
    protocol.structuralLimits,
    `${protocol.codePrefix}_structure_unsafe`,
  );
  return deepFreeze(protocol.parse(snapshot));
}
