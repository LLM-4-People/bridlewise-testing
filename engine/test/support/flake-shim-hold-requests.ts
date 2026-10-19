/**
 * A REPRODUCTION SHIM (`harness flake reproduce --preload`, the FLAKE-REPRO
 * decision): every HTTP server of the process holds a JSON-RPC ANSWER it
 * receives (a POST whose body carries no `method`: a client answering a
 * server's request) for a while before the request ends. It recreates, on
 * any machine, what load did to the transport test's H-1 case (2026-10-07
 * 20:19Z, "got undefined"): the client answers the server's ping on its own
 * POST, and that POST had not arrived one tick later. The client and the
 * server are untouched: only the arrival of the answer is late.
 *
 * Preloaded into every test file's process of a reproduction run (`node
 * --test --import`); never imported by a test.
 */
import { IncomingMessage } from "node:http";

/** How long an answer is held: far past one tick, far below any test's wait. */
const HOLD_MS = 50;

const body = new WeakMap<IncomingMessage, string>();
const emit = IncomingMessage.prototype.emit;

IncomingMessage.prototype.emit = function holdAnswers(this: IncomingMessage, event: string | symbol, ...args: unknown[]): boolean {
  if (event === "data") body.set(this, `${body.get(this) ?? ""}${String(args[0])}`);
  if (event === "end" && this.method === "POST" && isAnswer(body.get(this))) {
    setTimeout(() => emit.call(this, event, ...args), HOLD_MS);
    return true;
  }
  return emit.call(this, event, ...args);
};

function isAnswer(text: string | undefined): boolean {
  if (text === undefined) return false;
  try {
    const message = JSON.parse(text) as Record<string, unknown> | null;
    return message !== null && typeof message === "object" && message["jsonrpc"] === "2.0" && message["method"] === undefined;
  } catch {
    return false;
  }
}
