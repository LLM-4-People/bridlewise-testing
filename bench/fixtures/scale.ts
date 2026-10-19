/**
 * Reproducible SCALE FIXTURES.
 *
 * The premise: this app has only ever been exercised against ten-row test
 * data, and "no matter how many projects/files/chats we have" cannot be
 * verified against a ten-row fixture. This module builds realistic large
 * datasets that are BYTE-IDENTICAL on every run (seeded PRNG, no Date.now,
 * no randomUUID in the content path) so two benchmark runs measure the
 * code, not the data.
 *
 * Fixtures are built THROUGH `DbClient`, deliberately — not by raw SQL.
 * That means every row goes through the same Zod validation, the same
 * AES-256-GCM field encryption and the same statement path the product
 * uses, so generation time is itself an honest WRITE THROUGHPUT
 * measurement, and the resulting DB is exactly what the server would have
 * produced.
 *
 * Profiles (see `SCALE_PROFILES`):
 *   tiny   — what the existing test suite uses. The control.
 *   real   — one active user, a few months in.
 *   heavy  — one power user after a year, plus deep/wide file trees.
 *   fleet  — 50 users at `real` scale (the stated 50-user / 100-connection
 *            target), for concurrency and per-user isolation measurement.
 *
 * Generated DBs land in `bench/.fixtures/<profile>.db` and are CACHED: a
 * rebuild only happens when the profile spec changes (the spec hash is
 * stored beside the db) or `--rebuild` is passed. Building `heavy` is
 * minutes of work; re-building it per bench run would make the harness
 * unusable and nobody would run it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

import { DbClient } from "../../server/db/client.ts";
import { admitKeyHome, type AdmittedKeyHome } from "../../engine/src/filesystem/self-protection/key-home.ts";
import { FIXTURE_ID_HEX_CHARS } from "../bench-config.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";

// ── Deterministic PRNG ──────────────────────────────────────────────────
// mulberry32: 32-bit, fast, good enough for content shape. Seeded per
// profile so `heavy` is the same corpus on every machine.

export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ── Content corpus ──────────────────────────────────────────────────────
// Realistic message shapes: short user turns, long assistant turns with
// code fences, tool calls with large outputs. Message SIZE distribution
// matters more than message text — payload weight is a first-class subject
// of this benchmark.

const WORDS = [
  "the", "server", "route", "handler", "ledger", "effect", "recorded", "trace",
  "registry", "declared", "coverage", "beat", "flow", "sweep", "desk", "horizon",
  "project", "chat", "message", "tool", "call", "stream", "chunk", "token",
  "budget", "latency", "concurrent", "connection", "user", "workspace", "device",
  "encrypt", "decrypt", "index", "query", "transaction", "commit", "rollback",
  "because", "therefore", "however", "which", "means", "that", "should", "must",
];

function lorem(rng: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(pick(rng, WORDS));
  const s = out.join(" ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

const CODE_FENCE = [
  "```ts",
  "export function handle(req: Request, db: DbClient): Response {",
  "  const rows = db.listMessages(chatId, userId);",
  "  return json(rows.map(project));",
  "}",
  "```",
].join("\n");

/**
 * Message content generator with a realistic heavy tail: most turns are
 * small, a minority are very large. A benchmark over uniformly-small
 * messages understates payload cost badly.
 */
function messageContent(rng: () => number, role: string): string {
  const roll = rng();
  if (role === "user") {
    return lorem(rng, intBetween(rng, 5, 60));
  }
  if (roll < 0.55) return lorem(rng, intBetween(rng, 40, 160));
  if (roll < 0.9) {
    return `${lorem(rng, intBetween(rng, 80, 300))}\n\n${CODE_FENCE}\n\n${lorem(rng, intBetween(rng, 40, 200))}`;
  }
  // The tail: a long analytical turn with several code blocks.
  const parts: string[] = [];
  for (let i = 0; i < intBetween(rng, 4, 10); i++) {
    parts.push(lorem(rng, intBetween(rng, 100, 400)));
    parts.push(CODE_FENCE);
  }
  return parts.join("\n\n");
}

/** Tool output with a realistic tail — file reads and greps get big. */
function toolOutput(rng: () => number): unknown {
  const roll = rng();
  if (roll < 0.6) return { ok: true, text: lorem(rng, intBetween(rng, 20, 200)) };
  if (roll < 0.9) {
    const lines: string[] = [];
    for (let i = 0; i < intBetween(rng, 50, 400); i++) {
      lines.push(`src/lib/${pick(rng, WORDS)}/${pick(rng, WORDS)}.ts:${i}: ${lorem(rng, 8)}`);
    }
    return { ok: true, text: lines.join("\n") };
  }
  // The tail: a whole-file read.
  const lines: string[] = [];
  for (let i = 0; i < intBetween(rng, 800, 3000); i++) lines.push(`  ${lorem(rng, 10)}`);
  return { ok: true, text: lines.join("\n") };
}

// ── Profiles ────────────────────────────────────────────────────────────

export type ScaleProfile = {
  readonly name: string;
  readonly seed: number;
  readonly users: number;
  readonly projectsPerUser: number;
  readonly chatsPerProject: number;
  /** Mean messages per chat; actual is drawn around this with a long tail. */
  readonly messagesPerChat: number;
  /** Fraction of assistant messages that carry a tool call. */
  readonly toolCallRate: number;
  /** Timeline refs per chat (the sweep/timeline read path). */
  readonly timelineRefsPerChat: number;
  /** Metrics snapshots per chat. */
  readonly metricsPerChat: number;
  readonly description: string;
};

export const SCALE_PROFILES: Record<string, ScaleProfile> = {
  tiny: {
    name: "tiny",
    seed: 1,
    users: 1,
    projectsPerUser: 2,
    chatsPerProject: 3,
    messagesPerChat: 10,
    toolCallRate: 0.3,
    timelineRefsPerChat: 5,
    metricsPerChat: 2,
    description: "the control — roughly what the existing test suite uses",
  },
  real: {
    name: "real",
    seed: 2,
    users: 1,
    projectsPerUser: 6,
    chatsPerProject: 40,
    messagesPerChat: 60,
    toolCallRate: 0.45,
    timelineRefsPerChat: 40,
    metricsPerChat: 10,
    description: "one active user a few months in — 240 chats, ~14k messages",
  },
  heavy: {
    name: "heavy",
    seed: 3,
    users: 1,
    projectsPerUser: 20,
    chatsPerProject: 150,
    messagesPerChat: 90,
    toolCallRate: 0.5,
    timelineRefsPerChat: 60,
    metricsPerChat: 15,
    description: "one power user after a year — 3000 chats, ~270k messages",
  },
  fleet: {
    name: "fleet",
    seed: 4,
    users: 50,
    projectsPerUser: 5,
    chatsPerProject: 20,
    messagesPerChat: 50,
    toolCallRate: 0.4,
    timelineRefsPerChat: 20,
    metricsPerChat: 5,
    description: "the stated target — 50 users, 250 projects, 5000 chats",
  },
};

/** One long conversation inside `heavy`, so the scroll path has a worst case. */
const MEGA_CHAT_MESSAGES = 20_000;

/**
 * THE WRITE SINK — the one chat a benchmark is allowed to append to.
 *
 * ── The defect this exists to make impossible ──
 *
 * Write benches append real messages through `DbClient`, which is the point:
 * generation and measurement go through the product's own path. But the
 * chats they were appending to were the SAME chats the read benches read.
 * `concurrency.bench.ts` read `chatIds[1500]` in C1 and then wrote ~257
 * messages into `chatIds[1500]` in C2/C3; `writepath.bench.ts` wrote into
 * `chatIds[0]`, which in `heavy` is the 20,000-message mega chat that
 * `db.bench.ts`, `payload.bench.ts` and `redaction.bench.ts` all read.
 *
 * So every run made the next run's READ measurement worse, permanently and
 * cumulatively. Measured on the fixture as found: the concurrency read target
 * held **1,412 messages** while its five neighbours held 46, 105, 106, 111 and
 * 167 — it had grown ~12.7× beyond its generated size. That read the same way
 * a product regression reads: `getChatHistory.concurrent` p50 at n=1 went
 * 13.23ms → 23.81ms across a wave that never touched the read path. It was the
 * instrument eating its own fixture.
 *
 * Worse, it hid: the whole-DB count moved only 346,928 → 356,058 (2.6%),
 * because all the growth landed in one chat. And the largest `db` read case is
 * named by its row count, so it arrived with a DIFFERENT NAME every run
 * (`[22525 messages]` → `[26455 messages]` → `[27860 messages]`) and
 * `diffReports` — which keys on `suite/name[scale]` — silently had nothing to
 * compare it against. A regression guard that cannot find its own baseline
 * reports no regression.
 *
 * The rule, now structural rather than remembered: **a bench writes to
 * `writeSinkChatIds`, and reads from `chatIds` / `megaChatId`. The two sets
 * are disjoint.** `tests/prevention/bench-fixture-drift.test.ts` fails if a
 * bench writes anywhere else, and `assertReadTargetsPristine` below fails a
 * run whose fixture has already drifted, so a poisoned number can never again
 * be reported as a product figure.
 */
const WRITE_SINK_TITLE = "bench write sink — never read, only appended to";
/** Messages generated into the sink, so it is a realistic chat and not empty. */
const WRITE_SINK_MESSAGES = 40;

export type FixtureHandle = {
  readonly profile: ScaleProfile;
  readonly dbPath: string;
  readonly db: DbClient;
  /** userId → the ids needed to drive reads. `chatIds` is the READ population
   * and never contains the write sink. */
  readonly users: ReadonlyArray<{
    readonly userId: string;
    readonly projectIds: readonly string[];
    readonly chatIds: readonly string[];
    /** The one chat this user's write benches may append to. */
    readonly writeSinkChatId: string;
  }>;
  /** The single largest chat, for worst-case history reads. */
  readonly megaChatId: string | null;
  /** Message counts of the READ targets as generated. `assertReadTargetsPristine`
   * compares against these, so drift is caught rather than measured. */
  readonly readTargetCounts: Readonly<Record<string, number>>;
  readonly counts: {
    readonly projects: number;
    readonly chats: number;
    readonly messages: number;
    readonly toolCalls: number;
    readonly timelineRefs: number;
    readonly metrics: number;
  };
  readonly dbFileBytes: number;
  readonly buildMs: number;
  close(): void;
};

export const FIXTURE_DIR = join(process.cwd(), "bench", ".fixtures");

/**
 * THE KEY HOME OF A FIXTURE FOLDER — `<folder>-keys`, beside it and never
 * inside it (a key home shares nothing with its databases' folder). Every
 * fixture database of one folder shares that folder's one key.
 */
export function fixtureKeyHome(fixtureDir: string = FIXTURE_DIR): AdmittedKeyHome {
  return admitKeyHome(`${fixtureDir}-keys`, [{ path: fixtureDir, what: "the fixture folder" }]);
}

function specHash(profile: ScaleProfile): string {
  return createHash("sha256")
    .update(
      JSON.stringify(profile) +
        `|mega=${MEGA_CHAT_MESSAGES}|sink=${WRITE_SINK_MESSAGES}|v4`,
    )
    .digest("hex")
    .slice(0, FIXTURE_ID_HEX_CHARS);
}

/**
 * The chats a read bench is allowed to measure, named in ONE place.
 *
 * Every read case picks its target from here and every write case writes to
 * `writeSinkChatId`, which is how the two sets are kept disjoint. Naming them
 * centrally is also what lets `assertReadTargetsPristine` know which counts to
 * check without re-counting 3,000 chats.
 */
export function benchReadTargets(fx: {
  readonly users: FixtureHandle["users"];
  readonly megaChatId: string | null;
}): readonly string[] {
  const user = fx.users[0];
  if (!user) return [];
  const ids = new Set<string>();
  if (fx.megaChatId !== null) ids.add(fx.megaChatId);
  const first = user.chatIds[0];
  if (first !== undefined) ids.add(first);
  const mid = user.chatIds[Math.floor(user.chatIds.length / 2)];
  if (mid !== undefined) ids.add(mid);
  return [...ids];
}

/**
 * FAIL THE RUN IF THE FIXTURE HAS DRIFTED, rather than reporting a number
 * measured against data nobody generated.
 *
 * Called by every suite at start-up. It compares the READ targets' message
 * counts against what the generator recorded; a mismatch means something
 * appended to a chat a bench reads, so the read figures are not comparable
 * with any earlier run and must not be published as if they were. The remedy
 * is stated in the error rather than left to be rediscovered.
 */
export function assertReadTargetsPristine(fx: FixtureHandle): void {
  const user = fx.users[0];
  if (!user) return;
  const drifted: string[] = [];
  for (const [chatId, expected] of Object.entries(fx.readTargetCounts)) {
    const actual = fx.db.countMessages(chatId, user.userId);
    if (actual !== expected) drifted.push(`${chatId}: ${expected} generated → ${actual} now`);
  }
  if (drifted.length > 0) {
    throw new Error(
      `bench fixture "${fx.profile.name}" has DRIFTED — a read target grew since it was ` +
        `generated, so its read figures are not comparable with any earlier run:\n  ` +
        drifted.join("\n  ") +
        `\nA bench appended to a chat a bench reads. Write benches must target ` +
        `users[i].writeSinkChatId. Rebuild with: ` +
        `node --experimental-strip-types bench/fixtures/scale.ts ${fx.profile.name} --rebuild`,
    );
  }
}

/**
 * Build (or reuse) a fixture DB for `profile`.
 *
 * Reuse rule: the sidecar `<profile>.spec` holds the spec hash. If it
 * matches, the existing db file is opened as-is. Any change to the profile
 * or to this generator's version tag forces a rebuild — a cached fixture
 * that no longer matches its spec would silently invalidate every number.
 */
export function buildFixture(
  profileName: string,
  options: {
    readonly rebuild?: boolean;
    readonly quiet?: boolean;
    /** Where the fixture lives. Defaults to the shared `bench/.fixtures`.
     * A test that MUTATES a fixture must pass its own directory — writing to
     * the shared one is the drift this module exists to prevent, and a
     * drift test that drifts the real fixture would be the joke version of
     * itself. */
    readonly dir?: string;
  } = {},
): FixtureHandle {
  const profile = SCALE_PROFILES[profileName];
  if (!profile) {
    throw new Error(
      `unknown scale profile "${profileName}" (have: ${Object.keys(SCALE_PROFILES).join(", ")})`,
    );
  }
  const fixtureDir = options.dir ?? FIXTURE_DIR;
  mkdirSync(fixtureDir, { recursive: true });
  const dbPath = join(fixtureDir, `${profile.name}.db`);
  const specPath = join(fixtureDir, `${profile.name}.spec.json`);
  const hash = specHash(profile);

  const cached =
    !options.rebuild &&
    existsSync(dbPath) &&
    existsSync(specPath) &&
    (JSON.parse(readFileSync(specPath, "utf8")) as { hash?: string; manifest?: unknown }).hash === hash;

  if (cached) {
    const sidecar = JSON.parse(readFileSync(specPath, "utf8")) as {
      hash: string;
      manifest: Omit<FixtureHandle, "db" | "close" | "profile" | "dbPath">;
    };
    const db = new DbClient({ path: dbPath, keyHome: fixtureKeyHome(fixtureDir) });
    if (!options.quiet) {
      console.log(
        `fixture ${profile.name}: reused (${sidecar.manifest.counts.messages} messages, ` +
          `${(sidecar.manifest.dbFileBytes / 1024 / 1024).toFixed(1)}MB)`,
      );
    }
    const handle = { ...sidecar.manifest, profile, dbPath, db, close: () => db.close() };
    // A REUSED fixture is the one that can have drifted, so it is the one that
    // gets checked. A freshly built fixture is pristine by construction.
    assertReadTargetsPristine(handle);
    return handle;
  }

  // Rebuild from scratch — remove the db AND its wal/shm so no stale pages
  // survive into a fixture that claims a different spec.
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${suffix}`;
    if (existsSync(p)) rmSync(p);
  }

  const t0 = process.hrtime.bigint();
  const db = new DbClient({ path: dbPath, keyHome: fixtureKeyHome(fixtureDir) });
  const rng = makeRng(profile.seed);

  let nProjects = 0;
  let nChats = 0;
  let nMessages = 0;
  let nToolCalls = 0;
  let nTimeline = 0;
  let nMetrics = 0;
  let megaChatId: string | null = null;

  const users: Array<{
    userId: string;
    projectIds: string[];
    chatIds: string[];
    writeSinkChatId: string;
  }> = [];

  for (let u = 0; u < profile.users; u++) {
    const username = `bench-u${u}`;
    const user = db.getUserByUsername(username) ?? db.createUser(username, `hash-${u}`);
    const entry = {
      userId: user.id,
      projectIds: [] as string[],
      chatIds: [] as string[],
      writeSinkChatId: "",
    };
    users.push(entry);

    for (let p = 0; p < profile.projectsPerUser; p++) {
      // Each project write is its own transaction; the message bulk below
      // is batched, which is where the time actually goes.
      const project = db.createProject(
        { name: `bench ${profile.name} p${p} u${u}`, path: `/bench/${profile.name}/u${u}/p${p}` },
        user.id,
      );
      nProjects++;
      entry.projectIds.push(project.id);

      db.withTransaction(() => {
        for (let c = 0; c < profile.chatsPerProject; c++) {
          const chat = db.createChat(
            { project_id: project.id, title: lorem(rng, intBetween(rng, 3, 9)) },
            user.id,
          );
          nChats++;
          entry.chatIds.push(chat.id);

          const isMega = u === 0 && p === 0 && c === 0 && profile.name === "heavy";
          if (isMega) megaChatId = chat.id;
          const msgCount = isMega
            ? MEGA_CHAT_MESSAGES
            : Math.max(2, Math.round(profile.messagesPerChat * (0.4 + rng() * 1.6)));

          const runId = `run-${profile.seed}-${p}-${c}`;
          for (let m = 0; m < msgCount; m++) {
            const role = m % 2 === 0 ? "user" : "assistant";
            const message = db.createMessage(
              {
                chat_id: chat.id,
                role,
                content: messageContent(rng, role),
                run_id: runId,
                metadata: { tokens: { input: intBetween(rng, 100, 8000), output: intBetween(rng, 10, 2000) } },
              },
              user.id,
            );
            nMessages++;
            if (role === "assistant" && rng() < profile.toolCallRate) {
              db.createToolCall(
                {
                  message_id: message.id,
                  tool_name: pick(rng, ["read_file", "grep", "bash", "edit", "list_dir"]),
                  input: { path: `src/lib/${pick(rng, WORDS)}.ts`, pattern: pick(rng, WORDS) },
                  output: toolOutput(rng),
                  status: "done",
                  duration_ms: intBetween(rng, 2, 4000),
                },
                user.id,
              );
              nToolCalls++;
            }
          }
          for (let t = 0; t < profile.timelineRefsPerChat; t++) {
            db.createTimelineRef(
              {
                chat_id: chat.id,
                event_id: `evt-${profile.seed}-${p}-${c}-${t}`,
                event_type: pick(rng, ["tool.call", "model.turn", "check.status", "file.write", "git.commit"]),
                timestamp: new Date(Date.UTC(2026, 0, 1) + (t + c * 1000) * 60_000).toISOString(),
                metadata: { detail: lorem(rng, intBetween(rng, 10, 80)) },
              },
              user.id,
            );
            nTimeline++;
          }
          for (let s = 0; s < profile.metricsPerChat; s++) {
            db.createMetricsSnapshot(
              { chat_id: chat.id, snapshot: { tokens: intBetween(rng, 1000, 90000), cost: rng() * 4 } },
              user.id,
            );
            nMetrics++;
          }
        }
      });
      if (!options.quiet) {
        process.stdout.write(
          `\r  building ${profile.name}: ${nProjects} projects, ${nChats} chats, ${nMessages} messages…`,
        );
      }
    }

    // THE WRITE SINK, one per user — the only chat a bench may append to.
    // Created last so it is never `chatIds[0]` or `chatIds[len/2]`, the two
    // positions read benches pick from, and deliberately kept OUT of
    // `chatIds` so a read case cannot select it even by accident.
    const sinkProject = entry.projectIds[0];
    if (sinkProject !== undefined) {
      const sink = db.createChat({ project_id: sinkProject, title: WRITE_SINK_TITLE }, user.id);
      entry.writeSinkChatId = sink.id;
      nChats++;
      db.withTransaction(() => {
        for (let m = 0; m < WRITE_SINK_MESSAGES; m++) {
          const role = m % 2 === 0 ? "user" : "assistant";
          db.createMessage(
            { chat_id: sink.id, role, content: messageContent(rng, role), run_id: `run-sink-${u}` },
            user.id,
          );
          nMessages++;
        }
      });
    }
  }
  if (!options.quiet) process.stdout.write("\n");

  const buildMs = Number(process.hrtime.bigint() - t0) / 1_000_000;
  const dbFileBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;

  const readTargetCounts: Record<string, number> = {};
  {
    const userId = users[0]?.userId;
    if (userId !== undefined) {
      for (const chatId of benchReadTargets({ users, megaChatId })) {
        readTargetCounts[chatId] = db.countMessages(chatId, userId);
      }
    }
  }

  const manifest = {
    users: users.map((u) => ({
      userId: u.userId,
      projectIds: u.projectIds,
      chatIds: u.chatIds,
      writeSinkChatId: u.writeSinkChatId,
    })),
    megaChatId,
    readTargetCounts,
    counts: {
      projects: nProjects,
      chats: nChats,
      messages: nMessages,
      toolCalls: nToolCalls,
      timelineRefs: nTimeline,
      metrics: nMetrics,
    },
    dbFileBytes,
    buildMs,
  };
  mkdirSync(dirname(specPath), { recursive: true });
  writeFileSync(specPath, JSON.stringify({ hash, profile, manifest }, null, 2), "utf8");

  if (!options.quiet) {
    console.log(
      `fixture ${profile.name}: built in ${(buildMs / 1000).toFixed(1)}s — ` +
        `${nMessages} messages, ${nToolCalls} tool calls, ${(dbFileBytes / 1024 / 1024).toFixed(1)}MB ` +
        `(${((nMessages / buildMs) * 1000).toFixed(0)} msg/s write throughput)`,
    );
  }

  return { ...manifest, profile, dbPath, db, close: () => db.close() };
}

/** CLI: `node --experimental-strip-types bench/fixtures/scale.ts heavy [--rebuild]` */
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const name = process.argv[2] ?? "real";
  const rebuild = process.argv.includes("--rebuild");
  const h = buildFixture(name, { rebuild });
  console.log(JSON.stringify(h.counts, null, 2));
  h.close();
}
