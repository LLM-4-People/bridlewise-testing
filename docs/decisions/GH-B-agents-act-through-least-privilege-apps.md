---
id: GH-B
date: 2026-10-21
by: user
group: github
status: in-force
implementation: pending
route: P3.9
---
# Agents act only through least-privilege GitHub Apps

A personal owner token left on a development machine can do anything to the
whole organization, and every agent that can read it can too. So once GitHub
is set up, that token leaves the machine, and agents act only through GitHub
Apps that each hold just the permissions their role needs.

The user's decision B of 2026-10-21 (GITHUB DECISIONS):

- The owner credential leaves the development host after setup.
- Agents act only through least-privilege GitHub Apps (one per role: the
  door, the verifier, the publisher;
  [GITHUB-200](GITHUB-200-exploit-github-fully.md)).
- Two-factor authentication is required for the organization.

What is missing: not done yet. The Apps and their manifests do not exist
yet (P1.2), and the owner credential's removal is the setup's last user step
(P3.9).
