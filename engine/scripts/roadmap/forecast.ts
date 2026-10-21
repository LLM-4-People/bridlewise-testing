/**
 * HONEST MILESTONE FORECASTS — a measured band or a plain "unknown", never a
 * promised date (`Forecast`, ./types.ts).
 *
 * A band is a Monte-Carlo bootstrap of the project's own recent throughput:
 * each trial draws a week's closed count uniformly from the last N weeks
 * (`weekly`, oldest first) until the trial's cumulative count reaches the
 * remaining scope; the band is the 50th and 85th percentile (nearest rank) of
 * the trials' week counts. The draws come from the engine's ONE seeded source
 * (`seededRandom`, src/shared/stats.ts), seeded from SHA-256 digests, so
 * the same inputs give the same forecast in every process. Each trial draws
 * from its OWN stream (seeded from the seed and the trial's number), so a
 * larger remaining scope replays every trial's same draws further: more
 * remaining never forecasts sooner.
 *
 * The forecast refuses to guess. It answers `unknown`, with the reason in
 * plain English, when the history is shorter than `minWeeks`, when the window
 * closed fewer than `minClosed` items, or when fewer than 85% of the trials
 * finish within `horizonWeeks`. No clock is read: the weeks are counted from
 * `asOfWeek`, which the caller takes from a commit's own time.
 *
 * The ISO-8601 week arithmetic every roadmap module counts in lives here too
 * ({@link isoTime}, {@link isoWeek}, {@link addIsoWeeks},
 * {@link isoWeeksBetween}): weeks start on Monday, week 1 holds the year's
 * first Thursday, and a year has 52 or 53 weeks — computed, never assumed.
 */
import { InputError } from "../../src/kernel/errors.ts";
import { deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { seededRandom } from "../../src/shared/stats.ts";

import type { Forecast } from "./types.ts";

const METHOD = "monte-carlo-bootstrap/v1";
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ISO_WEEK = /^(\d{4})-W(\d{2})$/u;

/** Midnight UTC of the Monday that opens ISO week 1 of `year`. */
function firstMonday(year: number): number {
  const january4 = Date.UTC(year, 0, 4);
  return january4 - ((new Date(january4).getUTCDay() + 6) % 7) * DAY_MS;
}

/** The number of ISO weeks of `year` (52 or 53). */
function weeksInYear(year: number): number {
  return Math.round((firstMonday(year + 1) - firstMonday(year)) / WEEK_MS);
}

/** Midnight UTC of the Monday that opens `week` (`YYYY-Www`); a week its year does not have is refused. */
function mondayOf(week: string): number {
  const match = ISO_WEEK.exec(week);
  const year = Number(match?.[1]);
  const number = Number(match?.[2]);
  if (match === null || number < 1 || number > weeksInYear(year)) {
    throw new InputError(`${JSON.stringify(week)} is not an ISO week (YYYY-Www, a week its year has)`, "roadmap_iso_week_invalid");
  }
  return firstMonday(year) + (number - 1) * WEEK_MS;
}

/**
 * The instant `date` names, in milliseconds since the epoch: an ISO timestamp
 * as written, an ISO date (`YYYY-MM-DD`, UTC) at its first (`start`) or last
 * (`end`) millisecond. A calendar day that does not exist (`2026-02-30`) is
 * refused, never rolled over.
 */
export function isoTime(date: string, edge: "start" | "end"): number {
  const day = /^(\d{4})-(\d{2})-(\d{2})(T.*)?$/u.exec(date);
  const real = day !== null && new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]))).toISOString().startsWith(date.slice(0, 10));
  const time = !real ? Number.NaN : day[4] === undefined ? Date.parse(`${date}T00:00:00Z`) + (edge === "end" ? DAY_MS - 1 : 0) : Date.parse(date);
  if (Number.isNaN(time)) throw new InputError(`${JSON.stringify(date)} is not an ISO date or timestamp`, "roadmap_date_invalid");
  return time;
}

/** The ISO week (`YYYY-Www`, UTC) holding `date`: an ISO date (`YYYY-MM-DD`) or an ISO timestamp. */
export function isoWeek(date: string): string {
  const time = isoTime(date, "start");
  const midnight = Math.floor(time / DAY_MS) * DAY_MS;
  // The ISO year is the year of this week's Thursday.
  const thursday = midnight + (3 - ((new Date(midnight).getUTCDay() + 6) % 7)) * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const number = Math.floor((thursday - firstMonday(year)) / WEEK_MS) + 1;
  return `${String(year)}-W${String(number).padStart(2, "0")}`;
}

/** The ISO week `n` weeks after `week` (before it when `n` is negative). */
export function addIsoWeeks(week: string, n: number): string {
  if (!Number.isSafeInteger(n)) throw new InputError(`a week count must be an integer (was ${String(n)})`, "roadmap_week_count_invalid");
  return isoWeek(new Date(mondayOf(week) + n * WEEK_MS).toISOString());
}

/** How many weeks `to` lies after `from` (negative when before): `addIsoWeeks(from, isoWeeksBetween(from, to)) === to`. */
export function isoWeeksBetween(from: string, to: string): number {
  return Math.round((mondayOf(to) - mondayOf(from)) / WEEK_MS);
}

/** What a forecast is asked: the remaining scope, the recent weekly throughput and the guards that keep it honest. */
export type ForecastInput = Readonly<{
  /** Open items left in the scope. */
  remaining: number;
  /** Items closed as completed per week, oldest week first: the window the trials draw from. */
  weekly: readonly number[];
  /** How many weeks of parsable history exist up to `asOfWeek`. */
  weeksOfData: number;
  /** Seeds the draws: the same seed, the same forecast. */
  seed: string;
  /** The week the forecast is made in (`YYYY-Www`); the band's weeks are counted from it. */
  asOfWeek: string;
  minWeeks?: number;
  minClosed?: number;
  trials?: number;
  horizonWeeks?: number;
}>;

function count(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new InputError(`${name} must be an integer of at least ${String(minimum)} (was ${String(value)})`, "roadmap_forecast_input_invalid");
  return value;
}

/** The nearest-rank `percent`th percentile of ascending `sorted`. */
function nearestRank(sorted: readonly number[], percent: number): number {
  return sorted[Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1)]!;
}

/** A milestone's forecast from `input` (see the header): `complete`, a measured `band`, or an honest `unknown`. */
export function forecast(input: ForecastInput): Forecast {
  const remaining = count("remaining", input.remaining, 0);
  const weeksOfData = count("weeksOfData", input.weeksOfData, 0);
  const minWeeks = count("minWeeks", input.minWeeks ?? 4, 1);
  const minClosed = count("minClosed", input.minClosed ?? 3, 0);
  const trials = count("trials", input.trials ?? 2000, 1);
  const horizonWeeks = count("horizonWeeks", input.horizonWeeks ?? 520, 1);
  input.weekly.forEach((closed, index) => count(`weekly[${String(index)}]`, closed, 0));
  mondayOf(input.asOfWeek);
  if (remaining === 0) return deepFreeze({ kind: "complete" });
  const unknown = (reason: string): Forecast => deepFreeze({ kind: "unknown", remaining, reason, weeksOfData, method: METHOD });
  if (weeksOfData < minWeeks) {
    const missing = minWeeks - weeksOfData;
    return unknown(`needs ${String(missing)} more week${missing === 1 ? "" : "s"} of history (has ${String(weeksOfData)} of the ${String(minWeeks)} a forecast needs)`);
  }
  const closed = input.weekly.reduce((sum, value) => sum + value, 0);
  if (input.weekly.length === 0 || closed < minClosed) {
    return unknown(`only ${String(closed)} item${closed === 1 ? "" : "s"} closed in the last ${String(input.weekly.length)} weeks; a forecast needs at least ${String(minClosed)}`);
  }
  const outcomes: number[] = [];
  for (let trial = 0; trial < trials; trial += 1) {
    const next = seededRandom(Number.parseInt(sha256(`${input.seed}\0${String(trial)}`).slice(0, 8), 16) >>> 0);
    let done = 0;
    let weeks = 0;
    while (done < remaining && weeks < horizonWeeks) {
      done += input.weekly[Math.floor(next() * input.weekly.length)]!;
      weeks += 1;
    }
    outcomes.push(done >= remaining ? weeks : Number.POSITIVE_INFINITY);
  }
  outcomes.sort((left, right) => left - right);
  const p50Weeks = nearestRank(outcomes, 50);
  const p85Weeks = nearestRank(outcomes, 85);
  if (!Number.isFinite(p85Weeks)) {
    const finished = outcomes.filter(Number.isFinite).length;
    return unknown(`only ${String(finished)} of ${String(trials)} trials finish within ${String(horizonWeeks)} weeks at the recent pace; a forecast needs 85%`);
  }
  return deepFreeze({
    kind: "band", remaining, p50Weeks, p85Weeks,
    p50Week: addIsoWeeks(input.asOfWeek, p50Weeks), p85Week: addIsoWeeks(input.asOfWeek, p85Weeks),
    weeksOfData, method: METHOD,
  });
}
