---
schema: bridlewise-tracker-item/v1
published: false
id: TREE-SITTER-PARSE-REFUSAL
type: Task
title: Refuse a failed tree-sitter parse instead of an empty extraction
state: closed
resolution: completed
lane: floor
opened: 2026-10-20
closed: 2026-10-20
---

`extractSymbolsTreeSitter` now throws the typed `tree_sitter_parse_failed` refusal (backend error carried as `cause`; the file is named in the message), `parseSync` refuses a missing tree, and `generateRepositoryMap` refuses instead of skipping the file. The regression at `engine/test/intelligence/tree-sitter-js-extract.test.ts` was red first (`returned 0 symbols (lineCount 3)`) and is green (8/8); the focused intelligence/editor suites (220 tests), the ten `tree-sitter` guards, and `npm run test:public` (28/28) pass. The isolated farm keeps its documented per-file containment for a killed child, and a typed parse refusal now reaches it as `FarmFileResult.errorCode` rather than as a successful zero-symbol extract.
