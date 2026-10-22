# proving

The `engine/test/forge/proving/` folder of the development surface: the
proving-ground scenarios (runbook P1.11, P3.8; github-only §11). They run
against the organisation's `forge-proving-ground` repository on REAL GitHub,
so the offline suites never load them. Run them from the engine folder:
`node test/forge/proving/run.ts seed|check|V-6|V-14|V-15`.

## What each file does

- `proving-ground.ts` — the proving ground as the `agent` App, through the one credential module (no credential is printed). It provides:
  - the seed: the empty repository's first commit on `main`, through the contents API;
  - the read-only configuration check, which refuses (`proving_ground_unconfigured`) without a `merge_queue` and `required_signatures` ruleset on `main` and without `delete_branch_on_merge`. That configuration comes only from the forge's settings-as-code and `harness forge apply`;
  - `provingWorkspace`: a scratch clone and the real workspace manager over it, whose forge is the real GitHub implementation.
- `workspace-scenarios.ts` — the workspace's scenarios, run by the real `ws` code:
  - V-6: the agent's API commits are Verified, and a queue merge lands them under `required_signatures`;
  - V-15: `ws land` enters the required merge queue, and the outcome is reported at exactly the published head;
  - V-14: a two-part stack lands through the real queue with `delete_branch_on_merge` on.
- `run.ts` — the runner. It prints one JSON verdict per step, with its evidence URLs, and exits 1 if any step failed.

## Where it lives and what consumes it

The folder lives at `engine/test/forge/proving/`. The coordinator runs it, and its results go to the GH-3 lane log.
