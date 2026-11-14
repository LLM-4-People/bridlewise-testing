---
id: L-2026-11-14-usage-dialects-belong-to-shared-contracts
date: 2026-11-14
source: source-specific observation telemetry
kind: tooling
status: acted
acted_in: [engine/src/shared/llm/usage-contracts.ts, engine/src/shared/llm/responses.ts, engine/src/privacy/responses-observation.ts, engine/src/privacy/README.md, engine/test/shared-suite/llm-observation.test.ts, engine/scripts/tooling/verification/governed-source.ts, engine/test/prevention/governed-zod-exports.test.ts]
---

## Observation

A count admitted by one protocol may be an unknown sensitive extension in another. Adding exemptions one field at a time duplicates policy. Accepting every value that a complete source schema parses is also unsafe: string metadata and arbitrary objects are not count authority.

## Lesson

Trusted callers select a complete source contract at the existing observer boundary. The shared count declaration and declared-path owner decide telemetry semantics. Containers are structural carriers, and their children retain canonical privacy. Source compatibility, a valid slot and whole-object consistency are separate claims.

## Change

The shared usage-contract module owns count admission and the Responses schema, preserving existing exports and defaults. An optional host schema applies only to explicitly declared body-relative roots. A pinned stable Message Usage declaration covers its full count vocabulary without claiming Beta support or a historical producer version. Regressions cover every count path, invalid values, nulls, unknown fields, non-count metadata, schema smuggling, carrier credentials and opaque ancestors.

Extraction exposed a source-analysis gap: direct fluent Zod schema builders lost their trusted provenance. The existing AST gate now follows a bounded construction grammar rooted in runtime Zod imports while retaining effect inspection. Local schema/namespace aliases remain unproved: a const binding does not make the object immutable. Foreign, shadowed, mutated, dynamic, unsupported and data-returning chains stay refused; no module exemption or baseline was added. The inherited direct namespace-call allowance is unchanged; this is not a complete Zod type or mutation analysis.
