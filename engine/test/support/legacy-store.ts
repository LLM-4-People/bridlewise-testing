import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { deepFreeze } from "../../src/kernel/integrity.ts";
import { NotFoundError, RequestBusyError, StoreError, TransitionError, VersionError } from "./legacy-errors.ts";
import {
  LEGACY_STATE_INVARIANTS,
  prepareState,
  revalidateStateBoundary,
  type StateLocation,
} from "./legacy-state-boundary.ts";
import { requireText } from "./legacy-text-validation.ts";

/** Immutable v1 migration contract; unreachable from the S1 CLI composition. */
const LEGACY_STORE_INVARIANTS = deepFreeze({
  schemaVersion: 1,
  busyTimeoutMs: 5_000,
  executionLeaseMs: 180_000,
});

export type RequestStatus = "open" | "completed" | "failed";

export type SessionRecord = Readonly<{
  id: string;
  createdAt: number;
}>;

export type RequestRecord = Readonly<{
  id: string;
  sessionId: string;
  ordinal: number;
  prompt: string;
  workspaceRoot: string | null;
  status: RequestStatus;
  result: string | null;
  createdAt: number;
  finishedAt: number | null;
}>;

export type RequestContext = Readonly<Pick<
  RequestRecord,
  "id" | "sessionId" | "prompt" | "workspaceRoot"
>>;

export type WaitRecord = Readonly<{
  id: string;
  requestId: string;
  ordinal: number;
  question: string;
  answer: string | null;
  createdAt: number;
  answeredAt: number | null;
}>;

export type ResumeState =
  | Readonly<{ state: "ready"; requestId: string; answer: string | null }>
  | Readonly<{ state: "waiting"; requestId: string; wait: WaitRecord }>
  | Readonly<{ state: "terminal"; requestId: string; status: Exclude<RequestStatus, "open">; result: string }>;

export type ExecutionState =
  | Readonly<{
    state: "claimed";
    sessionId: string;
    requestId: string;
    prompt: string;
    workspaceRoot: string | null;
    answer: string | null;
    runToken: string;
  }>
  | Readonly<{ state: "waiting"; sessionId: string; requestId: string; wait: WaitRecord }>
  | Readonly<{
    state: "terminal";
    sessionId: string;
    requestId: string;
    status: Exclude<RequestStatus, "open">;
    result: string;
  }>;

export type SessionSnapshot = Readonly<{
  session: SessionRecord;
  requests: readonly Readonly<RequestRecord & { waits: readonly WaitRecord[] }>[];
}>;

type Row = Record<string, unknown>;

const SCHEMA_V1_OBJECTS = [
  {
    type: "table",
    name: "sessions",
    tableName: "sessions",
    sql: `CREATE TABLE sessions (
    id TEXT PRIMARY KEY NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  },
  {
    type: "table",
    name: "requests",
    tableName: "requests",
    sql: `CREATE TABLE requests (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    prompt TEXT NOT NULL CHECK (prompt <> ''),
    workspace_root TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'completed', 'failed')),
    result TEXT CHECK (result IS NULL OR result <> ''),
    run_token TEXT,
    run_expires_at INTEGER,
    created_at INTEGER NOT NULL,
    finished_at INTEGER,
    UNIQUE (session_id, ordinal),
    CHECK (
      (status = 'open' AND result IS NULL AND finished_at IS NULL) OR
      (status IN ('completed', 'failed') AND result IS NOT NULL AND finished_at IS NOT NULL)
    ),
    CHECK (
      (run_token IS NULL AND run_expires_at IS NULL) OR
      (run_token IS NOT NULL AND run_token <> '' AND run_expires_at IS NOT NULL)
    )
  ) STRICT`,
  },
  {
    type: "table",
    name: "user_waits",
    tableName: "user_waits",
    sql: `CREATE TABLE user_waits (
    id TEXT PRIMARY KEY NOT NULL,
    request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    question TEXT NOT NULL CHECK (question <> ''),
    answer TEXT CHECK (answer IS NULL OR answer <> ''),
    created_at INTEGER NOT NULL,
    answered_at INTEGER,
    UNIQUE (request_id, ordinal),
    CHECK (
      (answer IS NULL AND answered_at IS NULL) OR
      (answer IS NOT NULL AND answered_at IS NOT NULL)
    )
  ) STRICT`,
  },
  {
    type: "index",
    name: "one_open_request_per_session",
    tableName: "requests",
    sql: `CREATE UNIQUE INDEX one_open_request_per_session
    ON requests(session_id) WHERE status = 'open'`,
  },
  {
    type: "index",
    name: "one_unanswered_wait_per_request",
    tableName: "user_waits",
    sql: `CREATE UNIQUE INDEX one_unanswered_wait_per_request
    ON user_waits(request_id) WHERE answer IS NULL`,
  },
] as const;

const SCHEMA_V1 = SCHEMA_V1_OBJECTS.map((object) => `${object.sql};`).join("\n");

export class Store {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(location: StateLocation) {
    const preparedState = prepareState(location);
    this.databasePath = location.databasePath;
    try {
      closeSync(openSync(location.databasePath, "wx", LEGACY_STATE_INVARIANTS.databaseMode));
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stateBeforeOpen = revalidateStateBoundary(location, preparedState, true);
    this.database = new DatabaseSync(location.databasePath, {
      timeout: LEGACY_STORE_INVARIANTS.busyTimeoutMs,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
    });
    try {
      revalidateStateBoundary(location, stateBeforeOpen);
      this.database.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
      this.initializeSchema();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  createSession(): SessionRecord {
    return this.writeTransaction(() => {
      const session = { id: randomUUID(), createdAt: Date.now() };
      this.database.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)")
        .run(session.id, session.createdAt);
      return session;
    });
  }

  submitRequest(sessionId: string, prompt: string, workspaceRoot?: string): RequestRecord {
    requireText(sessionId);
    requireText(prompt);
    if (workspaceRoot !== undefined) requireText(workspaceRoot);
    return this.writeTransaction(() => {
      const request = this.createRequest(sessionId, prompt, workspaceRoot ?? null);
      if (request) return request;
      if (!this.getSession(sessionId)) throw new NotFoundError("Session not found");
      throw new TransitionError("Session already has an open request");
    });
  }

  waitForUser(requestId: string, question: string, runToken: string | null = null): WaitRecord {
    requireText(requestId);
    requireText(question);
    if (runToken !== null) requireText(runToken);
    return this.writeTransaction(() => {
      const now = Date.now();
      const wait = this.createWait(requestId, question, runToken, now);
      if (wait) {
        this.clearClaim(requestId, runToken, now);
        return wait;
      }
      const request = this.getRequest(requestId);
      if (!request) throw new NotFoundError("Request not found");
      if (request.status !== "open") throw new TransitionError("Terminal request cannot wait");
      if (!this.ownsClaim(requestId, runToken, now)) {
        throw new RequestBusyError(request.sessionId, requestId);
      }
      throw new TransitionError("Request already has an unanswered wait");
    });
  }

  answerWait(waitId: string, answer: string): WaitRecord {
    requireText(waitId);
    requireText(answer);
    return this.writeTransaction(() => {
      const changes = this.database.prepare(`
        UPDATE user_waits SET answer = ?, answered_at = ?
        WHERE id = ? AND answer IS NULL
      `).run(answer, Date.now(), waitId).changes;
      if (changes !== 0) return this.getWait(waitId)!;
      if (!this.getWait(waitId)) throw new NotFoundError("Wait not found");
      throw new TransitionError("Wait was already answered");
    });
  }

  finishRequest(
    requestId: string,
    status: Exclude<RequestStatus, "open">,
    result: string,
    runToken: string | null = null,
  ): RequestRecord {
    requireText(requestId);
    requireText(result);
    if (runToken !== null) requireText(runToken);
    return this.writeTransaction(() => {
      const now = Date.now();
      const changes = this.database.prepare(`
        UPDATE requests
        SET status = ?, result = ?, finished_at = ?, run_token = NULL, run_expires_at = NULL
        WHERE id = ? AND status = 'open' AND NOT EXISTS (
          SELECT 1 FROM user_waits WHERE request_id = ? AND answer IS NULL
        ) AND run_token IS ?
          AND (run_token IS NULL OR run_expires_at > ?)
      `).run(status, result, now, requestId, requestId, runToken, now).changes;
      if (changes !== 0) return this.getRequest(requestId)!;
      const request = this.getRequest(requestId);
      if (!request) throw new NotFoundError("Request not found");
      if (request.status !== "open") throw new TransitionError("Request is already terminal");
      if (!this.ownsClaim(requestId, runToken, now)) {
        throw new RequestBusyError(request.sessionId, requestId);
      }
      throw new TransitionError("Waiting request cannot finish");
    });
  }

  claimRequest(requestId: string): ExecutionState {
    requireText(requestId);
    return this.writeTransaction(() => {
      const runToken = randomUUID();
      const now = Date.now();
      const changes = this.database.prepare(`
        UPDATE requests SET run_token = ?, run_expires_at = ?
        WHERE id = ? AND status = 'open'
          AND NOT EXISTS (
            SELECT 1 FROM user_waits WHERE request_id = ? AND answer IS NULL
          )
          AND (run_token IS NULL OR run_expires_at <= ?)
      `).run(
        runToken,
        now + LEGACY_STORE_INVARIANTS.executionLeaseMs,
        requestId,
        requestId,
        now,
      ).changes;
      const request = this.getRequest(requestId);
      if (!request) throw new NotFoundError("Request not found");
      if (changes !== 0) {
        const answer = this.getLatestAnsweredWait(requestId)?.answer ?? null;
        return {
          state: "claimed",
          sessionId: request.sessionId,
          requestId,
          prompt: request.prompt,
          workspaceRoot: request.workspaceRoot,
          answer,
          runToken,
        };
      }
      if (request.status !== "open") {
        return {
          state: "terminal",
          sessionId: request.sessionId,
          requestId,
          status: request.status,
          result: request.result!,
        };
      }
      const wait = this.getUnansweredWait(requestId);
      if (wait) return { state: "waiting", sessionId: request.sessionId, requestId, wait };
      throw new RequestBusyError(request.sessionId, requestId);
    });
  }

  releaseRequest(requestId: string, runToken: string): void {
    requireText(requestId);
    requireText(runToken);
    this.writeTransaction(() => {
      const now = Date.now();
      const changes = this.database.prepare(`
        UPDATE requests SET run_token = NULL, run_expires_at = NULL
        WHERE id = ? AND status = 'open' AND run_token = ? AND run_expires_at > ?
      `).run(requestId, runToken, now).changes;
      if (changes !== 0) return;
      const request = this.getRequest(requestId);
      if (!request) throw new NotFoundError("Request not found");
      if (request.status !== "open") throw new TransitionError("Request is already terminal");
      throw new RequestBusyError(request.sessionId, requestId);
    });
  }

  resumeRequest(requestId: string): ResumeState {
    requireText(requestId);
    return this.readTransaction(() => {
      const request = this.getRequest(requestId);
      if (!request) throw new NotFoundError("Request not found");
      if (request.status !== "open") {
        return {
          state: "terminal",
          requestId,
          status: request.status,
          result: request.result!,
        };
      }
      const wait = this.getUnansweredWait(requestId);
      if (wait) return { state: "waiting", requestId, wait };
      const answered = this.getLatestAnsweredWait(requestId);
      return { state: "ready", requestId, answer: answered?.answer ?? null };
    });
  }

  requestContext(requestId: string): RequestContext {
    requireText(requestId);
    return this.readTransaction(() => {
      const request = this.getRequest(requestId);
      if (!request) throw new NotFoundError("Request not found");
      const { id, sessionId, prompt, workspaceRoot } = request;
      return { id, sessionId, prompt, workspaceRoot };
    });
  }

  sessionSnapshot(sessionId: string): SessionSnapshot {
    requireText(sessionId);
    return this.readTransaction(() => {
      const session = this.getSession(sessionId);
      if (!session) throw new NotFoundError("Session not found");
      const requests = this.listRequests(sessionId).map((request) => ({
        ...request,
        waits: this.listWaits(request.id),
      }));
      return { session, requests };
    });
  }

  private writeTransaction<T>(operation: () => T): T {
    return this.transaction("BEGIN IMMEDIATE", operation);
  }

  private readTransaction<T>(operation: () => T): T {
    return this.transaction("BEGIN", operation);
  }

  private transaction<T>(begin: "BEGIN" | "BEGIN IMMEDIATE", operation: () => T): T {
    this.database.exec(begin);
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private createRequest(
    sessionId: string,
    prompt: string,
    workspaceRoot: string | null,
  ): RequestRecord | undefined {
    const request: RequestRecord = {
      id: randomUUID(),
      sessionId,
      ordinal: this.nextOrdinal("requests", "session_id", sessionId),
      prompt,
      workspaceRoot,
      status: "open",
      result: null,
      createdAt: Date.now(),
      finishedAt: null,
    };
    const changes = this.database.prepare(`
      INSERT INTO requests (id, session_id, ordinal, prompt, workspace_root, status, created_at)
      SELECT ?, id, ?, ?, ?, 'open', ? FROM sessions
      WHERE id = ? AND NOT EXISTS (
        SELECT 1 FROM requests WHERE session_id = ? AND status = 'open'
      )
    `).run(
      request.id,
      request.ordinal,
      prompt,
      workspaceRoot,
      request.createdAt,
      sessionId,
      sessionId,
    ).changes;
    return changes === 0 ? undefined : request;
  }

  private createWait(
    requestId: string,
    question: string,
    runToken: string | null,
    now: number,
  ): WaitRecord | undefined {
    const wait: WaitRecord = {
      id: randomUUID(),
      requestId,
      ordinal: this.nextOrdinal("user_waits", "request_id", requestId),
      question,
      answer: null,
      createdAt: now,
      answeredAt: null,
    };
    const changes = this.database.prepare(`
      INSERT INTO user_waits (id, request_id, ordinal, question, created_at)
      SELECT ?, id, ?, ?, ? FROM requests
      WHERE id = ? AND status = 'open' AND run_token IS ?
        AND (run_token IS NULL OR run_expires_at > ?) AND NOT EXISTS (
        SELECT 1 FROM user_waits WHERE request_id = ? AND answer IS NULL
      )
    `).run(
      wait.id,
      wait.ordinal,
      question,
      wait.createdAt,
      requestId,
      runToken,
      now,
      requestId,
    ).changes;
    return changes === 0 ? undefined : wait;
  }

  private getSession(id: string): SessionRecord | undefined {
    const row = this.database.prepare("SELECT id, created_at FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return row ? sessionFromRow(row) : undefined;
  }

  private getRequest(id: string): RequestRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, session_id, ordinal, prompt, workspace_root, status, result, created_at, finished_at
      FROM requests WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? requestFromRow(row) : undefined;
  }

  private getWait(id: string): WaitRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, request_id, ordinal, question, answer, created_at, answered_at
      FROM user_waits WHERE id = ?
    `).get(id) as Row | undefined;
    return row ? waitFromRow(row) : undefined;
  }

  private getUnansweredWait(requestId: string): WaitRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, request_id, ordinal, question, answer, created_at, answered_at
      FROM user_waits WHERE request_id = ? AND answer IS NULL
    `).get(requestId) as Row | undefined;
    return row ? waitFromRow(row) : undefined;
  }

  private getLatestAnsweredWait(requestId: string): WaitRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, request_id, ordinal, question, answer, created_at, answered_at
      FROM user_waits WHERE request_id = ? AND answer IS NOT NULL
      ORDER BY ordinal DESC LIMIT 1
    `).get(requestId) as Row | undefined;
    return row ? waitFromRow(row) : undefined;
  }

  private ownsClaim(requestId: string, runToken: string | null, now: number): boolean {
    return this.database.prepare(`
      SELECT 1 FROM requests
      WHERE id = ? AND run_token IS ? AND (run_token IS NULL OR run_expires_at > ?)
    `).get(requestId, runToken, now) !== undefined;
  }

  private clearClaim(requestId: string, runToken: string | null, now: number): void {
    const changes = this.database.prepare(`
      UPDATE requests SET run_token = NULL, run_expires_at = NULL
      WHERE id = ? AND run_token IS ? AND (run_token IS NULL OR run_expires_at > ?)
    `).run(requestId, runToken, now).changes;
    if (changes === 0) throw new StoreError("Execution claim changed during transition");
  }

  private listRequests(sessionId: string): readonly RequestRecord[] {
    return (this.database.prepare(`
      SELECT id, session_id, ordinal, prompt, workspace_root, status, result, created_at, finished_at
      FROM requests WHERE session_id = ? ORDER BY ordinal
    `).all(sessionId) as Row[]).map(requestFromRow);
  }

  private listWaits(requestId: string): readonly WaitRecord[] {
    return (this.database.prepare(`
      SELECT id, request_id, ordinal, question, answer, created_at, answered_at
      FROM user_waits WHERE request_id = ? ORDER BY ordinal
    `).all(requestId) as Row[]).map(waitFromRow);
  }

  private initializeSchema(): void {
    this.writeTransaction(() => {
      const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
      if (row.user_version === 0) {
        this.database.exec(SCHEMA_V1);
        this.database.exec(`PRAGMA user_version = ${LEGACY_STORE_INVARIANTS.schemaVersion}`);
      } else if (row.user_version !== LEGACY_STORE_INVARIANTS.schemaVersion) {
        throw new VersionError("Unsupported database schema version");
      }

      const objects = this.database.prepare(`
        SELECT type, name, tbl_name AS tableName, sql
        FROM sqlite_schema
        WHERE lower(substr(name, 1, 7)) <> 'sqlite_'
      `).all() as Array<{ type: string; name: string; tableName: string; sql: string | null }>;
      if (
        objects.length !== SCHEMA_V1_OBJECTS.length ||
        SCHEMA_V1_OBJECTS.some((expected) => !objects.some((actual) =>
          actual.type === expected.type &&
          actual.name === expected.name &&
          actual.tableName === expected.tableName &&
          actual.sql === expected.sql
        ))
      ) {
        throw new StoreError("Database schema does not match version 1");
      }
    });
  }

  private nextOrdinal(table: "requests" | "user_waits", foreignKey: "session_id" | "request_id", id: string): number {
    const row = this.database.prepare(
      `SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM ${table} WHERE ${foreignKey} = ?`,
    ).get(id) as { ordinal: number };
    return row.ordinal;
  }
}

function sessionFromRow(row: Row): SessionRecord {
  return { id: row.id as string, createdAt: row.created_at as number };
}

function requestFromRow(row: Row): RequestRecord {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    ordinal: row.ordinal as number,
    prompt: row.prompt as string,
    workspaceRoot: row.workspace_root as string | null,
    status: row.status as RequestStatus,
    result: row.result as string | null,
    createdAt: row.created_at as number,
    finishedAt: row.finished_at as number | null,
  };
}

function waitFromRow(row: Row): WaitRecord {
  return {
    id: row.id as string,
    requestId: row.request_id as string,
    ordinal: row.ordinal as number,
    question: row.question as string,
    answer: row.answer as string | null,
    createdAt: row.created_at as number,
    answeredAt: row.answered_at as number | null,
  };
}
