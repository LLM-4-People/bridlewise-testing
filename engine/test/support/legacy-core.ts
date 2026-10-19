import {
  Store,
  type ExecutionState,
  type RequestRecord,
  type RequestContext,
  type RequestStatus,
  type ResumeState,
  type SessionRecord,
  type SessionSnapshot,
  type WaitRecord,
} from "./legacy-store.ts";
import { requireText } from "./legacy-text-validation.ts";

export type { ResumeState, SessionSnapshot } from "./legacy-store.ts";

export class Core {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  createSession(): SessionRecord {
    return this.store.createSession();
  }

  submitRequest(sessionId: string, prompt: string, workspaceRoot?: string): RequestRecord {
    requireText(sessionId);
    requireText(prompt);
    if (workspaceRoot !== undefined) requireText(workspaceRoot);
    return this.store.submitRequest(sessionId, prompt, workspaceRoot);
  }

  waitForUser(requestId: string, question: string, runToken: string | null = null): WaitRecord {
    requireText(requestId);
    requireText(question);
    if (runToken !== null) requireText(runToken);
    return this.store.waitForUser(requestId, question, runToken);
  }

  answerWait(waitId: string, answer: string): WaitRecord {
    requireText(waitId);
    requireText(answer);
    return this.store.answerWait(waitId, answer);
  }

  resumeRequest(requestId: string): ResumeState {
    requireText(requestId);
    return this.store.resumeRequest(requestId);
  }

  claimRequest(requestId: string): ExecutionState {
    requireText(requestId);
    return this.store.claimRequest(requestId);
  }

  releaseRequest(requestId: string, runToken: string): void {
    requireText(requestId);
    requireText(runToken);
    this.store.releaseRequest(requestId, runToken);
  }

  requestContext(requestId: string): RequestContext {
    requireText(requestId);
    return this.store.requestContext(requestId);
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
    return this.store.finishRequest(requestId, status, result, runToken);
  }

  sessionSnapshot(sessionId: string): SessionSnapshot {
    requireText(sessionId);
    return this.store.sessionSnapshot(sessionId);
  }
}
