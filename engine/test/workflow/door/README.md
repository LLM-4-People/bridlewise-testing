# door

The `engine/test/workflow/door/` folder of the development surface: the door's judges on planted inputs and scratch git history.

## What each file does

- `judges.test.ts` — the tree judge (size, extension, credential names, the secret catalogue over the diff's text, the DCO, open alerts), the DCO ruling on real git history (a mechanical update-branch merge accepted unsigned; an evil merge, a merge with no main parent and a plain unsigned commit refused), the ratchet (hand-edited, foreign and deleted workflows; dropped and demoted gates), the attempt discipline, and the verdict's check run.
- `judge-run.test.ts` — the judge end to end against GH-1's fake GitHub and a scratch `origin`: an agreeing pull-request run passes on the head GitHub named; an unsigned commit, a hand-edited workflow (V-7), a re-run after a failed attempt (V-23), a plan for another tree, a lying key, a fork and a run that is not the test merge of its head are each named; a merge group's clean merge passes and a group with another tree fails the queue-integrity check (V-22); hostile artifacts refused before download (V-19); the streamer's dequeue of a destroyed group and the cold button's refusal of a fork.
