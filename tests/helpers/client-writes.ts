/**
 * THE WRITE-DOOR SCANNERS — one owner for "which `client.ts` calls change the
 * world, and which module owes the read-only assertion".
 *
 * WHY THIS EXISTS AS A SHARED MODULE
 *
 * `broker.action()` is the app's write door: it calls `assertLiveForWrite()`
 * before it records anything, so a write cannot fire while the user is looking
 * at a past instant (§6.2). That guarantee holds for every capability at once
 * precisely BECAUSE there is one door.
 *
 * A surface that calls a `client.ts` write function directly is not standing at
 * that door. It reaches the wire with no assertion at all, so a gesture aimed
 * from a view of 10:14:21 lands on the LIVE server — a write performed from a
 * screen that says it is only looking. That is the defect class these scanners
 * close.
 *
 * The scanners started life inside `tests/cockpit/flow-past-view-owner.test.ts`,
 * scoped to `flow/` + `computer/`. When the audit extended to `rooms/`, `desk/`
 * and `settings/`, copying them would have produced two write lists that could
 * disagree about what a write IS — and the day they disagreed, the tree with the
 * shorter list would go quietly green over a real bypass. One owner, two
 * consumers.
 *
 * @see src/data/asof.ts       — assertLiveForWrite, the rule itself
 * @see src/data/broker.ts     — action(), the door that normally applies it
 */

/**
 * `client.ts` functions that CHANGE SERVER STATE, and therefore may not run
 * from a past view.
 *
 * A module that imports one of these owes `assertLiveForWrite()` — and only
 * that module, because asserting at the innermost door covers every caller
 * above it. (`beginCockpitRun` in `flow/run-stream.ts` is exactly that shape:
 * it asserts, so `composer-router` is covered for the run itself and owes an
 * assertion only for the `createChat` it imports directly.)
 *
 * `tests/cockpit/*-past-view-owner` suites sanity-check every name against
 * `src/client.ts`, so a rename cannot silently empty this set and make the
 * guards pass by scanning for nothing.
 *
 * DELIBERATELY EXCLUDED, so the omissions are decisions and not oversights:
 *
 *   - SESSION verbs (`submitLogin`, `submitRegister`, `submitLogout`,
 *     `submitChangePassword`). These change who you are, not what the record
 *     says happened. Refusing them during a past view would trap a person
 *     signed in because they scrubbed the sweep — a worse outcome than the one
 *     the rule exists to prevent, and `boot/` owns that path regardless.
 *   - CLIENT-SIDE SCOPING (`scopeAutoChecks`, `scopeTimelineToChat`,
 *     `scopeTimelineToProject`, `resetTimelineScope`, `applyTimelineFilter`).
 *     They set which slice of the record is being LOOKED at. Nothing travels
 *     to the server as a change, and narrowing a view is the one thing a past
 *     view is for.
 *   - DEVICE-LOCAL preferences (cockpit density/theme, HORIZON monitor pins).
 *     They never reach `client.ts` at all — they are written to this browser's
 *     storage, carry no `asOf`, and are documented at their own call sites
 *     (`settings/local-prefs.ts`, `rooms/instruments-feed.ts`).
 */
export const CLIENT_WRITES: readonly string[] = [
  // projects + conversations
  "createProject",
  "deleteProject",
  "restoreProject",
  "renameProject",
  "updateProjectPath",
  "createChat",
  "renameChat",
  "setChatModel",
  "deleteChat",
  "restoreChat",
  "setChatPinned",
  "duplicateChat",
  // runs
  "startRun",
  "cancelRun",
  "steerRun",
  "steerCurrentRun",
  "sendUserMessage",
  "beginChatRun",
  // checks + memory
  "runProjectAutoCheck",
  "storeMemory",
  // tools + served schema
  "toggleTool",
  "executeSchemaAction",
  // filesystem
  "createFolder",
  "createEditorFile",
  "createEditorFolder",
  "writeEditorFile",
  "editEditorFile",
  "deleteEditorFile",
  "restoreRecycledFile",
  // install-wide preferences + safety
  "savePromptPrefs",
  "deletePromptPrefs",
  "saveModelPrefs",
  "triggerSafety",
  // install-wide tool servers (the MCP settings door — admin-gated writes)
  "saveMcpServer",
  "deleteMcpServer",
];

/**
 * The import specifiers a module pulls out of `client.ts`.
 *
 * Renames (`startRun as go`) resolve to the ORIGINAL name — the write is the
 * same write whatever the local binding is called — and `type` modifiers are
 * stripped so a type-only import is read as the type it is.
 */
export function clientImports(src: string): string[] {
  const out: string[] = [];
  const re = /import\s*\{([^}]*)\}\s*from\s*["'][^"']*client\.ts["']/g;
  for (const m of src.matchAll(re)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name.length > 0) out.push(name);
    }
  }
  return out;
}

/**
 * Whether a module that imports a raw client-side WRITE also asserts the
 * read-only rule.
 *
 * FILE-LEVEL ON PURPOSE. The point being enforced is that a module cannot pull
 * a write in without pulling the assertion in beside it; proving that each
 * individual call site refuses is what the RUNTIME tests in the owner suites
 * do. A file-level scan is the part that can be applied to a whole tree and
 * therefore closes the CLASS rather than the instances.
 *
 * Comments are stripped first, so a module that merely DESCRIBES a write
 * ("rollbackChat is a client.ts call…") is not asked for an assertion it has
 * no call to guard.
 */
export function writesWithoutAssertion(file: string, src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/[^\n]*/g, "$1");
  const writes = clientImports(code).filter((n) => CLIENT_WRITES.includes(n));
  if (writes.length === 0) return [];
  if (/\bassertLiveForWrite\s*\(/.test(code)) return [];
  return [
    `${file}: imports the client-side write(s) ${writes.join(", ")} with no assertLiveForWrite — ` +
      `nothing on that path passes the Broker's write door, so a past view could fire it`,
  ];
}
