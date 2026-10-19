/**
 * A REAL WEBSOCKET SERVER FOR TESTS — RFC 6455 over `node:http`'s upgrade, on
 * 127.0.0.1, so the MCP websocket transport is driven through the PLATFORM
 * WebSocket (undici) exactly as in production. A fake socket class hid that
 * the platform refuses close code 1009 from a client (SECC-V-B8); only a real
 * peer shows what goes over the wire.
 *
 * It records every handshake (headers, offered subprotocols), every text
 * message and every close frame's code the client sends, and lets a test send
 * text frames and drop the connection.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo, Socket } from "node:net";

const ACCEPT_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type WebSocketPeer = Readonly<{
  /** Send one unfragmented text frame. */
  sendText(text: string): void;
  /** End the TCP connection without a close frame. */
  drop(): void;
  /** Text messages the client sent, in order. */
  received: string[];
}>;

export type WebSocketTestServer = Readonly<{
  url: string;
  handshakes: Readonly<{ headers: IncomingHttpHeaders; protocols: readonly string[] }>[];
  /** Close codes the client sent (undefined for a close frame without a code). */
  closeCodes: (number | undefined)[];
  /** Resolves when the client's next close frame arrives. */
  nextClose(): Promise<number | undefined>;
  close(): Promise<void>;
}>;

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : length < 65_536 ? Buffer.concat([Buffer.from([0x80 | opcode, 126]), Buffer.from([length >> 8, length & 0xff])])
      : (() => { const extended = Buffer.alloc(8); extended.writeBigUInt64BE(BigInt(length)); return Buffer.concat([Buffer.from([0x80 | opcode, 127]), extended]); })();
  return Buffer.concat([header, payload]);
}

/** Start a server; `onConnect` runs for every accepted connection. */
export async function startWebSocketServer(onConnect: (peer: WebSocketPeer) => void = () => {}): Promise<WebSocketTestServer> {
  const handshakes: { headers: IncomingHttpHeaders; protocols: readonly string[] }[] = [];
  const closeCodes: (number | undefined)[] = [];
  const closeWaiters: ((code: number | undefined) => void)[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => { response.writeHead(426).end(); });
  server.on("upgrade", (request, socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const key = String(request.headers["sec-websocket-key"] ?? "");
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
    handshakes.push({ headers: request.headers, protocols });
    const accept = createHash("sha1").update(key + ACCEPT_GUID).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`,
      ...(protocols.length > 0 ? [`Sec-WebSocket-Protocol: ${protocols[0]}`] : []), "", ""].join("\r\n"));
    const received: string[] = [];
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2) {
        const opcode = buffered[0]! & 0x0f, masked = (buffered[1]! & 0x80) !== 0;
        let length = buffered[1]! & 0x7f, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        else if (length === 127) { if (buffered.length < 10) return; length = Number(buffered.readBigUInt64BE(2)); offset = 10; }
        const maskOffset = offset; if (masked) offset += 4;
        if (buffered.length < offset + length) return;
        const payload = Buffer.from(buffered.subarray(offset, offset + length));
        if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ buffered[maskOffset + (index % 4)]!;
        buffered = buffered.subarray(offset + length);
        if (opcode === 0x1) received.push(payload.toString("utf8"));
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
          closeCodes.push(code);
          closeWaiters.shift()?.(code);
          socket.end(frame(0x8, payload.subarray(0, 2)));
          return;
        }
        if (opcode === 0x9) socket.write(frame(0xa, payload));
      }
    });
    onConnect(Object.freeze({
      sendText: (text: string) => { socket.write(frame(0x1, Buffer.from(text, "utf8"))); },
      drop: () => { socket.destroy(); },
      received,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.freeze({
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    handshakes,
    closeCodes,
    nextClose: () => new Promise<number | undefined>((resolve) => closeWaiters.push(resolve)),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}
