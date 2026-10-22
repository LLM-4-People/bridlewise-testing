---
id: GH-C
date: 2026-10-21
by: user
group: github
status: in-force
implementation: pending
route: P9.1
---
# All labs merge into the one repository

Experiments kept in separate repositories drift away from the code they are
meant to improve, and each needs its own setup. So every lab comes into the
one Bridlewise repository, and graduates from there into the part of the
harness that owns its concern.

The user's decision C of 2026-10-21 (GITHUB DECISIONS): "I thought we were
supposed to merge them all into here?" Then: "got it, but do the full github
first".

- ALL labs merge into the ONE harness repository and graduate into their
  owners; there are no separate lab repositories. It withdraws the earlier
  proposal of one repository per lab.
- The COMPLETE GitHub setup comes first; the labs come in afterwards, through
  the finished pipeline (the queue, the door, the verifier and the
  projection).
- Each graduation deletes its lab folder (one implementation,
  [UR-16](UR-16-one-thing-for-everything.md)).

What is missing: not done yet. No lab is in this repository; it follows the
GitHub setup (P9.1).
