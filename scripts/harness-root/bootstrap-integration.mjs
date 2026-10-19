// bootstrap-integration.mjs — One-time helper to seed integration/ from candidate/.
//
// This is a thin convenience wrapper around `merge-round.mjs --bootstrap`.
// It exists so the bootstrap step is discoverable by name + documented in
// one place. The real logic lives in merge-round.mjs (reused, not duplicated).
//
// Usage:
//   node scripts/bootstrap-integration.mjs              # seed if empty
//   node scripts/bootstrap-integration.mjs --force      # overwrite existing
//
// Binding: this is a ONE-TIME operation. After bootstrap, all rounds copy
// FROM integration/ (never from candidate/). See WORKFLOW.md.

import { bootstrapIntegration } from "./merge-round.mjs";

const args = process.argv.slice(2);
const force = args.includes("--force");
try {
  const res = bootstrapIntegration({ force });
  console.log(JSON.stringify(res, null, 2));
  process.exit(res.bootstrapped ? 0 : 1);
} catch (e) {
  console.error(JSON.stringify({ bootstrapped: false, error: e.message }, null, 2));
  process.exit(1);
}
