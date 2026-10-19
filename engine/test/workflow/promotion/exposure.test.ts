/**
 * THE PROMOTION EXPOSURE (registrations/promotion.ts, T-E2): without an
 * installed source the signals read `unmeasured` and the actions refuse typed;
 * with one, the rows are the source's answers. The registration imports no
 * process code (the web server and the browser build load it).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { executeAction, getSignal, readSignal } from "../../../src/shared/exposure/index.ts";
import { installPromotionSource, registerPromotionExposure, resetPromotionRegistration } from "../../../src/shared/exposure/registrations/promotion.ts";

const SIGNALS = ["profiles", "state", "lastResult", "lastPromoted", "pending", "held", "targetCheckout", "targetEdits", "advisories", "lastRunDurationMs"] as const;

test("T-E2: every signal reads unmeasured and every action refuses typed until a host installs the source; then each answers through it", async () => {
  resetPromotionRegistration();
  registerPromotionExposure();
  for (const name of SIGNALS) {
    assert.ok(getSignal(`promotion.${name}`) !== undefined, name);
    assert.equal(await readSignal(`promotion.${name}`), "unmeasured", name);
  }
  for (const id of ["status", "plan", "explain", "apply", "rollback", "hold", "releaseHold"]) {
    await assert.rejects(executeAction(`promotion.${id}`, { path: "a", to: "abc", reason: "r" }), (error: unknown) => (error as { code?: string }).code === "promotion_source_unavailable", id);
  }
  const calls: unknown[] = [];
  const line = (name: string) => () => `${name}: answered`;
  installPromotionSource({
    profiles: line("profiles"), state: line("state"), lastResult: line("lastResult"), lastPromoted: line("lastPromoted"), pending: line("pending"),
    held: line("held"), targetCheckout: line("targetCheckout"), targetEdits: line("targetEdits"), advisories: line("advisories"), lastRunDurationMs: line("lastRunDurationMs"),
    status: async (profile, source) => { calls.push(["status", profile, source]); return { ok: true }; },
    plan: async (profile, source) => { calls.push(["plan", profile, source]); return { ok: true }; },
    explain: async (paths, profile, source) => { calls.push(["explain", paths, profile, source]); return { ok: true }; },
    apply: async (request) => { calls.push(["apply", request]); return { ok: true }; },
    rollback: async (to, reason, profile) => { calls.push(["rollback", to, reason, profile]); return { ok: true }; },
    hold: async (reason, profile) => { calls.push(["hold", reason, profile]); return { ok: true }; },
    releaseHold: async (reason, profile) => { calls.push(["releaseHold", reason, profile]); return { ok: true }; },
  });
  for (const name of SIGNALS) assert.equal(await readSignal(`promotion.${name}`), `${name}: answered`, name);
  await executeAction("promotion.explain", { path: "src/a.ts", profile: "dev-to-prod" });
  await executeAction("promotion.status", {});
  await executeAction("promotion.apply", { acceptTargetEdits: "README.md, .gitignore", reason: "bootstrap", noPush: true });
  await executeAction("promotion.rollback", { to: "abc", reason: "a defect shipped" });
  await executeAction("promotion.hold", { reason: "investigating" });
  await executeAction("promotion.releaseHold", { reason: "fixed", profile: "dev-to-prod" });
  assert.deepEqual(calls, [
    ["explain", ["src/a.ts"], "dev-to-prod", undefined],
    ["status", undefined, undefined],
    ["apply", { noPublish: false, noPush: true, acceptTargetEdits: ["README.md", ".gitignore"], allowDeletions: false, releaseHold: false, reason: "bootstrap" }],
    ["rollback", "abc", "a defect shipped", undefined],
    ["hold", "investigating", undefined],
    ["releaseHold", "fixed", "dev-to-prod"],
  ]);
});

test("the registration imports no process or filesystem code", () => {
  const text = readFileSync(new URL("../../../src/shared/exposure/registrations/promotion.ts", import.meta.url), "utf8");
  const imports = [...text.matchAll(/^import[^;]*from\s+"([^"]+)"/gmu)].map((match) => match[1]);
  assert.deepEqual(imports, ["../index.ts", "../../../kernel/errors.ts"]);
});
