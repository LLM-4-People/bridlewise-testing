#!/usr/bin/env node

import { AuthorReceiptError, verifyAuthorReceipt } from "./verify-qualification-author-receipt.mjs";
import { validateProtocolFiles } from "./interaction-command-job-qualification/validate-protocol.mjs";

async function main() {
  if (process.argv.length !== 2) throw new AuthorReceiptError("arguments_invalid");
  const verifiedAuthorReceipt = verifyAuthorReceipt();
  const result = validateProtocolFiles({ verifiedAuthorReceipt });
  process.stdout.write(JSON.stringify(result) + "\n");
}

try {
  await main();
} catch (error) {
  const code = typeof error?.code === "string" ? error.code : "qualification_runner_internal_error";
  process.stderr.write(JSON.stringify({ status: "invalid", code }) + "\n");
  process.exitCode = 1;
}
