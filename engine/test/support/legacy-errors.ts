import { HarnessError } from "../../src/kernel/errors.ts";

export class NotFoundError extends HarnessError {
  constructor(message: string) {
    super(message, "not_found");
  }
}

export class TransitionError extends HarnessError {
  constructor(
    message: string,
    code = "transition_invalid",
    retryable = false,
    safeDetails: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(message, code, retryable, safeDetails);
  }
}

export class StoreError extends HarnessError {
  constructor(message: string) {
    super(message, "store_invalid");
  }
}

export class VersionError extends HarnessError {
  constructor(message: string) {
    super(message, "version_unsupported");
  }
}

export class RequestBusyError extends TransitionError {
  readonly sessionId: string;
  readonly requestId: string;

  constructor(sessionId: string, requestId: string) {
    super("Request is already running", "request_busy", true, { sessionId, requestId });
    this.sessionId = sessionId;
    this.requestId = requestId;
  }
}
