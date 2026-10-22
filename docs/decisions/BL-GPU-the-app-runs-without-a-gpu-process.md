---
id: BL-GPU
date: 2026-10-15
by: user
group: labs
status: in-force
implementation: pending
route: BL-GPU
---
# The app runs with no GPU process

The browser lab's review found the desktop app's GPU process running outside
the browser's sandbox on the development host. Rather than ship an
unconfined process, the app renders in software and no GPU process is started
at all.

The user, 2026-10-15: "run the app with no GPU process".

- The app (release, devtools and test drives) runs without a GPU process,
  using software rendering.
- A GPU process that appears fails the smoke test, the receipt and the
  qualification, by name.
- Why the browser's GPU sandbox fails on that host is a separate, owned
  investigation.

What is missing: not in this repository yet. The desktop app is developed in
the browser lab, which carries it out; it reaches this repository when the lab
graduates ([GH-C](GH-C-all-labs-merge-into-the-one-repository.md)).
