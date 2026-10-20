---
id: L-2026-10-20-public-floor-front-door
date: 2026-10-20
source: public repository split
kind: doc
status: acted
acted_in: [docs/index.md, docs/product.md, scripts/floor/site.mjs]
---

## Observation

The testing Pages site copied the product home as its root. That made the two repository pages look interchangeable and hid the contribution path behind a product mirror.

## Lesson

A public development floor needs its own front door. The product documentation is a reference surface, not the floor's identity. The root should answer what to test, how to help, how to build on the harness, and where the work is going, while the complete product documentation remains reachable at a named entry point.

## Change

The testing site now assembles a contributor hub at `/`, keeps the product documentation mirror at its original paths, and exposes `/product/`, `/floor/help/`, and `/floor/roadmap/`. The product repository keeps its own home and README. The site assembly test checks that the root is the hub and that the product documentation remains present.
