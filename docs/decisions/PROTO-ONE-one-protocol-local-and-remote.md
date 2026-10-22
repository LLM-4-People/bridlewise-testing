---
id: PROTO-ONE
date: 2026-10-21
by: user
group: labs
status: in-force
implementation: pending
route: AC-7
---
# One protocol, local or remote

A separate fast path for a client on the same machine would be a second
protocol to build, secure and test, and the remote path would be the one that
gets less attention. So local and remote clients speak the same protocol,
through the same code.

The user, 2026-10-21: "i want one whether is local or remote".

- ONE protocol and ONE implementation for local and remote, over one stream
  transport (a Unix socket locally, TCP remotely), encrypted on both.
- No local-only fast path ([UR-16](UR-16-one-thing-for-everything.md)).
- The aim is to beat WebSocket on CPU per message, judged paired against
  WebSocket in the same session: the server writes interactive frames at
  commit, encodes once into one buffer, sends bursts with one system call,
  uses binary framing with no WebSocket masking or upgrade, and lets
  interactive frames jump ahead of bulk traffic.

What is missing: not in this repository yet. The protocol is developed in its
lab; it is carried out at the protocol's graduation (AC-7).
