# fixtures

The `engine/test/workspaces/fixtures/` folder of the development surface.

## What each file does

- `v2-records/` — real workspace records of the version before the forge (`bridlewise-workspace/v2`), the input of
  the record migration's tests.

## Where it lives and what consumes it

The folder lives at `engine/test/workspaces/fixtures/`. `engine/test/workspaces/workspace-migration.test.ts` reads it;
nothing shipped does.
