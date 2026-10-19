import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTempDir } from "./temp-dir.ts";
import { modulePathMatching } from "./module-resolver.ts";

/**
 * A product module's file URL as a JavaScript string literal, for a generated
 * native script: the module is named by its unique trailing path fragment and
 * RESOLVED (the module resolver owns where modules live), never spelled as a
 * location, so a move touches no fixture.
 */
export const nativeModuleUrl = (fragment: string): string => JSON.stringify(pathToFileURL(resolve(modulePathMatching(fragment))).href);

/** A fresh native module graph. spawnSync's SIGKILL timeout joins the child on failure;
 * successful fixtures close their own workers/handles before returning. */
export function runNativeScript(source: string, timeout = 30_000) {
  const dir = createTempDir("native-script-");
  const script = join(dir, "probe.mjs");
  writeFileSync(script, source);
  return spawnSync(process.execPath, [script], { encoding: "utf8", timeout, killSignal: "SIGKILL" });
}
