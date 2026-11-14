---
id: L-2026-11-14-telemetry-context-belongs-to-the-observer
date: 2026-11-14
source: structured observation telemetry recovery
kind: tooling
status: acted
acted_in: [engine/src/privacy/responses-observation.ts, engine/src/privacy/README.md, engine/test/shared-suite/llm-observation.test.ts]
---

## Observation

A generic error observation correctly masks sensitive numeric fields, including token-shaped keys. An admitted legacy telemetry envelope can therefore lose a count's original type when its source context is absent from the shared observer. Reconstructing the number after redaction would bypass the privacy owner.

## Lesson

Trusted adapters declare telemetry context at the existing observation boundary. Payload names never grant disclosure authority. The canonical protocol schema decides which values are counts, and invalid or unknown sensitive fields keep ordinary redaction.

## Change

The envelope observer accepts bounded, body-relative usage roots from trusted callers and reuses the existing canonical usage validator. Default observation behavior stays strict. Paired regressions cover trusted and absent context, exact path boundaries, invalid counts and extension credentials, and configured privacy floors. Historical record admission and whole-usage consistency remain separate judgments.
