---
id: NO-BRANDED-NAMES
date: 2026-10-10
by: user
group: user-rules
status: in-force
implementation: standing
---
# No branded module names; no needless packages

A product-style name tells a newcomer nothing about what the code does, and
every extra package adds versioning, release and build work. So a module is
named plainly by what it does and lives inside the package that owns it.

The user, 2026-10-10: "we dont usually name module and separate from the app
unless it must be, like the web, app, docs".

- A module is part of the package that owns it and is named plainly by what it
  does: "intent prediction", "the protocol", "the compression codec". Never a
  product-style name.
- A separate package, crate, binary or top-level folder needs a stated reason
  it MUST be separate (a different runtime, platform or ship target). The
  separate packages today are the server and web, the app and the docs.
- Retroactive: specs are renamed now; lab code is renamed at its next round
  boundary (never in the middle of a measurement); historical reports stay as
  written.

How it is enforced: by review. No mechanical guard yet: nothing checks a new
module's name or refuses a new top-level package without its stated reason.
