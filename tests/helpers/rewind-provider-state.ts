/**
 * The provider recorder shared by the split rewind suites.
 *
 * `vi.mock` in each test file reads this module from its factory, so every
 * split file drives the same measurement point without a second request
 * shape. The harness sets `reply` per turn and reads `requests` after a run.
 */
export type RewindRequest = ReadonlyArray<{ role: string; content: string }>;
export type RewindProvider = { requests: RewindRequest[]; reply: string };

export const rewindProvider: RewindProvider = {
  requests: [] as RewindRequest[],
  reply: "an answer",
};
