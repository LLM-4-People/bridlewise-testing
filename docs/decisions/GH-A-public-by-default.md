---
id: GH-A
date: 2026-10-21
by: user
group: github
status: in-force
implementation: standing
---
# Public by default

An open project should be open to read: its code, its decisions and its
progress. So everything is public unless there is a reason it cannot be, and
the few private things are named as such.

The user's decision A of 2026-10-21 (GITHUB DECISIONS): public by default.

- Repositories, records and progress are public unless they must be private
  (credentials are never in a record at all:
  [D-09](D-09-credentials-never-in-repository-records.md)).
- The organization's plan is fixed by the user
  ([GH-U](GH-U-the-accepted-github-recommendations.md), U-1); a GitHub feature
  the plan does not include is recorded as unavailable, never assumed.

How it is enforced: it governs where work goes. The public secret gate
(the `secret-tree-scan` gate of the generated `.github/workflows/ci.yml`,
declared in `engine/src/workflow/gates/catalogue.ts`) keeps private material out of the
public tree; nothing yet decides a new repository's visibility from a
declared rule.
