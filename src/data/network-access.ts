/**
 * A page may permanently surrender its client network capability before it
 * mounts a public replay. The Broker and native stream doors enforce this
 * together: a component cannot turn an archive into a live session by
 * reaching a different client method. There is deliberately no reopen verb.
 */
import { ClientError } from "./errors.ts";

export const CLIENT_NETWORK_CLOSED = "client_network_closed";

export type ClientNetworkAccess =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; reason: string }>;

let refusal: ClientError | null = null;

/**
 * Close before loading the host graph. First reason wins. This is a boot
 * capability boundary, not a revocation protocol for already-open streams.
 */
export function closeClientNetwork(reason: string): void {
  if (reason.trim().length === 0) throw new TypeError("A closed client network needs a reason");
  refusal ??= new ClientError(CLIENT_NETWORK_CLOSED, reason);
}

/** A signal for hosts that explain the page's capability before an action. */
export function clientNetworkAccess(): ClientNetworkAccess {
  return refusal === null
    ? { allowed: true }
    : { allowed: false, reason: refusal.message };
}

/** Called before native I/O, before timers, connection probes or subscriptions. */
export function assertClientNetwork(): void {
  if (refusal !== null) throw refusal;
}
