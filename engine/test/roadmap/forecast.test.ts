/**
 * HONEST MILESTONE FORECASTS (scripts/roadmap/forecast.ts): a seeded
 * Monte-Carlo band that is the same for the same inputs and never sooner for
 * more remaining, an `unknown` with its plain reason for each guard (and a
 * band exactly at each guard's edge), and the ISO-8601 week arithmetic across
 * year boundaries, checked against an independent rule for 53-week years.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { addIsoWeeks, forecast, isoTime, isoWeek, isoWeeksBetween, type ForecastInput } from "../../scripts/roadmap/forecast.ts";

const BASE: ForecastInput = { remaining: 20, weekly: [0, 1, 5, 2, 0, 3, 8, 1], weeksOfData: 12, seed: "roadmap@abc123", asOfWeek: "2026-W43" };

const code = (expected: string) => (error: unknown): boolean => (error as { code?: string }).code === expected;

test("the same inputs give the same band; another seed draws another sample", () => {
  const first = forecast(BASE);
  assert.deepEqual(forecast({ ...BASE }), first);
  assert.equal(first.kind, "band");
  const bands = ["a", "b", "c", "d", "e", "f", "g", "h"].map((seed) => JSON.stringify(forecast({ ...BASE, seed })));
  assert.ok(new Set(bands).size > 1, "different seeds never differing would mean the seed is ignored");
});

test("a band is p50 ≤ p85, its weeks counted from the week it is made in, by the named method", () => {
  const band = forecast(BASE);
  assert.ok(band.kind === "band");
  assert.ok(band.p50Weeks >= 1 && band.p50Weeks <= band.p85Weeks, `${String(band.p50Weeks)} ≤ ${String(band.p85Weeks)}`);
  assert.equal(band.p50Week, addIsoWeeks(BASE.asOfWeek, band.p50Weeks));
  assert.equal(band.p85Week, addIsoWeeks(BASE.asOfWeek, band.p85Weeks));
  assert.equal(band.method, "monte-carlo-bootstrap/v1");
  assert.equal(band.remaining, 20);
  assert.equal(band.weeksOfData, 12);
});

test("a constant pace forecasts exactly, across a 53-week year's end", () => {
  // 2 a week for 5 remaining: every trial needs exactly 3 weeks; 2026 has a W53.
  assert.deepEqual(forecast({ ...BASE, remaining: 5, weekly: [2, 2, 2, 2], asOfWeek: "2026-W52" }), {
    kind: "band", remaining: 5, p50Weeks: 3, p85Weeks: 3, p50Week: "2027-W02", p85Week: "2027-W02", weeksOfData: 12, method: "monte-carlo-bootstrap/v1",
  });
});

test("more remaining never forecasts sooner (each trial replays its own draws further)", () => {
  let previous = { p50: 0, p85: 0 };
  for (let remaining = 1; remaining <= 60; remaining += 1) {
    const band = forecast({ ...BASE, remaining, trials: 400 });
    assert.ok(band.kind === "band", `remaining ${String(remaining)}`);
    assert.ok(band.p50Weeks >= previous.p50 && band.p85Weeks >= previous.p85, `remaining ${String(remaining)}: ${JSON.stringify(band)} after ${JSON.stringify(previous)}`);
    assert.ok(band.p85Weeks >= band.p50Weeks);
    previous = { p50: band.p50Weeks, p85: band.p85Weeks };
  }
});

test("nothing remaining is complete, whatever the history", () => {
  assert.deepEqual(forecast({ ...BASE, remaining: 0, weekly: [], weeksOfData: 0 }), { kind: "complete" });
});

test("each guard answers unknown with its plain reason, and a band exactly at its edge", () => {
  assert.deepEqual(forecast({ ...BASE, weeksOfData: 1 }), {
    kind: "unknown", remaining: 20, reason: "needs 3 more weeks of history (has 1 of the 4 a forecast needs)", weeksOfData: 1, method: "monte-carlo-bootstrap/v1",
  });
  assert.equal((forecast({ ...BASE, weeksOfData: 3 }) as { reason: string }).reason, "needs 1 more week of history (has 3 of the 4 a forecast needs)");
  assert.equal(forecast({ ...BASE, weeksOfData: 4 }).kind, "band", "exactly the minimum history is enough");
  assert.equal((forecast({ ...BASE, weekly: [0, 1, 0, 1] }) as { reason: string }).reason, "only 2 items closed in the last 4 weeks; a forecast needs at least 3");
  assert.equal((forecast({ ...BASE, weekly: [0, 1, 0, 0] }) as { reason: string }).reason, "only 1 item closed in the last 4 weeks; a forecast needs at least 3");
  assert.equal((forecast({ ...BASE, weekly: [] }) as { reason: string }).reason, "only 0 items closed in the last 0 weeks; a forecast needs at least 3");
  assert.equal(forecast({ ...BASE, weekly: [0, 1, 0, 2] }).kind, "band", "exactly the minimum closed is enough");
  assert.equal((forecast({ ...BASE, remaining: 1000, weekly: [0, 0, 0, 3], horizonWeeks: 10 }) as { reason: string }).reason,
    "only 0 of 2000 trials finish within 10 weeks at the recent pace; a forecast needs 85%");
  assert.equal((forecast({ ...BASE, weekly: [0, 0, 0, 0], minClosed: 0, trials: 50 }) as { reason: string }).reason,
    "only 0 of 50 trials finish within 520 weeks at the recent pace; a forecast needs 85%");
  // Some trials finish, but not 85% of them: still unknown (a p85 beyond the horizon is no number).
  const partly = forecast({ ...BASE, remaining: 6, weekly: [0, 0, 0, 0, 0, 0, 0, 0, 0, 6], horizonWeeks: 10, trials: 200 });
  assert.equal(partly.kind, "unknown");
  assert.match((partly as { reason: string }).reason, /^only \d+ of 200 trials finish within 10 weeks/u);
});

test("malformed inputs are refused typed, never coerced", () => {
  for (const input of [{ remaining: -1 }, { remaining: 1.5 }, { weekly: [1, -2] }, { weekly: [1, Number.NaN] }, { weeksOfData: -3 }, { trials: 0 }, { horizonWeeks: 0 }, { minWeeks: 0 }]) {
    assert.throws(() => forecast({ ...BASE, ...input }), code("roadmap_forecast_input_invalid"), JSON.stringify(input));
  }
  for (const asOfWeek of ["2025-W53", "2026-W00", "2026-W54", "2026-43", "2026-w43"]) {
    assert.throws(() => forecast({ ...BASE, asOfWeek }), code("roadmap_iso_week_invalid"), asOfWeek);
  }
});

/** An independent rule: a year has 53 ISO weeks when it opens on a Thursday, or is a leap year opening on a Wednesday. */
function hasWeek53(year: number): boolean {
  const opens = new Date(Date.UTC(year, 0, 1)).getUTCDay();
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return opens === 4 || (leap && opens === 3);
}

test("ISO weeks: year boundaries, 53-week years computed (not assumed), and arithmetic that round-trips", () => {
  assert.equal(isoWeek("2026-12-31"), "2026-W53");
  assert.equal(isoWeek("2027-01-03"), "2026-W53");
  assert.equal(isoWeek("2027-01-04"), "2027-W01");
  assert.equal(isoWeek("2025-12-28"), "2025-W52");
  assert.equal(isoWeek("2025-12-29"), "2026-W01", "a December day can open the next ISO year");
  assert.equal(isoWeek("2024-12-30"), "2025-W01");
  assert.equal(isoWeek("2021-01-03"), "2020-W53", "a January day can close the previous ISO year");
  assert.equal(isoWeek("2026-01-04T23:30:00-05:00"), "2026-W02", "a timestamp is read in UTC (here Monday 04:30Z)");
  assert.equal(addIsoWeeks("2026-W52", 1), "2026-W53");
  assert.equal(addIsoWeeks("2026-W53", 1), "2027-W01");
  assert.equal(addIsoWeeks("2025-W52", 1), "2026-W01", "2025 has no W53");
  assert.equal(addIsoWeeks("2027-W01", -1), "2026-W53");
  assert.equal(isoWeeksBetween("2025-W52", "2027-W01"), 54);
  assert.equal(isoWeeksBetween("2027-W01", "2025-W52"), -54);
  for (let year = 2015; year <= 2040; year += 1) {
    assert.equal(isoWeek(`${String(year)}-12-28`), `${String(year)}-W${hasWeek53(year) ? "53" : "52"}`, `the last ISO week of ${String(year)} holds its 28 December`);
    if (hasWeek53(year)) assert.doesNotThrow(() => addIsoWeeks(`${String(year)}-W53`, 0));
    else assert.throws(() => addIsoWeeks(`${String(year)}-W53`, 0), code("roadmap_iso_week_invalid"));
  }
  for (let n = -120; n <= 120; n += 7) {
    const week = addIsoWeeks("2026-W43", n);
    assert.equal(isoWeeksBetween("2026-W43", week), n);
    assert.equal(addIsoWeeks(week, -n), "2026-W43");
  }
});

test("ISO dates: a whole day's edges, and days the calendar does not have refused", () => {
  assert.equal(isoTime("2026-10-21", "start"), Date.parse("2026-10-21T00:00:00.000Z"));
  assert.equal(isoTime("2026-10-21", "end"), Date.parse("2026-10-21T23:59:59.999Z"));
  assert.equal(isoTime("2026-10-21T12:00:00Z", "end"), Date.parse("2026-10-21T12:00:00Z"), "a timestamp is its own instant");
  for (const date of ["2026-02-30", "2026-13-01", "2026-10-21T25:00:00Z", "21/10/2026", "yesterday", ""]) {
    assert.throws(() => isoTime(date, "start"), code("roadmap_date_invalid"), date);
  }
  assert.throws(() => addIsoWeeks("2026-W43", 1.5), code("roadmap_week_count_invalid"));
});
