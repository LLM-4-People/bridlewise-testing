# FOUNDATION-007 — Rendered snippets can be mistaken for source defects

- Status: **open blocking**
- Owner: `model-facing-repository-inspection`, reusing `authority-and-policy`
  semantic-role classification and the shared evidence-admission boundary
- Affected surfaces: builder, runtime, agents, tools, MCP adapters, CLI,
  future web, reviews, repair planning and transactional editing
- Detected: 2026-07-13

## Finding and explicit retraction

A long shared-tool read rendered duplicated boundary lines. A review then
provisionally reported duplicate content in Architecture and a consecutive
duplicate TypeScript object key. Those reports are retracted. No source edit was
made from either report, and neither report establishes a source defect.

The TypeScript report is disproved on retained exact bytes. The Architecture
report cannot even be admitted as an exact source finding because the full
identity of its transient in-progress subject and the original renderer result
were not retained. Its only truthful classification is `unverified-rendering`.
This finding concerns that missing source-finding admission boundary; it is not
evidence that Architecture or TypeScript contains the reported duplicates.

## Retained exact TypeScript recheck

The independently reread subject is `src/requirements.ts` with SHA-256
`71b4bb9b1bec943cdc4d5ddd419e542c00ca9c38bd25b97d308a59c48c92ffd9`,
46,445 bytes and 1,067 lines. Raw literal search found exactly two occurrences
of `usr001Through035Sha256`, not two consecutive keys in one object:

| Raw span and AST span | Parent/scope/import evidence | Occurrence role |
| --- | --- | --- |
| line 256; raw bytes `[8946,8985)`; AST `ObjectProperty` bytes `[8950,8984)` | `REQUIREMENTS_REGISTRY_SCHEMA.rowSetIntegrityHistory`, inside nested `z.strictObject(...)`; `z` is imported from `zod`, and `HEX_SHA256` is the referenced local validator | `reference` — schema-field validation |
| line 390; raw bytes `[16313,16406)`; AST `ObjectProperty` bytes `[16315,16405)` | `REQUIREMENTS_REGISTRY_ROW_SET_HASHES`, inside `deepFreeze(...)`; `deepFreeze` is imported from `./integrity.ts` | `materialization` — runtime value |

The first complete raw line has SHA-256
`2b3dcdb4906b999df58bf4ab7e074e8657c3dca3086012efe16da3024fefcbc5`;
the second has SHA-256
`7cc6c1a9a90c04dc18fc471eb9b0d08936a6c5019c6ac691e9d194e9372ebf60`.
A TypeScript-capable AST parse placed the occurrences under different object
expressions and lexical owners, and the exact subject typechecked. They are
role-distinct schema/reference and value/materialization occurrences. Deleting
either merely because the field name repeats would damage the contract.

The prevention author independently repeated the raw search with ripgrep
15.1.0 and the TypeScript-capable parse with `@babel/parser` 8.0.4 against that
same file hash after the original author had already reread it. No immutable
command receipt was retained, so these observations are not tool or parser
qualification evidence; they are a separate exact-byte confirmation of the
retraction only.

A candidate-manifest state
`85bc81b139828fb503b1e514fa602fcdf930a0766c7ffeb5915dbcc803528beb`
was observed around the reread, but no independently recoverable event binds it
to the instant of that reread. It is retained only as an adjacent observation,
not promoted to candidate or workspace identity evidence. The exact file hash,
length, line count, spans and AST result above are sufficient to retract this
particular same-object claim, but not to claim that the surrounding mutable
worktree was frozen or completely inspected.

## Architecture evidence limit

The Architecture report concerned transient in-progress bytes known only by
the SHA-256 prefix `ec5dd06f...`. It alleged repeated phrases around lines 345
and 620. A raw reread found one occurrence of each phrase, and the author made
no edit. The full SHA-256, byte length, line count, candidate/workspace identity
and original rendered result were not retained, so the incident remains
evidence-incomplete and `unverified-rendering`; it cannot authorize a repair or
support a claim about exact historical bytes. A later successor identified by
prefix `ef6a431...` is a different subject and must not be used to fill that
gap.

The accepted target design in
[`architecture-v1.md`](../../docs/architecture/architecture-v1.md) and the
current seed disposition in
[`foundation-seed-disposition-plan.md`](../../docs/architecture/foundation-seed-disposition-plan.md)
are linked only as non-authoritative design context for the future gateway.
Neither document is evidence for this incident, and neither path or a later
hash may be substituted for an unavailable transient subject.

## Required permanent prevention

Reuse the one candidate-bound model-facing inspection gateway, universal
authority/semantic-role analyzer, evidence admission index and transactional
effect gateway. Do not create a second file reader, duplicate detector or local
repair gate. Before any reported duplicate can become a source finding or
authorize a repair, one versioned receipt must bind:

1. repository, candidate and workspace identities; exact normalized path,
   mode, file SHA-256, byte length, line count and descriptor-held snapshot;
2. renderer/tool identity, call/result/page/cursor identity, raw source span and
   rendered span, including overlap, omission, ordering and join metadata;
3. a qualified language adapter and parser identity; exact AST parent path,
   lexical/module scope, resolved import/binding role and occurrence role;
4. every occurrence classified as `owner`, `reference`, `materialization`,
   `fixture` or `oracle`, with any generated or historical status supplied by
   the existing authority graph rather than inferred from equal text; and
5. a separate raw reread of the same held identity through an independent
   implementation/actor before the finding can authorize a registered repair.

Rendered, diff, semantic-search or tool snippets alone remain
`unverified-rendering`. Missing identity, drift between reads, parser or import
resolution failure, unsupported syntax, noncontiguous spans, renderer overlap,
or disagreement between the primary read and independent reread fails closed.
It produces no source-defect status and no edit proposal with repair authority.
Equal spelling is not sufficient: a defect requires a registered prohibited
same-role/same-scope occurrence or a duplicate semantic authority established
by the universal authority graph.

The earlier user examples of a type versus a fixture instance and a schema
literal validator versus an emitted value have no retained exact subject hash.
They remain non-evidentiary motivating cases only. The permanent regression
must nevertheless model those distinctions explicitly rather than teaching a
naive occurrence-count rule.

## Hostile regression and removal verification

The required regression is
`rendered-snippet-source-finding-admission-role-matrix-x3`. Its frozen oracle
must use at least three repetitions and three materially distinct scenarios,
including all of the following:

- duplicated first/last boundary lines across overlapping renderer pages;
- concatenated adjacent snippets whose missing separator creates an apparent
  duplicate key or token;
- noncontiguous search/diff/tool spans reordered or displayed as contiguous;
- equal text in `owner`, `reference`, `materialization`, `fixture` and `oracle`
  roles, including the type/fixture and validator/emitted-value distinctions;
- a real same-parent duplicate, a duplicate semantic authority across files,
  and role-distinct legitimate repetition as positive and negative controls;
- candidate/worktree drift, stale cursors, changed imports, aliasing, generated
  projections, parser failure and unsupported-language adapters; and
- a renderer and production parser sharing the same bug, caught by an
  independent raw-byte and AST oracle.

Every renderer-only mutant must remain `unverified-rendering`; every
role-distinct control must remain non-defective; every real prohibited
duplicate must be detected before effect. The future foundation seed plan must
register this regression under the existing inspection, authority, evidence and
transaction gateways and include it in complete prior-regression replay. It may
not implement a one-off check in a renderer, test fixture or agent prompt.

Removal requires the executable shared receipt/admission path, qualified
language adapters for every claimed language, the complete hostile matrix on
real repositories, exact retained results, transactional repair blocking, and
independent replay. A raw reread performed voluntarily by a model is useful
defense in depth but does not close this finding.
