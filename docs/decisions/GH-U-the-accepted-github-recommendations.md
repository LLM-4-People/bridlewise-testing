---
id: GH-U
date: 2026-10-21
by: user
group: github
status: in-force
implementation: pending
route: P3.2
covers: [GH-U1, GH-U3, GH-U4, GH-U5, GH-U6, GH-U7]
---
# The accepted GitHub recommendations

The GitHub design asked the user a short list of questions. These are the
answers, so nobody has to ask them again: what the organization's plan is, how
many repositories there are, where a person still has to act, what is not
done yet, and how contributors sign their work.

The user's decisions of 2026-10-21 (GITHUB DECISIONS: "U-1: Team only",
"U-3..U-7: accepted"):

- **U-1:** the organization stays on its current plan only (GitHub Team); a
  feature outside it is recorded as unavailable, never assumed.
- **U-3:** one repository.
- **U-4:** a human step remains only for installing a rotated App key.
- **U-5:** no npm package and no Sponsors yet.
- **U-6:** no Codespaces prebuilds.
- **U-7:** contributions are signed off under the Developer Certificate of
  Origin (DCO), not a contributor licence agreement.

U-7 is enforced at the two lowest doors
(`engine/scripts/verification/sign-off.ts`). The `commit-msg` hook refuses
any commit, merges included, whose message carries no `Signed-off-by` naming
its committer. The `Commit records` check
(`.github/workflows/commit-records.yml`, a required status check) refuses a
pull request or merge group that brings such a commit; only the merge
queue's own first-parent merges go unjudged, and no committer name exempts
anything. A push is not judged by a workflow: every commit reaches main
through a pull request and the queue. An agent commit carries no personal
identity at all ([GH-IDENTITY](GH-IDENTITY-an-agent-commit-carries-no-personal-identity.md)).
What is missing: a `pull_request` run uses the branch's copy of the
workflow until the door App (#67) runs main's code out-of-band (P3.2), and
the one-repository rename is not done yet (P1.10). U-5 and
U-6 are choices not to build something, and hold as they are.
