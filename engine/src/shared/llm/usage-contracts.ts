/** Declared usage dialects share count admission and observation semantics. */
import { z } from "zod";

const json = z.json();
/** Conservative harness admission, not a provider's numeric representation guarantee. */
export const USAGE_COUNT_SCHEMA = z.number().int().nonnegative().safe();
export const RESPONSE_USAGE_SCHEMA = z.object({
  input_tokens: USAGE_COUNT_SCHEMA, output_tokens: USAGE_COUNT_SCHEMA, total_tokens: USAGE_COUNT_SCHEMA,
  input_tokens_details: z.object({ cached_tokens: USAGE_COUNT_SCHEMA.optional(), cache_write_tokens: USAGE_COUNT_SCHEMA.optional() }).catchall(json).optional(),
  output_tokens_details: z.object({ reasoning_tokens: USAGE_COUNT_SCHEMA.optional() }).catchall(json).optional(),
}).catchall(json).superRefine((usage, context) => {
  if (usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    context.addIssue({ code: "custom", message: "Usage totals are inconsistent" });
  }
  if ((usage.input_tokens_details?.cached_tokens ?? 0) > usage.input_tokens ||
      (usage.output_tokens_details?.reasoning_tokens ?? 0) > usage.output_tokens) {
    context.addIssue({ code: "custom", message: "Usage details exceed their totals" });
  }
});
export type ResponseUsage = Readonly<z.infer<typeof RESPONSE_USAGE_SCHEMA>>;

/**
 * Stable Message Usage, SDK revision 747e36c0d04d6d7b8a5eaa4586b581d5f3c676a1.
 * https://github.com/anthropics/anthropic-sdk-typescript/blob/747e36c0d04d6d7b8a5eaa4586b581d5f3c676a1/src/resources/messages/messages.ts#L5982
 * A declared compatibility contract, not proof of an archive producer's version.
 * Required nullable fields stay required; observations never fill defaults or totals.
 * Beta iteration/credit contracts are separate and are not admitted here.
 */
export const ANTHROPIC_MESSAGE_USAGE_SCHEMA = z.object({
  cache_creation: z.object({ ephemeral_1h_input_tokens: USAGE_COUNT_SCHEMA, ephemeral_5m_input_tokens: USAGE_COUNT_SCHEMA }).catchall(json).nullable(),
  cache_creation_input_tokens: USAGE_COUNT_SCHEMA.nullable(),
  cache_read_input_tokens: USAGE_COUNT_SCHEMA.nullable(),
  inference_geo: z.string().nullable(),
  input_tokens: USAGE_COUNT_SCHEMA,
  output_tokens: USAGE_COUNT_SCHEMA,
  output_tokens_details: z.object({ thinking_tokens: USAGE_COUNT_SCHEMA }).catchall(json).nullable(),
  server_tool_use: z.object({ web_fetch_requests: USAGE_COUNT_SCHEMA, web_search_requests: USAGE_COUNT_SCHEMA }).catchall(json).nullable(),
  service_tier: z.enum(["standard", "priority", "batch"]).nullable(),
}).catchall(json);

/** A complete, trusted host declaration; schema-like JSON from a payload has no authority. */
export type UsageObservationSchema = z.ZodObject;
export function isUsageObservationSchema(value: unknown): value is UsageObservationSchema {
  return value instanceof z.ZodObject;
}
function unwrap(schema: z.ZodType): z.ZodType {
  while (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) schema = schema.unwrap() as z.ZodType;
  return schema;
}
/** Only canonical count leaves and their declared structural carriers grant exemptions. */
function countSemantic(schema: z.ZodType, ancestors = new Set<z.ZodType>()): boolean {
  const inner = unwrap(schema);
  if (inner === USAGE_COUNT_SCHEMA) return true;
  if (!(inner instanceof z.ZodObject) || ancestors.has(inner)) return false;
  const children = Object.values(inner.shape) as z.ZodType[];
  if (children.length === 0) return false;
  ancestors.add(inner);
  const result = children.every(child => countSemantic(child, ancestors));
  ancestors.delete(inner);
  return result;
}
/** Per declared slot: no catchall, coercion, defaults, string-metadata or whole-object claim. */
export function isUsageObservationValue(root: UsageObservationSchema, path: readonly (string | number)[], value: unknown): boolean {
  let schema: z.ZodType = root;
  for (const key of path) {
    const object = unwrap(schema);
    if (!(object instanceof z.ZodObject) || typeof key !== "string" || !Object.hasOwn(object.shape, key)) return false;
    schema = object.shape[key];
  }
  return countSemantic(schema) && schema.safeParse(value).success;
}
/** The native Responses contract remains the default for existing consumers. */
export function isResponseUsageValue(path: readonly (string | number)[], value: unknown): boolean {
  return isUsageObservationValue(RESPONSE_USAGE_SCHEMA, path, value);
}
