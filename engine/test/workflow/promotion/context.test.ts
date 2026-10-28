/**
 * THE PROMOTION CONTEXT AND VERBS (src/workflow/promotion/context.ts and the
 * CLI's argv door, promote-cli.ts), over the fixture repository: which
 * profile and which source a verb resolves (merge-door-final §5.1: `--source`,
 * HEAD, the target's trailer; the profile that counts is S's own), the
 * signals' one entry per declared profile (H1), each verb's answer, the
 * exit code of every class, and the one grammar (`promote-arguments.ts`): a
 * request spelled back is the request (what the promoter home re-executes).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { configureDebugSystem, createCollectingSink, resetDebugSystem } from "../../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../../src/shared/debug/debug-config.ts";
import { PROMOTION_CODES, promotionExitCode, type PromotionCode } from "../../../src/workflow/promotion/codes.ts";
import { enginePromotionSource, resolvePromotionContext, runPromotionVerb } from "../../../src/workflow/promotion/context.ts";
import { runPromoteCli } from "../../../src/workflow/promotion/promote-cli.ts";
import { renderCommandAnswer } from "../../../src/workflow/command-result.ts";
import { formatPromoteArguments, parsePromoteArguments } from "../../../src/workflow/promotion/promote-arguments.ts";
import { PROFILE_DIRECTORY, PROFILE_NAME, PROFILE_PATH, SOURCE, TARGET, fixtureProfile, json, promotionFixture } from "./promotion-fixture.ts";

const LAB_PROFILE = `${PROFILE_DIRECTORY}/dev-to-lab.json`;

test("H1: with TWO declared profiles every signal answers one entry per profile, and each verb is answered for the one it names", async () => {
  const fixture = promotionFixture("promotion-h1");
  fixture.commit(SOURCE, { [LAB_PROFILE]: json({ ...fixtureProfile(), name: "dev-to-lab", target: { ref: "refs/heads/lab" } }) });
  const signals = enginePromotionSource(fixture.root, fixture.document);
  const profiles = signals.profiles().split(" | ");
  assert.equal(profiles.length, 2, profiles.join(" | "));
  assert.match(profiles[0]!, /^dev-to-lab@[0-9a-f]{40} \(promotion\/dev-to-lab\.json\): dev → lab \(manual; /u);
  assert.match(profiles[1]!, /^dev-to-prod@[0-9a-f]{40} \(promotion\/dev-to-prod\.json\): dev → prod \(manual; /u);
  assert.match(signals.pending(), /^dev-to-lab: no target yet \| dev-to-prod: 2 source commit\(s\) not yet promoted, the oldest [0-9.]+ h old, changing what ships$/u);
  assert.deepEqual(signals.advisories().split(" | ").map((entry) => entry.split(":")[0]), ["dev-to-lab", "dev-to-prod"]);
  const unnamed = await signals.plan(undefined, undefined) as { code: string; message: string };
  assert.equal(unnamed.code, "promotion_profile_missing", "a verb with two profiles and no --profile names the choice");
  assert.match(unnamed.message, /holds 2 promotion profiles \(dev-to-lab, dev-to-prod\)/u);
  const named = await signals.status(PROFILE_NAME, undefined) as { code: string; data: { target: string } };
  assert.equal(named.code, "promotion_status");
  assert.equal(named.data.target, fixture.tip(TARGET));
});

test("§5.1: the profile that counts is the SOURCE commit's own, never the invoking checkout's stale copy", () => {
  const fixture = promotionFixture("promotion-own-profile");
  const stale = fixture.tip(SOURCE);
  fixture.commit(SOURCE, { [PROFILE_PATH]: json(fixtureProfile({ trigger: "on-source-publish" })) });
  fixture.git(["checkout", "-q", "--detach", stale]);
  const context = resolvePromotionContext(fixture.root, undefined, undefined, fixture.document);
  assert.equal(context.source, fixture.tip(SOURCE));
  assert.equal(context.loaded.profile.trigger, "on-source-publish");
  assert.equal(context.loaded.blob, fixture.git(["rev-parse", `${SOURCE}:${PROFILE_PATH}`]));
  // --source names S and its own profile, wherever HEAD is.
  assert.equal(resolvePromotionContext(fixture.root, undefined, stale, fixture.document).loaded.profile.trigger, "manual");
});

test("§5.1: from a checkout of the TARGET (no profile), the target tip's last promotion trailer names the profile; with none, the answer is typed", async () => {
  const fixture = promotionFixture("promotion-trailer");
  fixture.git(["checkout", "-q", TARGET]);
  const missing = await runPromotionVerb(fixture.root, { verb: "status" }, fixture.document);
  assert.equal(missing.code, "promotion_profile_missing");
  const source = fixture.tip(SOURCE);
  const promoted = fixture.git(["commit-tree", fixture.git(["rev-parse", `${TARGET}^{tree}`]), "-p", fixture.tip(TARGET), "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: ${PROFILE_NAME}@${fixture.loaded().blob!}`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, promoted]);
  fixture.git(["checkout", "-q", TARGET]);
  const context = resolvePromotionContext(fixture.root, undefined, undefined, fixture.document);
  assert.equal(context.loaded.profile.name, PROFILE_NAME);
  assert.equal(context.source, source);
  assert.equal(enginePromotionSource(fixture.root, fixture.document).pending(), `${PROFILE_NAME}: 0 source commit(s) not yet promoted, none changing what ships`);
});

test("the pending signal counts an overlay file's change as changing what ships, and an excluded file's as not", () => {
  const fixture = promotionFixture("promotion-overlay-pending", { boundary: { exclude: ["dev/", "promotion/", "target-only/"], overlay: { folder: "target-only/", kinds: ["*.txt"] } } });
  const source = fixture.tip(SOURCE);
  const promoted = fixture.git(["commit-tree", fixture.git(["rev-parse", `${TARGET}^{tree}`]), "-p", fixture.tip(TARGET), "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: ${PROFILE_NAME}@${fixture.loaded().blob!}`]);
  fixture.git(["update-ref", `refs/heads/${TARGET}`, promoted]);
  fixture.commit(SOURCE, { "dev/tool.ts": "export const tool = 3;\n" }, "a development change");
  fixture.git(["checkout", "-q", SOURCE]);
  assert.match(enginePromotionSource(fixture.root, fixture.document).pending(), /^dev-to-prod: 1 source commit\(s\) not yet promoted, the oldest [0-9.]+ h old, none changing what ships$/u);
  fixture.commit(SOURCE, { "target-only/NOTICE.txt": "the product's notice\n" }, "a target-only file");
  fixture.git(["checkout", "-q", SOURCE]);
  assert.match(enginePromotionSource(fixture.root, fixture.document).pending(), /^dev-to-prod: 2 source commit\(s\) not yet promoted, the oldest [0-9.]+ h old, changing what ships$/u);
});

test("M5: status, explain and plan --diff answer from the context; each refusal is an answer of its class", async () => {
  const fixture = promotionFixture("promotion-verbs");
  const status = await runPromotionVerb(fixture.root, { verb: "status" }, fixture.document) as { code: string; data: { pending: { commits: number }; preflight: { tools: Record<string, string | null> } } };
  assert.equal(status.code, "promotion_status");
  assert.equal(status.data.pending.commits, 1);
  assert.deepEqual(Object.keys(status.data.preflight.tools), [process.execPath], "the tools the profile's commands run (the gate and the lockfile command are node scripts)");
  // A version probe gets the command environment's projection, never this process's whole environment
  // (PROMO34FIX-TOOL-VERSIONS): an inherited NODE_OPTIONS no node accepts made the probe answer null.
  const inherited = process.env["NODE_OPTIONS"];
  process.env["NODE_OPTIONS"] = "--no-such-option-wf1b3c";
  try {
    const probed = await runPromotionVerb(fixture.root, { verb: "status" }, fixture.document) as { data: { preflight: { tools: Record<string, string | null> } } };
    assert.equal(probed.data.preflight.tools[process.execPath], process.version);
  } finally {
    if (inherited === undefined) delete process.env["NODE_OPTIONS"];
    else process.env["NODE_OPTIONS"] = inherited;
  }
  const explained = await runPromotionVerb(fixture.root, { verb: "explain", paths: ["product/lib/helper.ts", "dev/tool.ts"] }, fixture.document);
  assert.equal(explained.code, "promotion_explained");
  assert.deepEqual((explained.data as readonly { path: string; reason: string }[]).map((entry) => [entry.path, entry.reason]), [["product/lib/helper.ts", "reached from product/main.ts"], ["dev/tool.ts", "excluded (dev/)"]]);
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 9;\n" });
  const planned = await runPromotionVerb(fixture.root, { verb: "plan", diff: true }, fixture.document) as { code: string; data: { diff: string } };
  assert.equal(planned.code, "promotion_planned");
  assert.match(planned.data.diff, /product\/lib\/helper\.ts \| 2 \+-/u);
  fixture.commit(TARGET, { "README.md": "# edited on the target\n" }, "a direct edit");
  fixture.git(["checkout", "-q", SOURCE]);
  const refused = await runPromotionVerb(fixture.root, { verb: "plan", profile: PROFILE_NAME }, fixture.document);
  assert.deepEqual([refused.code, refused.class, refused.ok], ["promotion_target_edits", "precondition", false]);
  const unknown = await runPromotionVerb(fixture.root, { verb: "plan", profile: "nope" }, fixture.document);
  assert.deepEqual([unknown.code, unknown.class], ["promotion_profile_missing", "input"]);
  const noSource = await runPromotionVerb(fixture.root, { verb: "status", source: "no-such-rev" }, fixture.document);
  assert.deepEqual([noSource.code, noSource.class], ["promotion_source_missing", "input"]);
});

test("M4: every verb is logged once through the central audit log, with its class", async (t) => {
  resetDebugSystem();
  t.after(resetDebugSystem);
  const sink = createCollectingSink();
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [sink]);
  const fixture = promotionFixture("promotion-logged");
  await runPromotionVerb(fixture.root, { verb: "status" }, fixture.document);
  await runPromotionVerb(fixture.root, { verb: "plan", profile: "nope" }, fixture.document);
  const verbs = sink.events.filter((event) => event.category === "promotion.verb").map((event) => {
    const context = event.context as { verb: string; code: string; class: string; durationMs: number };
    assert.ok(Number.isInteger(context.durationMs));
    return [context.verb, context.code, context.class];
  });
  assert.deepEqual(verbs, [["status", "promotion_status", "ok"], ["plan", "promotion_profile_missing", "input"]]);
});

test("M5: every class ends the command with its own exit code; usage errors are answers, never crashes", async () => {
  const expected: Readonly<Record<string, number>> = { ok: 0, input: 2, precondition: 3, errored: 4, failed: 5, integrity: 6, parked: 7 };
  for (const [code, entry] of Object.entries(PROMOTION_CODES)) {
    assert.equal(promotionExitCode(code as PromotionCode), expected[entry.class], code);
    // An unattended run: only "not now" answers exit 0 besides ok.
    assert.equal(promotionExitCode(code as PromotionCode, true), "autoOk" in entry || entry.class === "ok" ? 0 : expected[entry.class], `${code} --auto`);
  }
  assert.deepEqual(Object.entries(PROMOTION_CODES).filter(([, entry]) => "autoOk" in entry).map(([code]) => code).sort(), ["promotion_held", "promotion_locked", "promotion_parked", "promotion_target_index_locked"]);
  for (const argv of [
    [], ["bogus"], ["plan", "--profile"], ["explain"], ["status", "--diff"],
    // apply's overrides need a reason, a reason needs an override, the edit list is never empty, and a plan flag is not apply's.
    ["apply", "--no-publish", "--accept-target-edits", "README.md"], ["apply", "--no-publish", "--allow-deletions"],
    ["apply", "--no-publish", "--reason", "why"], ["apply", "--no-publish", "--accept-target-edits", "--reason", "why"],
    ["apply", "--diff"], ["plan", "--no-publish"], ["apply", "--reason"], ["apply", "--release-hold"],
    // an unattended run takes no override; rollback, hold and release-hold need their reason (and rollback its commit); auto its refs.
    ["apply", "--auto", "--release-hold", "--reason", "why"], ["apply", "--auto", "--allow-deletions", "--reason", "why"],
    ["rollback", "--reason", "why"], ["rollback", "--to", "abc"], ["hold"], ["release-hold"], ["hold", "--reason", "why", "--source", "dev"],
    ["auto"], ["auto", "--refs", " refs/remotes/origin/dev", "--profile", "x"], ["status", "--to", "abc"],
  ]) {
    const outcome = await runPromoteCli(process.cwd(), argv);
    assert.equal(outcome.result.result.code, "promotion_usage", argv.join(" "));
    assert.equal(outcome.exitCode, 2, argv.join(" "));
  }
});

test("L13: --text renders the answer as a report (code, class, message, remedy, then its lists); --json, the default, the envelope", async () => {
  const outcome = await runPromoteCli(process.cwd(), ["apply", "--no-publish", "--allow-deletions"]);
  assert.equal(outcome.exitCode, 2);
  const text = renderCommandAnswer(outcome, "text");
  assert.match(text, /^promotion_usage \(input\): an override \(--accept-target-edits, --allow-deletions, --release-hold\) needs --reason <text>/u);
  assert.match(text, /\nremedy: Run `harness promote <status\|plan\|explain\|apply\|forge-publish\|verify\|rollback\|hold\|release-hold\|auto>/u);
  assert.deepEqual(JSON.parse(renderCommandAnswer(outcome, "json")), JSON.parse(JSON.stringify(outcome.result)), "the default: the envelope");
  // The format is the harness dispatch's one option, never a verb's argument.
  assert.equal((await runPromoteCli(process.cwd(), ["status", "--text"])).result.result.code, "promotion_usage");
});

test("PROMO1-SOURCE-EVIDENCE: plan advises each suite's judged run of S against the last promoted source's, or says unmeasured — never a gate", async () => {
  const fixture = promotionFixture("promotion-evidence");
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 8;\n" });
  const source = fixture.tip(SOURCE);
  const base = fixture.git(["merge-base", TARGET, SOURCE]);
  const treeOf = (commit: string): string => fixture.git(["rev-parse", `${commit}^{tree}`]).trim();
  const row = (headSha: string, failures: readonly string[]) => ({ timestamp: "2026-10-01T00:00:00.000Z", cpuMsPerTestFile: 1, testModuleCount: 1, headSha, treeId: treeOf(headSha), failures });
  // The web ledger only (the engine's stays absent): a row of S with one more failure than the base's.
  const ledger = join(fixture.root, ".bridlewise", "web-test-results", "run-history.json");
  mkdirSync(dirname(ledger), { recursive: true });
  // A row that names no tree is the run of no tree, whatever its HEAD (WF-1b3c-FIX MED-2).
  const { treeId: _unnamed, ...legacy } = row(source, ["old failure", "a new failure"]);
  writeFileSync(ledger, `${JSON.stringify({ runs: [row(base, ["old failure"]), legacy] })}\n`);
  const unnamed = await runPromotionVerb(fixture.root, { verb: "plan" }, fixture.document) as { data: { advisories: readonly { kind: string; detail: string }[] } };
  assert.match(unnamed.data.advisories.filter((advisory) => advisory.kind === "source_evidence")[1]!.detail, /^web: unmeasured — no judged run of the source/u);
  writeFileSync(ledger, `${JSON.stringify({ runs: [row(base, ["old failure"]), row(source, ["old failure", "a new failure"])] })}\n`);
  const planned = await runPromotionVerb(fixture.root, { verb: "plan" }, fixture.document) as { data: { advisories: readonly { kind: string; detail: string }[] } };
  const evidence = planned.data.advisories.filter((advisory) => advisory.kind === "source_evidence").map((advisory) => advisory.detail);
  assert.equal(evidence.length, 2, evidence.join("\n"));
  assert.match(evidence[0]!, /^engine: unmeasured — no judged run of the source/u);
  // A CANDIDATE's row of exactly S's tree (measured dirty on the base's HEAD, keyed by the tree it measured) is a run of S.
  const candidateRow = { ...row(base, ["old failure", "a new failure"]), provisionalFailures: true, treeId: treeOf(source) };
  writeFileSync(ledger, `${JSON.stringify({ runs: [row(base, ["old failure"]), candidateRow] })}\n`);
  const keyed = await runPromotionVerb(fixture.root, { verb: "plan" }, fixture.document) as { data: { advisories: readonly { kind: string; detail: string }[] } };
  assert.equal(keyed.data.advisories.filter((advisory) => advisory.kind === "source_evidence")[1]!.detail, evidence[1], "the candidate's row of S's tree is S's run");
  assert.equal(evidence[1], `web: 2 failure(s) at the source (run 2026-10-01T00:00:00.000Z, the ledger of ${fixture.root}); historical test reference only; current producer/terminal proof absent or malformed; against the last promoted source: 1 new (a new failure), 0 failing differently, 0 fixed`, "L12: it names whose ledger it read");
  assert.equal((planned as unknown as { code: string }).code, "promotion_planned", "evidence is advice, never a refusal");
});

test("the grammar: a request spelled back (formatPromoteArguments) parses to the same request, every flag kept — the overrides and their reason included", () => {
  const spellings: readonly (readonly string[])[] = [
    ["status"],
    ["status", "--profile", PROFILE_NAME, "--source", "abc123"],
    ["plan", "--source", "dev", "--diff", "--patch"],
    ["explain", "--profile", PROFILE_NAME, "product/main.ts", "dev/tool.ts"],
    ["apply", "--no-publish"],
    ["apply", "--profile", PROFILE_NAME, "--source", "dev", "--no-publish", "--accept-target-edits", "README.md", ".gitignore", "--reason", "the target adopts the source's README"],
    ["apply", "--no-publish", "--allow-deletions", "--reason", "the assets moved"],
    ["apply", "--no-push", "--auto"],
    ["apply", "--release-hold", "--reason", "the defect is fixed"],
    ["rollback", "--profile", PROFILE_NAME, "--to", "abc123", "--reason", "a defect shipped"],
    ["hold", "--reason", "investigating"],
    ["release-hold", "--profile", PROFILE_NAME, "--reason", "fixed"],
    ["auto", "--refs", " refs/remotes/origin/dev\n refs/remotes/origin/prod"],
  ];
  for (const argv of spellings) {
    const request = parsePromoteArguments(argv);
    assert.deepEqual(parsePromoteArguments(formatPromoteArguments(request)), request, argv.join(" "));
  }
  assert.deepEqual(formatPromoteArguments(parsePromoteArguments(spellings[5]!)), spellings[5], "the canonical spelling is stable");
  assert.throws(() => parsePromoteArguments(["status", "--profile", "--no-publish"]), /--profile needs a value/u, "a flag is never taken as a value");
});
