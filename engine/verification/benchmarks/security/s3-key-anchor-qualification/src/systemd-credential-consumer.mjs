import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  statfsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import process from "node:process";

const directory = process.env.CREDENTIALS_DIRECTORY;
if (!directory) throw new Error("CREDENTIALS_DIRECTORY is absent");
const path = join(directory, "s3q");
const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
const data = readFileSync(descriptor);
closeSync(descriptor);
const directoryStat = statSync(directory);
const fileStat = statSync(path);
const environment = readFileSync("/proc/self/environ");
const commandLine = readFileSync("/proc/self/cmdline");
const mountInfo = readFileSync("/proc/self/mountinfo", "utf8")
  .split("\n")
  .find((line) => line.includes(` ${directory.replaceAll(" ", "\\040")} `)) ?? null;

let writeOpenRejected = false;
let writeOpenErrorCode = null;
try {
  const writeDescriptor = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
  closeSync(writeDescriptor);
} catch (error) {
  writeOpenRejected = true;
  writeOpenErrorCode = error?.code ?? "unknown";
}

const filesystem = statfsSync(directory, { bigint: true });
console.log(JSON.stringify({
  credentialBytes: data.length,
  credentialSha256: createHash("sha256").update(data).digest("hex"),
  environmentContainsCredential: environment.indexOf(data) !== -1,
  commandLineContainsCredential: commandLine.indexOf(data) !== -1,
  directoryMode: directoryStat.mode & 0o7777,
  directoryUid: directoryStat.uid,
  directoryGid: directoryStat.gid,
  fileMode: fileStat.mode & 0o7777,
  fileUid: fileStat.uid,
  fileGid: fileStat.gid,
  writeOpenRejected,
  writeOpenErrorCode,
  filesystemTypeMagic: `0x${filesystem.type.toString(16)}`,
  mountInfo,
}));
data.fill(0);
