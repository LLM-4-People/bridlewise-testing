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

## Where it lives

The folder lives at `engine/scripts/verification/authority/`.
