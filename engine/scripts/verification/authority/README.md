# Verification authority

The authority-resolution layer of the verification library: how a policy
declaration (an applicability rule, an exception, a lock) is compiled,
resolved, and matched against the occurrences it governs. Each module owns
one stage of that pipeline.

## What each file does

- `contracts.ts` — the authority contracts: the typed shapes of the policy
  declarations.
- `registry-runtime.ts` — the runtime registry of the declarations.
- `occurrence-discovery.ts` — discovering the occurrences a declaration may
  govern.
- `occurrence-selectors.ts` — the selectors that match occurrences.
- `applicability.ts` — deciding whether a declaration applies to an
  occurrence.
- `exceptions.ts` — the exception declarations and their resolution.
- `literal-semantics.ts` / `shape-semantics.ts` — the literal and shape
  semantics of the declarations.
- `semantic-resolution.ts` — resolving a declaration's meaning.
- `derivations.ts` — deriving the effective policy from the declarations.
- `lock-compiler.ts` — compiling the lock declarations.
- `typescript-adapter.ts` — the TypeScript adapter for the authority layer.
- `shared.ts` — helpers shared inside the authority layer.

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/scripts/verification/authority/`.

- `applicability.ts` is consumed by `engine/scripts/verification/authority/lock-compiler.ts`, `engine/scripts/verification/authority/registry-runtime.ts`.
- `contracts.ts` is consumed by `engine/scripts/verification/authority-graph.ts`, `engine/scripts/verification/authority/applicability.ts`, `engine/scripts/verification/authority/derivations.ts`, `engine/scripts/verification/authority/exceptions.ts`, `engine/scripts/verification/authority/lock-compiler.ts`, `engine/scripts/verification/authority/occurrence-discovery.ts` and 4 more.
- `derivations.ts` is consumed by `engine/scripts/verification/authority/lock-compiler.ts`.
- `exceptions.ts` is consumed by `engine/scripts/verification/authority/lock-compiler.ts`, `engine/scripts/verification/authority/occurrence-discovery.ts`.
- `literal-semantics.ts` is consumed by `engine/scripts/verification/authority/occurrence-discovery.ts`, `engine/scripts/verification/authority/semantic-resolution.ts`, `engine/scripts/verification/authority/shape-semantics.ts`.
- `lock-compiler.ts` is consumed by `engine/scripts/verification/authority-graph.ts`.
- `occurrence-discovery.ts` is consumed by `engine/scripts/verification/authority/lock-compiler.ts`.
- `occurrence-selectors.ts` is consumed by `engine/scripts/verification/authority/lock-compiler.ts`, `engine/scripts/verification/authority/occurrence-discovery.ts`.
- `registry-runtime.ts` is consumed by `engine/scripts/verification/authority/lock-compiler.ts`.
- `semantic-resolution.ts` is consumed by `engine/scripts/verification/authority/lock-compiler.ts`, `engine/scripts/verification/authority/occurrence-discovery.ts`.
- `shape-semantics.ts` is consumed by `engine/scripts/verification/authority/occurrence-discovery.ts`, `engine/scripts/verification/authority/semantic-resolution.ts`.
- `shared.ts` is consumed by `engine/scripts/verification/authority/applicability.ts`, `engine/scripts/verification/authority/contracts.ts`, `engine/scripts/verification/authority/derivations.ts`, `engine/scripts/verification/authority/exceptions.ts`, `engine/scripts/verification/authority/literal-semantics.ts`, `engine/scripts/verification/authority/lock-compiler.ts` and 5 more.
- `typescript-adapter.ts` is consumed by `engine/scripts/verification/authority/literal-semantics.ts`, `engine/scripts/verification/authority/lock-compiler.ts`, `engine/scripts/verification/authority/occurrence-discovery.ts`, `engine/scripts/verification/authority/occurrence-selectors.ts`, `engine/scripts/verification/authority/semantic-resolution.ts`, `engine/scripts/verification/authority/shape-semantics.ts`.

<!-- /consumers:generated -->
