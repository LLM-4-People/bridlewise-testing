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

## The exceptions in the tree (checked 2026-10-21 with `git ls-files`)

Under the retroactive rule ([UR-19](UR-19-every-rule-is-retroactive.md)) each
exception is owned work, ported or removed under its issue:

| Files | Language | Owned by |
|---|---|---|
| `engine/verification/benchmarks/code-intelligence/{inspect_existing_baseline,mcp_probe,policy_schemas,qualification}.py`, `…/code-intelligence/tests/test_qualification.py` | Python (5) | [#133](https://github.com/LLM-4-People/bridlewise-testing/issues/133) |
| `engine/verification/benchmarks/context/{generate-scenarios,validate-suite}.py` | Python (2) | [#134](https://github.com/LLM-4-People/bridlewise-testing/issues/134) |
| `engine/verification/benchmarks/git/{fault_transport,qualification}.py`, `…/git/tests/test_qualification.py` | Python (3) | [#135](https://github.com/LLM-4-People/bridlewise-testing/issues/135) |
| `engine/guardian/tests/{require-pass-log,run-tests}.sh`, `engine/scripts/exp435/run-5000.sh`, `engine/verification/benchmarks/runtime/verify-node-v24.18.0-linux-x64.sh` | Shell (4) | [#136](https://github.com/LLM-4-People/bridlewise-testing/issues/136) |
| `engine/guardian/{landlock-guardian.c,landlock-guardian.h,test-process-supervisor.c}`, `engine/guardian/tests/test_payload.c` | C (4) | [#137](https://github.com/LLM-4-People/bridlewise-testing/issues/137) (NATIVE-ONE) |
| `engine/verification/benchmarks/security/s3-key-anchor-qualification/src/probe-{keyring,memory,mount-openat2}.c` | C (3) | [#138](https://github.com/LLM-4-People/bridlewise-testing/issues/138) |

Not exceptions: the evaluation fixtures under `engine/test/fixtures/eval-projects/`
(Python, Go, Java, Ruby) are inputs the code-intelligence evaluations read in
other languages on purpose; they are not Bridlewise's code.

## What is missing

- Every exception above is still in the tree.
- No guard yet refuses a new file in a third language
  ([#139](https://github.com/LLM-4-People/bridlewise-testing/issues/139)).
