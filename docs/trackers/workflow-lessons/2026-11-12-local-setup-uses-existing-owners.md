---
id: L-2026-11-12-local-setup-uses-existing-owners
date: 2026-11-12
source: GitHub issue 744 and the existing config permission bootstrap
kind: guard
status: pending
route: P3.1
---

## Observation

Local setup repeated the engine install and a raw configuration chmod across
the Makefile, devcontainer and contributor instructions. The existing bootstrap
already owns policy-derived permission repair without loading that config.

## Lesson

Expose one local package command that composes the existing dependency installer
and permission owner. Check current executable instructions, including generated
contributor instructions, while preserving historical evidence as history.
Keep CI on its existing base-owned action and explicit lifecycle-script policy.

## Change awaiting qualification

Local callers use `npm run setup:engine`. The command stops on installer failure
and propagates bootstrap failure. The existing shared setup regression guard
checks local examples and refuses use of the local package script in workflows
or composite actions. Published guides are discovered through the site's
existing publish plan, so a new guide cannot bypass the recipe check by using
a filename outside the required entry points. Historical record collections
retain their recorded examples. The guard does not claim to parse arbitrary
shell programs or provide a security boundary.

Its inert dispatcher test resolves npm through the supported PATH rather than
assuming its installation layout, and removes its owned temporary fixture
after success or failure. The dispatcher test does not certify a real install
or the permission bootstrap's platform, ownership and path guarantees.
Independent review and full qualification remain required before this lesson
is acted.
