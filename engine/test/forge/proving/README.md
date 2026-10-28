# proving

The `engine/test/forge/proving/` folder of the development surface: the
proving-ground scenarios (runbook P1.11, P3.8, P5; github-only §11). They run
against the organisation's `forge-proving-ground` repository on REAL GitHub,
so the offline suites never load them. Run them from the engine folder:
`node test/forge/proving/run.ts seed|check|V-6|V-14|V-15|V-25|V-28`.

## What each file does

- `proving-ground.ts` — the proving ground as the `agent` App, through the one credential module (no credential is printed). It provides:
  - the repository's identity: the forge section's one `provingGround` repository, never the trunk;
  - `publisherProvingGround`: the same repository as the publisher App, on a token the publish job hands in;
  - `provingWorkspace`: a scratch clone and the real workspace manager over it, whose forge is the real GitHub implementation.

  The seed, the read-only configuration check and the verdict rules are in `../proving-ground-api.ts`, tested offline. The configuration itself comes only from the forge's settings-as-code and `harness forge apply`.
- `workspace-scenarios.ts` — the workspace's scenarios, run by the real `ws` code:
  - V-6: the agent's API commits are Verified, and a queue merge lands them under `required_signatures`;
  - V-15: `ws land` enters the required merge queue, and the outcome is reported at exactly the published head;
  - V-14: a two-part stack lands through the real queue with `delete_branch_on_merge` on.
- `projection-scenarios.ts` — the projector's scenarios, run by the real projector (computed confined, applied through the GitHub store) on a fixture board, as the publisher App:
  - V-25: one run brings the proving ground to the projection, verified; a second run of the same projection writes nothing;
  - V-28: under a publisher token without push access, an issue's `type` that GitHub accepts and does not keep is caught as `projection_unverified`; a kept type is V-28's fail, never a pass.

  They run in the publish job (the publisher's key exists only there), which hands the installation tokens in `BRIDLEWISE_PUBLISHER_TOKEN` and `BRIDLEWISE_PUBLISHER_ISSUES_TOKEN`.
- `run.ts` — the runner. It prints one JSON verdict per step, with its evidence URLs, and exits 1 if any step failed.

## Where it lives and what consumes it

The folder lives at `engine/test/forge/proving/`. The coordinator runs it, and its results go to the GH-3 lane log. No offline test may load it; `../proving-isolation.test.ts` walks the import graph from every test file to prove that.
