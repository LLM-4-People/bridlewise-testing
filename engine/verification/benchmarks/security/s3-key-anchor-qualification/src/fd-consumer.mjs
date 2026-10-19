import { createHash, webcrypto } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import process from "node:process";

const writeLine = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

writeLine({ phase: "ready", pid: process.pid });

const chunks = [];
const scratch = Buffer.alloc(64);
while (true) {
  const count = await new Promise((resolve, reject) => {
    process.getBuiltinModule("node:fs").read(3, scratch, 0, scratch.length, null,
      (error, bytesRead) => error ? reject(error) : resolve(bytesRead));
  });
  if (count === 0) break;
  chunks.push(Buffer.from(scratch.subarray(0, count)));
}
scratch.fill(0);
closeSync(3);

const keyBytes = Buffer.concat(chunks);
for (const chunk of chunks) chunk.fill(0);
const keyDigest = createHash("sha256").update(keyBytes).digest("hex");
const commandLine = readFileSync("/proc/self/cmdline");
const environment = readFileSync("/proc/self/environ");
const commandLineContainsKey = commandLine.indexOf(keyBytes) !== -1;
const environmentContainsKey = environment.indexOf(keyBytes) !== -1;

const cryptoKey = await webcrypto.subtle.importKey(
  "raw",
  keyBytes,
  { name: "AES-GCM" },
  false,
  ["encrypt", "decrypt"],
);
keyBytes.fill(0);
const inputBufferZeroed = keyBytes.every((value) => value === 0);

let exportRejected = false;
let exportErrorName = null;
try {
  await webcrypto.subtle.exportKey("raw", cryptoKey);
} catch (error) {
  exportRejected = true;
  exportErrorName = error?.name ?? "unknown";
}

const iv = Buffer.alloc(12, 0x2a);
const plaintext = Buffer.from("synthetic qualification payload", "utf8");
const ciphertext = await webcrypto.subtle.encrypt(
  { name: "AES-GCM", iv },
  cryptoKey,
  plaintext,
);
const recovered = Buffer.from(await webcrypto.subtle.decrypt(
  { name: "AES-GCM", iv },
  cryptoKey,
  ciphertext,
));
const roundTrip = recovered.equals(plaintext);
plaintext.fill(0);
recovered.fill(0);
iv.fill(0);

writeLine({
  phase: "result",
  bytesRead: keyBytes.length,
  keySha256: keyDigest,
  commandLineContainsKey,
  environmentContainsKey,
  inputBufferZeroed,
  cryptoKeyExtractable: cryptoKey.extractable,
  exportRejected,
  exportErrorName,
  encryptDecryptRoundTrip: roundTrip,
});
writeLine({ phase: "hold" });
await new Promise((resolve) => {
  process.stdin.once("end", resolve);
  process.stdin.resume();
});
