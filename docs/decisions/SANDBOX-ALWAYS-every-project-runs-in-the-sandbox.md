---
id: SANDBOX-ALWAYS
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: pending
route: ST-1
---
# Everything runs in the sandbox

Building and running a project directly on the host gives it the host's
files, network and processes, and leaves no complete record of what it did.
Running every build, test and run in one sandbox gives control over it and a
single, precise source of measurements.

The user, 2026-10-10: "things should run in sandboxes, always, a whole
project whenever it needs to be built and run… to be able to control it
better, also because we would be able to evaluate it and its metrics much
easier because of all the instruments the sandboxe has".

- Every build, run, test and measurement of a project happens in the sandbox.
  The host gets one-way access to results (a web forward or proxy, a file
  export or read-only view, streamed logs and receipts). After the transfer
  this includes the harness's own builds and suites.
- The sandbox's instruments are the ONE source of run metrics: CPU time and
  memory peak, I/O, network, the process tree, syscalls and timing, recorded
  in each run's receipt. No second measurement path.
- It runs any UI whenever possible (a headless browser, a virtual display;
  screenshots, the accessibility tree and the console captured) and always
  captures what a model needs to diagnose a build or run. It works for any
  project, language, framework or dependency manager; where something truly
  cannot run, that is a named, typed refusal, never a silent gap.
- "the sandbox must really be powerful and be able to provide as many metrics
  as possible, with needle precision": every metric states its resolution and
  run-to-run noise, and judging prefers counts host load does not change.
  Deep instruments cost nothing when off.
- A UI app is redirected so both the user and the model can try it live, with
  every log and call tied to its actor and time.
- It hands the model only what matters by default (errors, anomalies, what
  changed), with the rest one query away, through a small, self-describing
  tool surface that works for weak models too.
- "thoroughly test it, ensure it is agnostic to as many things as possible":
  agnosticism is proven by a test matrix generated from one declared dimension
  table, never claimed.
- It is efficient and lightweight: startup, per-level overhead and footprint
  are measured against a bare run and only ratchet down.
- Opening a codebase detects what its sandbox needs and warms it (prompt or
  always, by setting); idle sandboxes are cleaned up after a configurable
  time.

What is missing: not built yet in this repository. The sandbox is developed
in its own lab; the existing confinement helper (`engine/guardian/`) is not
the sandbox this rule describes. The sandbox transfer (ST-1 and on) carries
it out.
