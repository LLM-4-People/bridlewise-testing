---
id: UR-02
date: 2026-09-28
by: user
group: user-rules
status: in-force
implementation: standing
---
# Generated values come from generators

Hashes, pins, fingerprints, inventories, baselines and manifests are never
edited by hand: `cd engine && node src/cli.ts harness sync [--with-bundle]`
and the registered generators produce them. A generated value no generator
owns is a tooling gap: it is registered with a generator, so `harness sync`
regenerates it and `harness check` detects its drift.

**Enforcement.** The commit hook runs `harness check` when an engine file is
staged, and the CI job "Generated values and harness check"
(`.github/workflows/ci.yml`, job `generated`) runs `harness sync
--with-bundle` on every pull request, merge group and main push. It fails
when the generators change any tracked file or the check fails. It is a
required check on `main`, so a stale value cannot land.
