import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);

function vmLckKiB() {
  const match = /^VmLck:\s+(\d+)\s+kB$/mu.exec(readFileSync("/proc/self/status", "utf8"));
  return match ? Number(match[1]) : null;
}

const keyring = require("@napi-rs/keyring");
const sodium = require("sodium-native");
const before = vmLckKiB();
const secureBuffer = sodium.sodium_malloc(32);
sodium.randombytes_buf(secureBuffer);
const afterAllocation = vmLckKiB();
const hadNonzeroBytes = secureBuffer.some((value) => value !== 0);
sodium.sodium_memzero(secureBuffer);
const memzeroObserved = secureBuffer.every((value) => value === 0);
sodium.sodium_mprotect_noaccess(secureBuffer);
sodium.sodium_mprotect_readwrite(secureBuffer);
sodium.sodium_munlock(secureBuffer);
const afterUnlock = vmLckKiB();

console.log(JSON.stringify({
  napiKeyringLoaded: true,
  napiKeyringExports: Object.keys(keyring).sort(),
  sodiumNativeLoaded: true,
  sodiumNativeSecureMemoryExports: Object.keys(sodium)
    .filter((name) => /^sodium_(?:malloc|memzero|mlock|munlock|mprotect_)/u.test(name))
    .sort(),
  vmLckKiBBefore: before,
  vmLckKiBAfterSecureAllocation: afterAllocation,
  vmLckKiBAfterUnlock: afterUnlock,
  secureBufferHadNonzeroBytes: hadNonzeroBytes,
  nativeMemzeroObserved: memzeroObserved,
  caveat: "Observed zeroization covers this allocation only; copies inside V8, native crypto providers, pipes, kernel buffers, crash tooling, or hardware are not proven erased.",
}));
