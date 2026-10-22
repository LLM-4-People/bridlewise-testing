---
schema: bridlewise-tracker-item/v1
id: CORPUS-MANIFEST
type: Task
title: Publish the corpus manifest
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

`engine/test/fixtures/corpus-manifest.json` pins lodash, express and babel/traverse by commit and file hash (99 files); `npm run corpus:fetch` materialises them from upstream and links the cache, `npm run corpus:verify` judges it, and the focused probe passes 80 engine and 12 Vitest tests.
