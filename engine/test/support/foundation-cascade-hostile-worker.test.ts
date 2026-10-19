import test, { type TestContext } from "node:test";

import {
  executeFoundationCascadeFamily,
  type FoundationCascadeTestId,
} from "./foundation-cascade-test-catalog.ts";

function execute(id: FoundationCascadeTestId, context: TestContext): Promise<void> {
  return executeFoundationCascadeFamily(id, context);
}

test("[FC-C001] closed registry and exact output authority", (context) => execute("FC-C001", context));
test("[FC-C002] truthful blocked and unavailable production plan", (context) => execute("FC-C002", context));
test("[FC-C003] caller projection and authority claims forbidden", (context) => execute("FC-C003", context));
test("[FC-C004] plan candidate parser remains explicitly untrusted", (context) => execute("FC-C004", context));
test("[FC-C005] validated plan binds internal nominal issuer", (context) => execute("FC-C005", context));
test("[FC-C006] strict recursive unknown-field rejection", (context) => execute("FC-C006", context));
test("[FC-C007] plan stage and plan identities fail closed", (context) => execute("FC-C007", context));
test("[FC-C008] generation lock construction and validation unavailable", (context) => execute("FC-C008", context));
test("[FC-C009] generation lock claims and destinations rejected", (context) => execute("FC-C009", context));
test("[FC-C010] fatal UTF-8 duplicate-key and canonical-byte intake", (context) => execute("FC-C010", context));
test("[FC-S001] trap-free object candidate snapshots", (context) => execute("FC-S001", context));
test("[FC-S002] object exotics cycles sparse arrays and bounds rejected", (context) => execute("FC-S002", context));
test("[FC-S003] exact byte view shapes and immutable copy", (context) => execute("FC-S003", context));
test("[FC-S004] shared resizable detached and oversized bytes rejected", (context) => execute("FC-S004", context));
test("[FC-D001] UTF-8 ordering uses independent byte oracle", (context) => execute("FC-D001", context));
test("[FC-D002] locale timezone and insertion environment invariance", (context) => execute("FC-D002", context));
test("[FC-D003] terminal roots and dependency closure remain acyclic", (context) => execute("FC-D003", context));
test("[FC-B001] pure modular boundary and single protocol ownership", (context) => execute("FC-B001", context));
