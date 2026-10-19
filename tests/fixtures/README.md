# fixtures

The `tests/fixtures/` folder of the development surface.

## The subfolders

- `workers/`

## The files

- `config-write-lock-holder.ts` — the child-process fixture the config-write
  concurrency suite spawns: it holds the config file's cross-process write lock
  (`hold`/`rmw` verbs) so a test can prove another process's acquire waits, and
  it announces through a pipe (`say`) with synchronous writes so a test never
  races a child's buffered stdout.

## Where it lives and what consumes it

The folder lives at `tests/fixtures/`.
