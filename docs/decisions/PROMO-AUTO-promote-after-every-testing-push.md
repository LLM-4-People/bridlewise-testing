---
id: PROMO-AUTO
date: 2026-10-01
by: user
group: promotion
status: superseded
superseded_by: PROMO-GH
implementation: done
acted_in: [promotion/main-to-product.json]
---
# Auto-promotion is on

Right after the first reviewed promotion
([PROMO-FIRST](PROMO-FIRST-the-first-promotion-reviewed.md)), every push of
`testing` promotes by itself (the profile's `on-source-publish` trigger,
run by the push hook), as [PROMO-UD](PROMO-UD-promotion-choices.md)'s UD-1
decided; a rollback pauses it until released (its UD-7). Nobody edits or
merges into `master` directly
([UR-12](UR-12-master-changes-only-through-the-promotion-door.md)).

Superseded by [PROMO-GH](PROMO-GH-the-product-is-promoted-on-land.md): on GitHub, `main` changes only through the merge queue, and the trusted publish workflow promotes `product` after every land; the profile's trigger is `manual`.
