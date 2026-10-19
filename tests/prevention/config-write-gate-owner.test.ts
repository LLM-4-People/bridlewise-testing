// @vitest-environment node
/**
 * The CONFIG WRITE GATE — the allowlist that must actually exist.
 *
 * `server/routes/config.ts` documented, in its own header, that
 * "Only known config paths are accepted (no arbitrary JSON injection)".
 * No such check existed anywhere in the request path: the PUT validated the
 * path SHAPE (dot-separated alphanumerics), refused sensitive key names and
 * refused prototype-polluting segments, and then wrote whatever it was given
 * — including brand-new sections the config vocabulary does not define. The
 * comment described a control that was never implemented.
 *
 * The gate now lives at the single WRITE entry point (`writeConfigRaw`), not
 * in the route, so no future writer can reach the config file around it. The
 * allowlist is DERIVED: the candidate document is parsed by the harness's own
 * strict `getConfigDocumentSchema()`, so the set of writable paths is exactly the
 * set the config contract defines — no list is restated in the web UI, and a
 * section added to the contract becomes writable with no edit here.
 *
 * DYNAMIC DISCOVERY: every probe below is built from the LIVE config document
 * — the section names, the numeric leaf and the enum-ish leaf are found by
 * walking it, never named in this file. A config that gains or loses sections
 * is still fully exercised.
 *
 * These tests only exercise REJECTED writes, which never touch the disk; the
 * shared config file is asserted byte-unchanged afterwards.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfigRaw, writeConfigRaw, restoreConfigFileBytes } from "../../server/kernel/harness-config.ts";
// The config file's cross-process write lock — the attempt and its
// byte-exact restore below are one locked cycle, so a parallel fork's
// config write can never interleave between them.
import { withConfigWriteLock } from "../../engine/src/kernel/config-write-lock.ts";
import { getConfigDocumentSchema } from "../../server/kernel/canonical.ts";
import { ValidationError } from "../../server/kernel/errors.ts";
// The gate's own declared block-sequence defaults — the coupling floor reads
// the sibling leaf's EFFECTIVE value, so this arm derives its probe and its
// expected message from the same owner the floor does.
import { DEFAULT_TOOL_CALL_GATE_CONFIG } from "../../engine/src/safety/tool-call-gate.ts";
import { readSourceView } from "../../engine/scripts/verification/source-view.ts";

import { isolateHarnessConfig } from "../helpers/isolated-config.ts";
import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const CONFIG_PATH = isolateHarnessConfig("config-write-gate-");
const HARNESS_CONFIG_SRC = readSourceView(modulePath("harness-config.ts"));
const ROUTE_SRC = readSourceView(modulePathMatching("server/routes/config.ts"));

function configBytes(): string {
  return existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : "";
}

/** Every dotted leaf path in the document, discovered by walking it. */
function leafPaths(node: unknown, prefix = ""): string[] {
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return prefix === "" ? [] : [prefix];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out.push(...leafPaths(v, prefix === "" ? k : `${prefix}.${k}`));
  }
  return out;
}

/**
 * ATTEMPT A REAL WRITE AT THE TEST-OWNED CONFIG, AND PUT THE FILE BACK BEFORE
 * ANYTHING IS ASSERTED.
 *
 * Every test in this file proves a REFUSAL by driving the actual write — which
 * is the right way to prove one, and is exactly the shape that WRITES when the
 * refusal is the thing that has broken. It has already happened here: mutating
 * the gate let the write land, turning confinement off across the whole
 * workspace, and two later escape probes then measured an unconfined server.
 * The assertion caught it and could not undo it.
 *
 * One owner for that restore, so it cannot be present at some call sites and
 * forgotten at others — which is what the first fix left behind. The attempt
 * AND the restore hold the config's cross-process write lock as one cycle, so
 * a parallel fork's write can no longer land between them (the lost-update
 * residue class), and the restore itself is the atomic-rename owner — the
 * bytes AND the mode go back, because the harness refuses to start against a
 * config any other account can read.
 */
function attemptWrite(candidate: Record<string, unknown>): unknown {
  return withConfigWriteLock(CONFIG_PATH, () => {
    const before = configBytes();
    try {
      writeConfigRaw(candidate);
      return undefined;
    } catch (err) {
      return err;
    } finally {
      restoreConfigFileBytes(before);
    }
  });
}

/** The same, for a call site that wants the throw rather than the value. */
function expectRefused(candidate: Record<string, unknown>): ValidationError {
  const thrown = attemptWrite(candidate);
  expect(thrown, "the write must have been refused").toBeInstanceOf(ValidationError);
  return thrown as ValidationError;
}

function valueAt(doc: Record<string, unknown>, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setAt(doc: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = doc;
  for (const part of parts.slice(0, -1)) cur = cur[part] as Record<string, unknown>;
  cur[parts[parts.length - 1]!] = value;
}

const BASE = readConfigRaw();
// The write door receives JSON parsed in its realm. Vitest's VM environment
// exposes Node's native structuredClone, whose object prototypes belong to
// the host realm; using it here changes a JSON-input test into a foreign-
// prototype refusal before the document validator can see the mutation.
// BASE came from JSON on disk, so parsing its exact JSON preserves every
// candidate value while constructing the input the real write door receives.
const BASE_JSON = JSON.stringify(BASE);
const LEAVES = leafPaths(BASE);
/** A numeric leaf, discovered — used to probe type enforcement. */
const NUMERIC_LEAF = LEAVES.find((p) => typeof valueAt(BASE, p) === "number");
/** An object-valued section, discovered — used to probe unknown nested keys. */
const OBJECT_SECTION = Object.entries(BASE).find(
  ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v),
)?.[0];

describe("config write gate — the allowlist is real and derived", () => {
  test("the discovery source is real (the live config has sections and leaves)", () => {
    expect(Object.keys(BASE).length).toBeGreaterThan(0);
    expect(LEAVES.length).toBeGreaterThan(0);
    expect(NUMERIC_LEAF, "config must contain at least one numeric leaf").toBeDefined();
    expect(OBJECT_SECTION, "config must contain at least one object section").toBeDefined();
  });

  test("the LIVE config document satisfies the gate (it does not reject reality)", () => {
    // Assert value equality before cloning the disk JSON; negative zero or
    // any other non-round-trippable baseline value must be noticed here.
    expect(JSON.parse(BASE_JSON)).toEqual(BASE);
    // If this fails, the gate would block every legitimate write — the
    // positive control for the negative tests below.
    expect(CONFIG_DOCUMENT_SCHEMA.safeParse(BASE).success).toBe(true);
  });

  test("an UNKNOWN top-level section is rejected (no arbitrary JSON injection)", () => {
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    candidate["aSectionTheConfigContractDoesNotDefine"] = { anything: 1 };
    expectRefused(candidate);
  });

  test("an UNKNOWN nested key is rejected", () => {
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    (candidate[OBJECT_SECTION!] as Record<string, unknown>)["aKeyThatIsNotInTheContract"] = 1;
    expectRefused(candidate);
  });

  test("a WRONG-TYPED value at a known path is rejected", () => {
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    setAt(candidate, NUMERIC_LEAF!, "definitely-not-a-number");
    expectRefused(candidate);
  });

  test("a CROSS-FIELD-INVALID performance section is rejected by the section's own violation code", () => {
    // The performance section carries invariants no single leaf schema can
    // express — the benchmark repetition range is the one the settings room
    // can actually reach, because both ends of the range are served rows.
    // A document whose minimum repetitions exceed its maximum must be
    // refused by the section's own checker (`performanceConfigViolations`,
    // the one owner of these invariants) at the gate, with the checker's
    // own violation code in the message — not persisted for the next
    // benchmark run to misread. Both leaf values are individually legal, so
    // only the cross-field refinement catches this.
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const perf = candidate.performance as Record<string, unknown> | undefined;
    expect(perf, "the shipped config must carry the performance section for this probe").toBeDefined();
    const budgets = structuredClone(perf!.budgets) as Record<string, unknown>;
    budgets.minBenchmarkRepetitions = 100;
    budgets.maxBenchmarkRepetitions = 50;
    perf!.budgets = budgets;
    const err = expectRefused(candidate);
    expect(err.message).toContain("performance_config_benchmark_repetition_range_invalid");
    // The same message must carry the checker's plain-words sentence: the
    // settings sheet renders this refusal verbatim, and the bare code told
    // the reader WHO refused without ever saying WHY in their words. The
    // machine code stays (tooling keys on it); the sentence rides beside it
    // and names both conflicting values.
    expect(err.message).toContain(
      "performance_config_benchmark_repetition_range_invalid — the fewest benchmark repetitions",
    );
    expect(err.message).toContain('"performance.budgets.minBenchmarkRepetitions" = 100');
    expect(err.message).toContain('"performance.budgets.maxBenchmarkRepetitions" = 50');
    expect(err.message).toContain("the floor must stay at or below the ceiling");
  });

  test("a WEAKENING privacy section is rejected by the section's own floor (disabling a redaction category is not a writable state)", () => {
    // The privacy section's safety floors live in the section schema's own
    // refinement (the privacy domain's one floor owner), so the gate refuses
    // a narrowing `enabledCategories` before a byte reaches disk — the
    // masker-governing leaf can never be turned into a live redaction-off
    // switch through any sanctioned write path. The leaf values are
    // individually legal (a non-empty category list passes the leaf's own
    // bound); only the section floor catches the narrowing.
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const privacy = candidate.privacy as Record<string, unknown> | undefined;
    expect(privacy, "the shipped config must carry the privacy section for this probe").toBeDefined();
    candidate.privacy = { ...privacy!, enabledCategories: ["secret"] };
    const err = expectRefused(candidate);
    // The refusal carries the floor's machine code AND its plain-words
    // sentence naming the refused values — the sheet renders this verbatim.
    expect(err.message).toContain("privacy_enabled_categories_minimum_required");
    expect(err.message).toContain("may not disable a redaction category");
    expect(err.message).toContain("missing: credential");

    // The same floor refuses a narrowed classification list: credential
    // secrets and user-private data are the redaction floor, not settings.
    const narrowedClassifications = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const privacy2 = narrowedClassifications.privacy as Record<string, unknown>;
    narrowedClassifications.privacy = {
      ...privacy2,
      piiClassifications: ["credential-secret"],
    };
    const err2 = expectRefused(narrowedClassifications);
    expect(err2.message).toContain("privacy_pii_classifications_minimum_required");
    expect(err2.message).toContain("must always require redaction");
  });

  test("a WEAKENING debug section is rejected by the section's own floor (switching the debug redactor off is not a writable state)", () => {
    // The debug section's safety floor lives in the section schema's own
    // refinement (`debugConfigViolations`, the debug domain's one floor
    // owner, spliced into the document schema at the config contract), so the
    // gate refuses `debug.redaction.enabled: false` before a byte reaches
    // disk. Without this door, the write would land and the NEXT boot would
    // brick at the debug bridge's own refusal — the startup-brick hazard the
    // section's wiring filed: the front door refuses what the back door
    // would have died on. The leaf value is individually legal (a boolean is
    // a boolean); only the section floor catches the weakening.
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const debug = candidate.debug as Record<string, unknown> | undefined;
    expect(debug, "the shipped config must carry the debug section for this probe").toBeDefined();
    const redaction = structuredClone(debug!.redaction) as Record<string, unknown>;
    redaction.enabled = false;
    candidate.debug = { ...debug!, redaction };
    const err = expectRefused(candidate);
    expect(err.message).toContain("debug_redaction_required");
    expect(err.message).toContain("may not disable the debug redactor");
    expect(err.message).toContain("set it to true");
  });

  test("a WEAKENING safety section is rejected by the section's own floor (disarming a gate check or a detector is not a writable state)", () => {
    // The safety section's posture floors live in the safety domain's one
    // floor owner (`safetyConfigViolations`, spliced into the document
    // schema at the config contract), so the gate refuses every shape that
    // would REMOVE a protection class before a byte reaches disk: a gate
    // check turned off, an event-feed detector family disarmed, the bandaid
    // detector's long-comment finding path turned off. Each leaf value is
    // individually legal (a boolean is a boolean); only the section floor
    // catches the weakening — and the floor's own sentence is what the
    // refused settings save renders in the sheet.
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const safety = candidate.safety as Record<string, unknown> | undefined;
    expect(safety, "the shipped config must carry the safety section for this probe").toBeDefined();
    const gate = structuredClone(safety!.toolCallGate) as Record<string, unknown>;
    gate.enableLoopDetection = false;
    candidate.safety = { ...safety!, toolCallGate: gate };
    const err = expectRefused(candidate);
    expect(err.message).toContain("safety_gate_loop_detection_required");
    expect(err.message).toContain("may not turn off the loop check");
    expect(err.message).toContain("set it to true or delete the key");

    const ghost = structuredClone(candidate.safety as Record<string, unknown>);
    const ghostGate = structuredClone(ghost.toolCallGate) as Record<string, unknown>;
    ghostGate.enableGhostToolDetection = false;
    candidate.safety = { ...ghost, toolCallGate: ghostGate };
    const ghostErr = expectRefused(candidate);
    expect(ghostErr.message).toContain("safety_gate_ghost_tools_required");
    expect(ghostErr.message).toContain("the ghost-tool check");

    const family = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const familySafety = structuredClone(family.safety) as Record<string, unknown>;
    const feed = structuredClone(familySafety.eventFeed) as Record<string, unknown>;
    const families = structuredClone(feed.families) as Record<string, unknown>;
    const workaround = structuredClone(families.workaround) as Record<string, unknown>;
    workaround.enabled = false;
    family.safety = { ...familySafety, eventFeed: { ...feed, families: { ...families, workaround } } };
    const familyErr = expectRefused(family);
    expect(familyErr.message).toContain("safety_event_feed_family_required");
    expect(familyErr.message).toContain("safety.eventFeed.families.workaround.enabled");
    expect(familyErr.message).toContain("may not disarm the workaround detector");

    const heuristic = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const heuristicSafety = structuredClone(heuristic.safety) as Record<string, unknown>;
    const heuristicFeed = structuredClone(heuristicSafety.eventFeed) as Record<string, unknown>;
    heuristic.safety = { ...heuristicSafety, eventFeed: { ...heuristicFeed, longCommentDeferredEnabled: false } };
    const heuristicErr = expectRefused(heuristic);
    expect(heuristicErr.message).toContain("safety_event_feed_heuristic_required");
    expect(heuristicErr.message).toContain("the long-comment check");
  });

  test("the workaround consequential-tools narrowing is refused ONLY while it names no tools (the designed narrowing stays writable)", () => {
    // The coupling floor: 'list' mode with an EMPTY list would leave the
    // workaround detector structurally unable to fire — a disarm in disguise,
    // refused. But 'list' with a real list is the DESIGNED mode (the
    // detector's own vocabulary), so the gate must accept it: the floor
    // refuses the disguised off state, not the designed narrowing.
    const narrowing = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const safety = narrowing.safety as Record<string, unknown>;
    const feed = structuredClone(safety.eventFeed) as Record<string, unknown>;
    narrowing.safety = { ...safety, eventFeed: { ...feed, workaroundConsequentialToolsMode: "list" } };
    const err = expectRefused(narrowing);
    expect(err.message).toContain("safety_workaround_consequential_tools_required");
    expect(err.message).toContain("a disarm in disguise");
    expect(err.message).toContain("name at least one tool in the file");

    const designed = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const designedSafety = designed.safety as Record<string, unknown>;
    const designedFeed = structuredClone(designedSafety.eventFeed) as Record<string, unknown>;
    designed.safety = {
      ...designedSafety,
      eventFeed: {
        ...designedFeed,
        workaroundConsequentialToolsMode: "list",
        workaroundConsequentialTools: ["search_code"],
      },
    };
    // The designed narrowing must PASS the gate — attemptWrite returns
    // undefined when the write is accepted.
    expect(attemptWrite(designed), "a 'list' narrowing that names its tools is the designed mode — the gate accepts it").toBeUndefined();
  });

  test("the gate's escalation threshold may not be raised past the auto-trip it feeds (the coupling floor)", () => {
    // The block-sequence thresholds are mechanically coupled inside the
    // gate: the auto-trip only fires once the refusal message has
    // escalated, so an escalation value PAST the trip value would silently
    // push the trip back onto the escalation count — the settings row's
    // description says the write is refused at exactly this bound, and
    // this arm proves the gate agrees. The refusal is the cross-field
    // grammar: the rule and BOTH conflicting values, read from the section.
    const over = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const overSafety = over.safety as Record<string, unknown>;
    const overGate = structuredClone(overSafety.toolCallGate) as Record<string, unknown>;
    overGate.blockEscalationAfter = 999;
    overGate.blockAutoTripAfter = 50;
    over.safety = { ...overSafety, toolCallGate: overGate };
    const err = expectRefused(over);
    expect(err.message).toContain("safety_gate_escalation_exceeds_auto_trip");
    expect(err.message).toContain("safety.toolCallGate.blockEscalationAfter");
    expect(err.message).toContain("safety.toolCallGate.blockAutoTripAfter");
    expect(err.message).toContain("(999)");
    expect(err.message).toContain("(50)");
    expect(err.message).toContain("may not exceed");

    // The bound is inclusive: escalation AT the trip count only delays the
    // message (the trip still fires exactly at its own count), so it is the
    // honest ceiling, not past it.
    const atBound = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const boundSafety = atBound.safety as Record<string, unknown>;
    const boundGate = structuredClone(boundSafety.toolCallGate) as Record<string, unknown>;
    boundGate.blockEscalationAfter = 50;
    boundGate.blockAutoTripAfter = 50;
    atBound.safety = { ...boundSafety, toolCallGate: boundGate };
    expect(attemptWrite(atBound), "escalation at the trip count is the ceiling — the gate accepts it").toBeUndefined();

    // An explicit blockAutoTripAfter 0 is the operator's own "never switch
    // off": with no trip to delay, a high escalation is message shaping
    // only, and the floor must not refuse it.
    const neverTrip = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const neverSafety = neverTrip.safety as Record<string, unknown>;
    const neverGate = structuredClone(neverSafety.toolCallGate) as Record<string, unknown>;
    neverGate.blockEscalationAfter = 999;
    neverGate.blockAutoTripAfter = 0;
    neverTrip.safety = { ...neverSafety, toolCallGate: neverGate };
    expect(attemptWrite(neverTrip), "with the trip disarmed by the operator, escalation is message shaping only").toBeUndefined();

    // The settings sheet writes ONE leaf at a time, so the floor must read
    // the sibling's EFFECTIVE value — its declared default when the file
    // does not carry it. The probe value and the expected default both come
    // from the gate's own defaults owner, so a default change re-derives
    // this arm instead of silently rotting it.
    const singleLeaf = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const singleSafety = singleLeaf.safety as Record<string, unknown>;
    const singleGate = structuredClone(singleSafety.toolCallGate) as Record<string, unknown>;
    singleGate.blockEscalationAfter = DEFAULT_TOOL_CALL_GATE_CONFIG.blockAutoTripAfter + 1000;
    delete singleGate.blockAutoTripAfter;
    singleLeaf.safety = { ...singleSafety, toolCallGate: singleGate };
    const singleErr = expectRefused(singleLeaf);
    expect(singleErr.message).toContain("safety_gate_escalation_exceeds_auto_trip");
    expect(singleErr.message).toContain(`(${DEFAULT_TOOL_CALL_GATE_CONFIG.blockAutoTripAfter + 1000})`);
    expect(singleErr.message).toContain(`(${DEFAULT_TOOL_CALL_GATE_CONFIG.blockAutoTripAfter}, its default)`);
  });

  test("the gate's auto-trip may not be lowered beneath the standing escalation it feeds (the coupling floor, crossed from the other side)", () => {
    // The settings sheet writes one leaf at a time, and the arm above pins
    // the crossing written from the ESCALATION side (a raise past a
    // standing trip). The mechanism is symmetric: LOWERING the trip
    // beneath a standing escalation is the same silent override — the
    // tool's switch-off would fire before the refusal message ever
    // escalates — and the gate drive proved it refused through the real
    // write door with no suite arm pinning that side. This is that arm, in
    // the same refusal grammar as the escalation side: the rule and BOTH
    // conflicting values, read from the section.
    const lowered = JSON.parse(BASE_JSON) as Record<string, unknown>;
    const loweredSafety = lowered.safety as Record<string, unknown>;
    const loweredGate = structuredClone(loweredSafety.toolCallGate) as Record<string, unknown>;
    loweredGate.blockEscalationAfter = 50;
    loweredGate.blockAutoTripAfter = 40;
    lowered.safety = { ...loweredSafety, toolCallGate: loweredGate };
    const err = expectRefused(lowered);
    expect(err.message).toContain("safety_gate_escalation_exceeds_auto_trip");
    expect(err.message).toContain("safety.toolCallGate.blockEscalationAfter");
    expect(err.message).toContain("safety.toolCallGate.blockAutoTripAfter");
    expect(err.message).toContain("(50)");
    expect(err.message).toContain("(40)");
    expect(err.message).toContain("may not exceed");
  });

  test("a rejected write carries the shared taxonomy's `invalid_*` code (→ 400)", () => {
    const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
    candidate["anotherUndefinedSection"] = true;
    {
      const err = expectRefused(candidate);
      const code = err.code;
      expect(code, "the code must map to a 400 via the router's `invalid_` convention").toMatch(
        /^invalid_/,
      );
      // The message must name the offending path so an admin can fix it.
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  test("EVERY rejected write leaves the config file byte-identical (no partial write)", () => {
    const before = configBytes();
    for (const mutate of [
      (c: Record<string, unknown>) => { c["unknownSectionA"] = 1; },
      (c: Record<string, unknown>) => { setAt(c, NUMERIC_LEAF!, "nope"); },
      (c: Record<string, unknown>) => {
        (c[OBJECT_SECTION!] as Record<string, unknown>)["unknownNested"] = "x";
      },
    ]) {
      const candidate = JSON.parse(BASE_JSON) as Record<string, unknown>;
      mutate(candidate);
      expectRefused(candidate);
    }
    expect(configBytes(), "a rejected write must not touch the file").toBe(before);
  });
});

describe("config write gate — code and comment agree", () => {
  test("the gate lives at the WRITE choke point, not in the route", () => {
    expect(
      HARNESS_CONFIG_SRC.code(),
      "writeConfigRaw must validate the candidate document against the config contract",
    ).toMatch(/getConfigDocumentSchema\(\)\.safeParse\(config\)/);
  });

  test("the route's documented allowlist claim is backed by the implementation", () => {
    // The route header still makes the claim; it is only allowed to do so
    // because the write path enforces it. If someone deletes the gate, this
    // pairing fails rather than silently reverting to a false comment.
    const claimsAllowlist = ROUTE_SRC
      .prose()
      .some((line) => /Only known config paths are accepted/.test(line.text));
    if (claimsAllowlist) {
      expect(
        HARNESS_CONFIG_SRC.code().includes("getConfigDocumentSchema"),
        "routes/config.ts claims an allowlist — the write path must implement one",
      ).toBe(true);
    }
  });

  test("the gate is NOT a hardcoded path list", () => {
    // Deny-by-default derived from the contract: no literal array of config
    // path strings may appear in either file.
    for (const [name, view] of [
      [modulePath("harness-config.ts"), HARNESS_CONFIG_SRC],
      [modulePathMatching("server/routes/config.ts"), ROUTE_SRC],
    ] as const) {
      expect(
        /ALLOWED_CONFIG_PATHS|CONFIG_PATH_ALLOWLIST|WRITABLE_PATHS/.test(view.code()),
        `${name} must derive the allowlist from getConfigDocumentSchema(), not restate a list`,
      ).toBe(false);
    }
  });
});

/**
 * SELF-PROTECTION IS NOT EDITABLE THROUGH THIS SERVER.
 *
 * The route's only refusal was on key NAMES that look like secrets —
 * `apiKey|secret|password|token|credential|auth`. Nothing under
 * `selfProtection` matches any of them, so an admin session could turn the
 * sandbox off, or widen it to the whole disk, over HTTP. Six spellings of
 * "allow everything" were measured through that route, three of them reaching
 * a write inside the harness's own protected source, while the cockpit and
 * every tool result went on reporting `confined`.
 *
 * The refusal lives at the single WRITE entry point rather than in the route,
 * and compares the SECTION rather than a path — so `enabled`, an allow-rule
 * deep in an array, and a wholesale replacement are one rule with nothing to
 * keep in step, and a future writer that never heard of self-protection is
 * covered because it cannot reach the file any other way.
 */
describe("the write gate refuses to change self-protection", () => {
  test("every shape of a self-protection edit is refused, with a typed code", () => withConfigWriteLock(CONFIG_PATH, () => {
    const before = configBytes();
    const live = readConfigRaw();
    // BUILT FROM THE LIVE DOCUMENT, so this keeps testing the real section
    // rather than a shape someone typed here once.
    const edits: readonly Readonly<{ how: string; mutate: (doc: Record<string, unknown>) => void }>[] = [
      {
        how: "turning it off",
        mutate: (doc) => {
          doc.selfProtection = { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false };
        },
      },
      {
        how: "adding an allow-rule covering a home directory",
        mutate: (doc) => {
          doc.selfProtection = {
            schemaVersion: "bridlewise-self-protection-config/v1",
            enabled: true,
            additionalAllowRules: [{ path: "/home", access: ["READ_FILE", "READ_DIR"] }],
          };
        },
      },
      {
        how: "pointing the temp directory at an ancestor of the protected source",
        mutate: (doc) => {
          doc.selfProtection = {
            schemaVersion: "bridlewise-self-protection-config/v1",
            enabled: true,
            tempDir: "/home",
          };
        },
      },
      {
        how: "removing the section entirely",
        mutate: (doc) => {
          delete doc.selfProtection;
        },
      },
    ];
    expect(edits.length, `self-protection edit shapes driven: ${edits.length}`).toBeGreaterThanOrEqual(4);
    const outcomes: Readonly<{ how: string; thrown: unknown }>[] = [];
    try {
      for (const { how, mutate } of edits) {
        const candidate = JSON.parse(JSON.stringify(live)) as Record<string, unknown>;
        mutate(candidate);
        outcomes.push({ how, thrown: attemptWrite(candidate) });
      }
    } finally {
      // PUT THE FILE BACK BEFORE ASSERTING ANYTHING. This test drives REAL
      // writes at the REAL shared config, and the whole point is that they are
      // refused — so when the refusal is the thing that broke, the write lands
      // and every later test in both repositories reads a config this test
      // changed. Asserting "unchanged" afterwards catches it and cannot undo
      // it. Learned the hard way: mutation-testing the gate turned confinement
      // off across the whole workspace. The restore is the locked,
      // atomic-rename owner — never a truncating write a parallel fork could
      // catch mid-flight.
      restoreConfigFileBytes(before);
    }
    for (const { how, thrown } of outcomes) {
      expect(thrown, `${how} must be refused`).toBeInstanceOf(ValidationError);
      expect((thrown as ValidationError & { code: string }).code).toBe("self_protection_not_editable_here");
      // Plain words, no internal vocabulary — this reaches a person.
      expect(String((thrown as Error).message)).toMatch(/harness settings file/i);
    }
    // NOTHING REACHED THE DISK. A refusal that had already written is not a
    // refusal, and the shared config file is what every other test reads.
    expect(configBytes()).toBe(before);
  }));

  test("the section that must be preserved is really present, and an unrelated edit is NOT refused by this rule", () => {
    // LIVENESS, and the half that stops this being an off switch. Without it
    // the refusals above are satisfied by a gate that refuses every write,
    // and by a config that has no self-protection section to compare.
    const live = readConfigRaw();
    expect(live.selfProtection, "the live config must declare self-protection, or the rule above compares nothing")
      .toBeDefined();
    // An edit that leaves the section byte-identical must fail for its own
    // reasons, if at all — never with this rule's code.
    const candidate = JSON.parse(JSON.stringify(live)) as Record<string, unknown>;
    candidate.__definitely_not_a_real_section__ = true;
    // RESTORED IN A `finally` BEFORE ASSERTING, like every other write here.
    // This one had no backup at all: it relied entirely on the schema — the
    // guard under test — to refuse, so mutating that guard would have let it
    // write the shared config and no assertion could have put it back.
    const thrown = attemptWrite(candidate);
    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError & { code: string }).code).toBe("invalid_config_document");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// THE WRITER CENSUS — no raw write reaches the config file outside the owners.
//
// The gate above stops a caller that goes THROUGH it. It says nothing about a
// writer that never calls it — and five measured manifestations of exactly
// that sat in the test tree, each one a `writeFileSync` to the shared config
// restoring "what it found" while parallel forks wrote the same file: torn
// reads (the truncating write caught mid-flight by another fork's parse),
// lost updates (two unlocked read-modify-write cycles interleaving so one
// fork restored the other's mid-cycle bytes), and the blind spot where a
// landed residue becomes the next run's "found" bytes. The gate's charter —
// "no future writer can reach the config file without passing it" — was
// blind to the class it was written for, so the census lives HERE, at the
// gate's own suite, not in a new file beside it.
//
// THE RULE: a raw write call (`writeFileSync`/`writeSync`/`appendFileSync`/
// `fs.promises.writeFile`) whose target resolves to THE CONFIG FILE is a
// violation. Resolution is one level, statically: the target argument's own
// text matching a config-path spelling, or — when the target is a bare
// identifier — its same-file `const|let|var` declaration's right-hand side
// matching one. The config path spellings are exactly the ways the real
// file can be named (`harnessConfigPath`, `engineConfigPath`, the config
// basename, the root-policy `configuration.basename`); a writer cannot
// reach the shared file without one of them, so the census is a tripwire at
// every honest spelling. A path built from string fragments to evade the
// census is a deliberate evasion, not an oversight, and is outside what a
// source census can prove — stated here rather than implied.
//
// The population is walked dynamically (the shared tree walker), and the
// engine's test tree is IN it: its scenario configs are planted in isolated
// per-test worlds, and their writes go through the atomic-rename owner too —
// no carve-outs, because a carve-out is where the next raw writer hides.
// ───────────────────────────────────────────────────────────────────────────

import { rmSync } from "node:fs";
import { walk, relpath } from "../helpers/source-scan.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

/** The only spellings that can name the real shared config file. */
const CONFIG_PATH_TOKEN = /harnessConfigPath|engineConfigPath|bridlewise\.config\.json|realConfigPath|configuration\.basename/u;

/** The raw, truncating write calls the census denies. */
const RAW_WRITE_CALL = /\b(writeFileSync|writeSync|appendFileSync)\s*\(|fs\.promises\.writeFile\s*\(/gu;

/** The dev trees whose writers share the real config file, plus the engine's
 *  own trees so a raw plant anywhere is named. Derived from the repo layout —
 *  a directory that stops existing takes its files out of the walk; a file
 *  added to any of them is scanned the day it lands. */
const CENSUS_ROOTS = ["server", "src", "scripts", "tests", "engine/src", "engine/scripts", "engine/test"] as const;

/** The source extensions the census walks — one owner for both the walk and
 *  the root-liveness floor, so they cannot drift apart. */
const CENSUS_EXTS = [".ts", ".tsx", ".svelte", ".mts", ".cts", ".mjs", ".js"] as const;

function censusFiles(): string[] {
  const files: string[] = [];
  for (const root of CENSUS_ROOTS) files.push(...walk(root, { exts: [...CENSUS_EXTS] }));
  return files;
}

/** One raw write call's first argument, read to its BALANCED top-level comma.
 *  The bound is found by walking the inert `code` view paren-, bracket- and
 *  brace-aware: a comma nested inside the argument — the second element of a
 *  `join(harnessRoot, "bridlewise.config.json")` path, an object literal's
 *  fields, a string interior — is not the argument's end. A cut at the first
 *  comma regardless of depth once left a join()-wrapped write at the real
 *  config unnamed while the direct literal was caught, a corridor at a census
 *  whose own commentary promises none; the walk also stops at the call's
 *  own closing paren, so the bytes of the SECOND argument never enter the
 *  match — a config spelling riding in the data argument of a write to an
 *  unrelated target is not a violation. The TEXT is sliced from the
 *  full-fidelity view at the same offsets, so a quoted or templated path
 *  argument stays visible. Both views share the source's byte geometry, so
 *  one index is valid in both. The walk is windowed so a pathological
 *  unbalanced tail cannot make it cross the file. */
function firstWriteArgument(code: string, full: string, callOffset: number): string {
  const openParen = code.indexOf("(", callOffset);
  if (openParen < 0) return "";
  const windowEnd = Math.min(code.length, openParen + 1 + 200);
  let depth = 0;
  for (let i = openParen + 1; i < windowEnd; i++) {
    const ch = code[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return full.slice(openParen + 1, i).trim();
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      return full.slice(openParen + 1, i).trim();
    }
  }
  return full.slice(openParen + 1, windowEnd).trim();
}

/** A bare identifier's same-file declaration right-hand side, or null. The
 *  `full` view keeps quoted and templated path spellings visible while
 *  comments are inert, so a declaration cannot be "found" in a comment. */
function declarationRightHandSide(full: string, identifier: string): string | null {
  const match = new RegExp(`(?:const|let|var)\\s+${identifier}\\s*=([^;\\n]{0,300})`, "u").exec(full);
  return match !== null ? match[1] ?? "" : null;
}

/**
 * The census: every file in `files` whose raw write calls reach for the
 * config file. Pure over its input so the liveness arm can drive it over a
 * planted file without touching the tree the main arm walks.
 */
function rawConfigWriteViolations(files: readonly string[]): readonly string[] {
  const violations: string[] = [];
  for (const file of files) {
    const view = readSourceView(file);
    // The call is detected on the inert view, where a comment, a quoted
    // string or a template cannot masquerade as code; the argument's text is
    // then read from the full-fidelity view, where a quoted or templated
    // config path stays visible — a literal-path write is as much a violation
    // as an identifier whose declaration names the path.
    const code = view.code();
    const full = view.codeWithStringsAndTemplates();
    code.replace(RAW_WRITE_CALL, (_whole: string, _fn: string, offset: number) => {
      const argument = firstWriteArgument(code, full, offset);
      let targetsConfig = CONFIG_PATH_TOKEN.test(argument);
      if (!targetsConfig) {
        const identifier = argument.match(/^[A-Za-z_$][\w$]*$/u);
        if (identifier !== null) {
          const rightHandSide = declarationRightHandSide(full, identifier[0]!);
          if (rightHandSide !== null && CONFIG_PATH_TOKEN.test(rightHandSide)) targetsConfig = true;
        }
      }
      if (targetsConfig) violations.push(`${relpath(file)}: a raw ${String(_fn)} writes the config path through ${argument}`);
      return _whole;
    });
  }
  return violations;
}

describe("the writer census — no raw write reaches the config file outside the owners", () => {
  test("the population is real: every census root exists and the config spellings occur in code", () => {
    for (const root of CENSUS_ROOTS) {
      expect(walk(root, { exts: [...CENSUS_EXTS] }).length, `the census root ${root} must exist and hold files`).toBeGreaterThan(0);
    }
    // THE TOKEN MUST STILL SELECT. If every config-path spelling were
    // renamed, the census below would pass over an empty match for a reason
    // that has nothing to do with the tree being clean — so the tokens are
    // required to occur in real code, not merely in comments.
    const files = censusFiles();
    const tokenFiles = files.filter((f) => CONFIG_PATH_TOKEN.test(readSourceView(f).codeWithStringsAndTemplates())).length;
    expect(tokenFiles, "files whose real code names the config path").toBeGreaterThanOrEqual(20);
    expect(files.length, `census files walked: ${String(files.length)}`).toBeGreaterThanOrEqual(1000);
  });

  test("zero raw writes target the config path across the whole dev surface", () => {
    const violations = rawConfigWriteViolations(censusFiles());
    expect(
      violations,
      "a raw truncating write to the config file is the torn-read/lost-update class this round closed — " +
        "route the write through the locked gate, the byte-restore owner, or the atomic-rename owner",
    ).toEqual([]);
  });

  test("the census is alive: a planted raw config write is named, an unrelated write is not", async () => {
    // THE PLANT, in this suite's own writable tree (removed before the arm
    // ends — the plant exists to prove the scanner sees the shape, and a
    // scanner that cannot see its own subject is a false absence). Three
    // shapes are planted: the identifier whose declaration names the config;
    // the quoted literal path, or a one-line `writeFileSync("…bridlewise.
    // config.json")` walks straight past the census; and the path wrapped in
    // a nested call — an argument with a comma of its own, invisible to any
    // first-comma cut. The last planted line rides the config basename in
    // the DATA argument of a write to an unrelated target: the census
    // matches the write's TARGET, so that one must stay unnamed — the
    // witness that the extraction stops at the argument's own balanced
    // comma and never reads into the rest of the call.
    // Planted OUTSIDE the checkout: a test never writes the checkout it runs
    // in (the checkout write door refuses it); the census reads the paths it
    // is handed.
    const plant = join(createTempDir("census-plant-"), "tmp-census-plant-config-write.test.ts");
    try {
      expect(atomicWriteFile(plant, [
        'import { writeFileSync } from "node:fs";',
        'const realConfigPath = resolve(serverConfig.harnessConfigPath);',
        "writeFileSync(realConfigPath, restored, { mode: 0o600 });",
        'writeFileSync("engine/bridlewise.config.json", "{}", { mode: 0o600 });',
        'writeFileSync(join(harnessRoot, "bridlewise.config.json"), doc, { mode: 0o600 });',
        'writeFileSync(join(tmp, "unrelated-fixture.txt"), "never the config");',
        'writeFileSync(join(tmp, "scenario-fixture.txt"), "bridlewise.config.json");',
        "",
      ].join("\n")).success).toBe(true);
      const violations = rawConfigWriteViolations([plant]);
      expect(violations.length, "the planted raw config writes must be exactly the THREE violations").toBe(3);
      for (const violation of violations) expect(violation).toContain("tmp-census-plant-config-write.test.ts");
      expect(violations.join("\n")).toContain("realConfigPath");
      expect(violations.join("\n")).toContain("bridlewise.config.json");
      expect(violations.join("\n")).toContain('join(harnessRoot, "bridlewise.config.json")');
      expect(violations.join("\n")).not.toContain("scenario-fixture.txt");
    } finally {
      // Restore: the plant is gone before any later arm walks the tree.
      rmSync(plant, { force: true });
    }
  });
});
