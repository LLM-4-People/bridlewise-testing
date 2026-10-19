# self protection

The `engine/test/filesystem/self-protection/` folder of the development surface.

## What each file does

- `apply-self-protection.test.ts` — the `apply-self-protection.test` module.
- `classify-guardian-result.test.ts` — the `classify-guardian-result.test` module.
- `compile-spec.test.ts` — the `compile-spec.test` module.
- `guardian-binary.test.ts` — the `guardian-binary.test` module.
- `key-home.test.ts` — the key home: located from the boot variable or the config home, admitted 0700, owned, not a link and identity-disjoint from its neighbours (the one admission: the system temp folder, store folders, declared projects); the explicit store registry (the key that seals each store, no prune on a read, forget, first-format records upgraded); a store's family by prefix; a process under test with no key home refused.
- `keep-out-cache.test.ts` — the keep-out list is built once per generation (1,000 verdicts, 0 rebuilds; a registration or a re-created base folder rebuilds exactly once).
- `keep-out-link-contract.test.ts` — the guardian and the TypeScript keep-out list resolve a floor link the same way: on the same worlds both refuse a project holding a link's target, a hop's folder or a dangling link's would-be target's folder, both refuse a project at or under a floor link's target, and both accept one the link leads away from.
- `keep-out-links.test.ts` — GUARD-F5: a link under the keep-out floor is kept out by what it names (its place and its target); a dangling or looping link by name; a link into a grant leaves the grant standing; an entry reached through a linked folder still refuses a grant over it — the real guardian over a temporary floor.
- `refused-paths.test.ts` — the ONE keep-out list at the compiler floor: unremovable minimum, operator additions, the key home and registered harness stores at any depth, the host's files, W^X, emission into the spec, by identity (bind-mount aliases included).
- `self-protection-contracts.test.ts` — the `self-protection-contracts.test` module.

## The subfolders

- `contract/`
- `hostile/`
- `prevention/`

## Where it lives and what consumes it

The folder lives at `engine/test/filesystem/self-protection/`.
