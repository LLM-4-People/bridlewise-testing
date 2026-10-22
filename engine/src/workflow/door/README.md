# Door

The door: the trusted judge of every land (github-only §5.2–§5.3). It runs
`main`'s code only (`door.yml` on `workflow_run`), re-derives what it judges
from the CI run's artifacts and its own reads of GitHub, posts the one
required check, `bridlewise/door`, with the door App's token, and attests its
verdict.

## What each file does

- `door-config.ts` — the door's bounds in one place (`DOOR_LIMITS`): the pages read before judging, GitHub's check-run caps (annotations per request, title, summary and message characters), the names shown in a title, and the streamer's cadence. Each is a protocol limit or a display bound, never a judgement.
- `door-github.ts` — the door's typed GitHub operations on the one forge client (`../forge/port.ts`): a run and its attempts, its jobs and artifacts (listed, never downloaded here), a pull request and its commits, a git commit's tree and parents, a ref's existence, cancelling a run, the open secret-scanning alerts by commit, the check run (created or updated; annotations beyond 50 appended), a workflow dispatch that answers its run id, the merge queue's entries.
- `tree-judge.ts` — the content policy (size, compiled-code and archive extensions, credential file names, the one secret catalogue over the diff's text), the DCO sign-off of every commit, and open secret-scanning alerts on the pull request's commits.
- `ratchet.ts` — the gate ratchet: with the pipeline's owner unchanged, every workflow is main's generator output byte for byte; a tree that changes the owner keeps every gate main requires, still required, and is never reused.
- `door-git.ts` — the door's git reads on its own partial clone of `main`: fetching the judged commits without blobs, a path's object id, a blob, a directory listing, the diff against a base with each blob's size, and the merge tree of two commits (the queue-integrity check).
- `judge.ts` — the judge of one completed run: the run and its attempts re-read, the plan's tree held to the tree GitHub built (a pull request's test merge of exactly its head; a merge group's head, which must be the clean merge of its parents), the key re-derived from the commit, the receipt re-sealed from GitHub's job outcomes, the ratchet, and the tree judge over the pull request's own commits (`pullCommitRecords`, with the mechanical-merge test of the DCO ruling).
- `stream.ts` — the artifact preflight (names and sizes refused before any download), the live progress stream (display only; a destroyed group's run cancelled and the check said `dequeued`), and the Re-run cold button.
- `door-cli.ts` — `harness door preflight|stream|judge|action`, the verbs `door.yml` runs as the door App (`DOOR_TOKEN`; the endpoint from the forge section): a run that cannot be judged is posted as a failed check naming why, never left pending; `judge` writes the attestation's subject (`keydoc.json`) and predicate.
- `verdict.ts` — the verdict from the identity, the re-sealed receipt, the attempt discipline, the ratchet, the tree judge and the queue integrity; the check run it renders as (summary, annotations, the two buttons).

## Where it lives and what consumes it

<!-- consumers:generated -->

The folder lives at `engine/src/workflow/door/`.

- `door-cli.ts` is consumed by `engine/src/workflow/harness-commands.ts`.
- `door-config.ts` is consumed by `engine/src/workflow/door/door-cli.ts`, `engine/src/workflow/door/door-github.ts`, `engine/src/workflow/door/judge.ts`, `engine/src/workflow/door/stream.ts`, `engine/src/workflow/door/verdict.ts`.
- `door-git.ts` is consumed by `engine/src/workflow/door/judge.ts`.
- `door-github.ts` is consumed by `engine/src/workflow/door/door-cli.ts`, `engine/src/workflow/door/judge.ts`, `engine/src/workflow/door/stream.ts`, `engine/src/workflow/door/verdict.ts`.
- `judge.ts` is consumed by `engine/src/workflow/door/door-cli.ts`.
- `ratchet.ts` is consumed by `engine/src/workflow/door/judge.ts`, `engine/src/workflow/door/verdict.ts`.
- `stream.ts` is consumed by `engine/src/workflow/door/door-cli.ts`.
- `tree-judge.ts` is consumed by `engine/src/workflow/door/judge.ts`, `engine/src/workflow/door/verdict.ts`.
- `verdict.ts` is consumed by `engine/src/workflow/door/judge.ts`.

<!-- /consumers:generated -->
