---
id: ONE-IMPL-PROBE
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: standing
---
# One implementation for every platform: probe, don't branch

Code with a branch per operating system or Linux flavor has to be written,
tested and fixed once per branch, and the branches drift. So Bridlewise has
one implementation, and every difference between hosts is found at runtime by
asking the host what it can do.

The user, 2026-10-10: "ideally i dont want to duplicate work and maintenance,
we should have one package that supports linux no matter what flavor, type,
etc, app is multi platform but same principle", and the correction: "one
implementation at all, not one for every kind".

- ONE implementation, full stop: the same code serves every Linux flavor
  (native, WSL, any distribution) and every platform the app runs on. Never
  write per-host or per-platform code paths.
- Every difference is decided by a runtime capability PROBE, recorded and
  exposed as a signal, with a named, typed refusal when a capability is
  missing ([UR-17](UR-17-no-fallbacks.md)).
- Hosts and platforms appear only as dimensions of the test matrix.

How it is enforced: by review only. No mechanical guard yet: nothing refuses
a new per-platform branch, and the test matrix has no host dimension yet.
