---
id: L-2026-11-14-compile-cache-maintenance-shares-one-plan
date: 2026-11-14
source: Live cache maintenance investigation and independent shared-owner review
kind: tooling
status: pending
route: cache-maintenance-status
---

## Observation

The host was short of disk capacity while the canonical compile cache remained below its declared byte bound and contained no entries old enough for ordinary policy eviction. The cache owner had no read-only plan, and a separate manual selector would duplicate the production eviction rule. Selected paths and the prune stamp also needed current identity checks before their effects.

## Lesson

Expose maintenance decisions through the same owner that executes them. Observe current policy victims without modifying quotas or manufacturing a dry run, recheck the actual selected paths before effects, and keep changed, newly used and capped work distinct in reports.

## Change

The existing compile-cache owner shares its collection and LRU/age selector with a read-only aggregate plan API. The ordinary pruner checks current root, version and selected-entry identity plus last use before unlinking, preserves changed or newly used candidates, and reports those cases explicitly. Initial unsafe stamp paths refuse before entry effects; stamp publication uses the shared atomic writer after a current root check. This does not make check-and-unlink atomic, add a global live-run fence or authorize a destructive maintenance command. Full admission participation and a user-facing action remain separate work. This lesson stays pending until the actual source is independently verified and qualified.
