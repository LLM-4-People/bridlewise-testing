---
id: L-2026-11-14-syntax-validation-uses-source-dialect
date: 2026-11-14
source: Transactional editor refusal of a valid TypeScript generic arrow
kind: tooling
status: pending
route: syntax-dialect-repair
---

## Observation

The transactional editor rejected a valid TypeScript generic arrow with a union return type because its syntax validator enabled JSX for every TypeScript and JavaScript extension. The repository already had a shared Babel plugin selector that distinguishes their source dialects.

## Lesson

Select syntax through the existing source-dialect owner at the validation boundary. An extension registry must preserve the dialect it registers, and causal tests must cover syntax whose meaning changes between those dialects.

## Change

The default syntax-validator registry passes its canonical extension to the existing Babel plugin selector, retaining its other syntax plugins and public registry API. Regression tests cover the actual generic-arrow shape, TypeScript assertions, TSX and JSX support, refusal of JSX in other source dialects, and refusal of TypeScript in JavaScript. This repair leaves the shared selector and other parser consumers unchanged. The lesson remains pending until independent verification and qualification are complete.
