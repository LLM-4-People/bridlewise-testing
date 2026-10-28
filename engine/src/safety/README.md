# Safety

The safety domain: the pre-dispatch gates, the runtime detectors, and the self-protection floor that bound what a run may do.

## What each file does

- `bandaid-ast-detector.ts` — the bandaid-ast-detector module.
- `bandaid-config.ts` — the bandaid-config module.
- `bandaid-detector.ts` — the bandaid-detector module.
- `bandaid-exposure.ts` — Bandaid-module shared exposure — signals, actions, customizations.
- `bandaid-pattern-learner.ts` — the bandaid-pattern-learner module.
- `bias-config.ts` — the bias-config module.
- `bias-detector.ts` — the bias-detector module.
- `bias-preventer.ts` — the bias-preventer module.
- `deviation-detector.ts` — the deviation-detector module.
- `hallucination-config.ts` — the hallucination-config module.
- `hallucination-detector.ts` — Hallucination detector — 7 layers (EXP354/388, EXP447 adds L7 SEMANTIC).
- `hallucination-semantic.ts` — EXP447 — L7 SEMANTIC hallucination layer (ported + improved from EXP388).
- `index.ts` — Unified safety module barrel — composes the hallucination, bias, and.
- `investigation.ts` — the investigation module.
- `pause-ask.ts` — the pause-ask module.
- `safety-config-section.ts` — the safety config section's owner: the section schema and the posture floors.
- `shared-helpers.ts` — the shared-helpers module.
- `step-skip-detector.ts` — the step-skip-detector module.
- `tool-call-gate.ts` — Pre-dispatch hallucination gate for LLM tool calls (EXP485, ).
- `workaround-detector.ts` — the workaround-detector module.

## Where it lives

The folder lives at `engine/src/safety/`.
