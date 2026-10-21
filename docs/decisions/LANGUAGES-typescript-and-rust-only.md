---
id: LANGUAGES
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: NATIVE-ONE
---
# TypeScript and Rust only; port by measurement

Every extra language adds a toolchain, a build, a set of pitfalls and a skill
a contributor must have. So Bridlewise is written in two: TypeScript for
almost everything, and Rust where native code is truly needed.

The user's rule of 2026-10-10:

- TypeScript for orchestration, the server, the UI and tools; Rust for
  CPU-heavy, per-byte or security-critical native code. No third language.
- A TypeScript part moves to Rust only when a measurement shows a ceiling
  TypeScript cannot pass with worker threads. It goes behind the same
  interface, and the TypeScript version is deleted in the same round (no dual
  path, no fallback: [UR-17](UR-17-no-fallbacks.md)).

What is missing: the native code in this repository is still C
(`engine/guardian/`, including the test-process supervisor, and the
security-qualification probes under `engine/verification/benchmarks/security/`).
Porting it to Rust (NATIVE-ONE) is not done, and no guard yet refuses a new
file in a third language.
