---
schema: bridlewise-tracker-item/v1
published: false
id: FLAKY-CONFIG-PLATFORM-WARNING
type: Flake
state: open
lane: flaky-burn-down
owner-role: engine configuration
evidence: repo:pull/793
opened: 2026-11-13
---

Owns `engine/test/config/config-platform.test.ts`, including "ConfigPlatform: non-Linux bootstrap emits a single typed mountpoint-skip warning". The configuration owner must integrate and qualify the already prepared correction in [PR #793][repo:pull/793]. The correction now continues in [PR #810][repo:pull/810]. This remains open because the current `main` baseline still fails the original case, and a prepared branch is not a landed fix.

### Cause and existing correction

The old configuration module captures whether the platform supports mount information at import time. When another test first imports it on Linux, changing the platform to Darwin in the warning test still takes the Linux branch and produces no warning. The prepared correction reads the platform at each call and retains one warning per process for each non-Linux platform. Its existing causal lane is `FLAKY-CONFIG-PLATFORM-WARN-ONCE`; this tracking item adds no second source fix or reproduction mechanism.

PR #793 already carries the accepted deterministic reproduction for this exact case and the public-main parent: its configured preload loads configuration first, the parent fails all recorded runs and the correction passes all recorded runs under the same declared conditions. Reuse that accepted record and its source lineage. The current full-suite comparison reproduced the same inherited failure with no new or changed engine failures; that comparison establishes persistence, not closure or a new reproduction record.

### Acceptance

Review the existing correction against the current configuration owner, preserve the per-call platform read and once-per-process/per-platform behavior, and integrate it through the normal PR path. Verify the original warning case, the Linux-first import ordering, repeated Darwin bootstraps and a second non-Linux platform through the existing production bootstrap. Retain the accepted reproduction's declared conditions and failure identity; source movement or a different result needs its own recorded explanation rather than a repeated run for a green outcome.

Close this item only after the corrective source is on `main`, the required independent review and qualification are complete, and the original case is absent from the relevant complete-suite failure census. Preserve the accepted record and historical failures. Do not close related GitHub issues or other configuration lanes merely because this item owns this one failure.

<!-- BEGIN GENERATED: repository links, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->
[repo:pull/793]: https://github.com/LLM-4-People/bridlewise-testing/pull/793
[repo:pull/810]: https://github.com/LLM-4-People/bridlewise-testing/pull/810
<!-- END GENERATED: repository links -->
