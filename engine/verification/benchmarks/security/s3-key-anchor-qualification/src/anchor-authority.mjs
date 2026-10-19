import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { open, rename } from "node:fs/promises";
import net from "node:net";
import { dirname, join } from "node:path";
import process from "node:process";

process.umask(0o077);
const [socketPath, statePath] = process.argv.slice(2);
if (!socketPath || !statePath) throw new Error("socket and state paths are required");
mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });

const HASH = /^[0-9a-f]{64}$/u;
const REQUEST_ID = /^[a-zA-Z0-9_.:-]{1,128}$/u;
const GENESIS = "0".repeat(64);

function validateState(value) {
  if (!value || value.schema !== "s3q-anchor/v1" ||
      !Number.isSafeInteger(value.generation) || value.generation < 0 ||
      !HASH.test(value.tip) ||
      (value.lastRequest !== null && typeof value.lastRequest !== "object")) {
    throw new Error("invalid authority state");
  }
  return value;
}

function readStateNoFollow(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== process.getuid() ||
        (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
      throw new Error("unsafe authority state metadata");
    }
    return validateState(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally {
    closeSync(descriptor);
  }
}

async function persistState(value) {
  const directory = dirname(statePath);
  const temporary = join(directory, `.anchor-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT |
    constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, { encoding: "utf8" });
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, statePath);
  const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

let state;
if (existsSync(statePath)) {
  state = readStateNoFollow(statePath);
} else {
  state = { schema: "s3q-anchor/v1", generation: 0, tip: GENESIS, lastRequest: null };
  await persistState(state);
}

if (existsSync(socketPath)) {
  const socketStat = lstatSync(socketPath);
  if (!socketStat.isSocket() || socketStat.uid !== process.getuid()) {
    throw new Error("refusing to replace unsafe socket path");
  }
  unlinkSync(socketPath);
}

async function handleRequest(request) {
  if (request?.op === "read") {
    return { ok: true, generation: state.generation, tip: state.tip };
  }
  if (request?.op !== "cas") return { ok: false, code: "unknown_operation" };
  const valid = Number.isSafeInteger(request.expectedGeneration) &&
    request.expectedGeneration >= 0 && HASH.test(request.expectedTip ?? "") &&
    request.newGeneration === request.expectedGeneration + 1 &&
    HASH.test(request.newTip ?? "") && REQUEST_ID.test(request.requestId ?? "");
  if (!valid) return { ok: false, code: "invalid_request" };

  const previous = state.lastRequest;
  if (previous && previous.requestId === request.requestId) {
    const same = previous.expectedGeneration === request.expectedGeneration &&
      previous.expectedTip === request.expectedTip &&
      previous.newGeneration === request.newGeneration &&
      previous.newTip === request.newTip;
    return same
      ? { ok: true, applied: false, idempotentReplay: true, generation: state.generation, tip: state.tip }
      : { ok: false, code: "request_id_reuse" };
  }
  if (state.generation !== request.expectedGeneration || state.tip !== request.expectedTip) {
    return { ok: false, code: "compare_failed", generation: state.generation, tip: state.tip };
  }
  const next = {
    schema: "s3q-anchor/v1",
    generation: request.newGeneration,
    tip: request.newTip,
    lastRequest: {
      requestId: request.requestId,
      expectedGeneration: request.expectedGeneration,
      expectedTip: request.expectedTip,
      newGeneration: request.newGeneration,
      newTip: request.newTip,
    },
  };
  await persistState(next);
  state = next;
  return { ok: true, applied: true, idempotentReplay: false, generation: state.generation, tip: state.tip };
}

let queue = Promise.resolve();
const server = net.createServer({ allowHalfOpen: true }, (socket) => {
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk.toString("utf8");
    if (input.length > 65_536) socket.destroy(new Error("request too large"));
  });
  socket.once("end", () => {
    queue = queue.then(async () => {
      try {
        const line = input.endsWith("\n") ? input.slice(0, -1) : input;
        const response = await handleRequest(JSON.parse(line));
        socket.end(`${JSON.stringify(response)}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, code: "server_error", message: error.message })}\n`);
      }
    });
  });
});

server.listen(socketPath, () => {
  process.getBuiltinModule("node:fs").chmodSync(socketPath, 0o600);
  console.log(JSON.stringify({ ready: true, pid: process.pid }));
});

function shutdown() {
  server.close(() => {
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath);
    } finally {
      process.exit(0);
    }
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
