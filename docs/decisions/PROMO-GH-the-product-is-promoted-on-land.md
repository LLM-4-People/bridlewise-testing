---
id: PROMO-GH
date: 2026-10-21
by: user
group: promotion
status: in-force
implementation: pending
route: GH-5
---
# The product is promoted in the one repository, on every land

GitHub is the only repository ("github should be the only repo", the user,
2026-10-21; the design is the coordination notes' `specs/github-only.md`,
§2.2 and §9.4). The product stops being a second repository and its
`master` branch. It is the `product` branch of the one repository, a
projection of `main` computed by the profile
`promotion/main-to-product.json`:

- `main` changes only through pull requests and the merge queue, so the
  local push hook no longer starts a promotion. The profile's trigger is
  `manual`. The trusted publish workflow promotes after every land, as the
  publisher App: a signed commit through the Git Data API, with parents
  `[product, main]`, a `Projected-From` trailer and a projection
  attestation. This supersedes [PROMO-AUTO](PROMO-AUTO-promote-after-every-testing-push.md).
- Nobody edits or merges into `product`; the ruleset lets only the
  publisher write it, which is
  [UR-12](UR-12-master-changes-only-through-the-promotion-door.md) on
  GitHub.
- The first promotion onto `product` is reviewed, as
  [PROMO-FIRST](PROMO-FIRST-the-first-promotion-reviewed.md)'s was. The
  branch is seeded from the archived product repository's history, so that
  promotion accepts the plan's exact target edits and deletions with a
  reason. Every later promotion is unattended.
- Releases are the release train's (`harness release`), tagged on
  `product`.

Pending until the publisher lands (lane GH-5): until then, nothing promotes.
