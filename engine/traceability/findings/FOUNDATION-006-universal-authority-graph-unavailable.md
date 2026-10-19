# FOUNDATION-006 — Universal authority graph and applicability gate are unavailable

- Status: **open blocking**
- Owner: `authority-and-policy`
- Affected surfaces: builder, runtime, extensions, agents, tools, providers,
  languages and tests
- Detected: 2026-07-12

## Finding

The current analyzer provides a bounded TypeScript-first proof slice. It does
not yet provide the universal ownership and applicability system required by
the harness. In particular, cross-language adapters, the canonical
registry/lock, domain-separated identity migration, the compiler, a read port
for all consumers, and the transactional pre-apply/pre-completion gate are not
available. The current analyzer therefore cannot close this finding.

## Required permanent repair

1. Establish one versioned registry for every semantic authority, its owner,
   generated projections, consumers and explicitly classified repetition
   roles.
2. Compile a complete applicability matrix across modules, layers, languages,
   agents, tools, providers, extensions and tests. Missing cells fail closed.
3. Produce a domain-separated immutable lock and migrate legacy hash preimages
   explicitly; a changed domain or compiler revision requires an admitted
   transition.
4. Expose one read port and require every consumer to derive values through it.
   Handwritten parallel literals, schemas, shapes and paths are rejected.
5. Enforce the graph at transactional pre-apply and pre-completion boundaries.
   The implementing agent cannot waive, suppress or self-close a finding.

## Removal verification

Run at least three repetitions of materially distinct hostile scenarios for
every supported language and authority kind. Mutate owners, consumers,
generated projections, registry cells, lock domains, exception roles and gate
ordering. Unclassified repetition, incomplete applicability, stale locks,
unsupported languages and bypassed gates must all fail before effects. An
independent implementation must replay the complete matrix before the finding
can be marked removed.
