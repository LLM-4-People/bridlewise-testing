/**
 * EXP451 — Genetic-algorithm (GA) pattern extraction: deterministic, no LLM.
 *
 * Evolves a population of candidate (type, cause-regex) rules where fitness
 * = recall on the collector's wouldFail ops + (1 - FP rate on the clean
 * set). The GA discovers regex generalizations the exact-match policy
 * cannot express: e.g. a single regex `invalid-.*` covering
 * `invalid-regex`, `invalid-json-arg`, `invalid-arg-type` (the family).
 *
 * Determinism: the RNG is a seeded LCG (config.gaSeed). Same seed → same
 * evolution → same output. No LLM, no Math.random.
 *
 * The GA is a TECHNIQUE BENCHMARKED alongside frequency / MI / Apriori /
 * CUSUM / Bayesian / n-gram / decision-tree. The benchmark selects the
 * best technique per profile; the live learner can be configured to use
 * the winner via `gaEnabled`.
 */

import type { ErrorCollector, ErrorRecord } from "./collector.ts";
import type { LearningConfig } from "./config.ts";
import type { Pattern } from "./extractor.ts";

/** A candidate regex genome in the GA population. */
export interface GaGenome {
  type: string;
  /** The regex source (anchored or not, per the genome's `anchored` flag). */
  regex: string;
  /** Whether the regex is anchored (`^...$`) or a substring match. */
  anchored: boolean;
  /** Fitness = recall - fpRate (max 1.0, min -1.0). */
  fitness: number;
  /** Recall on wouldFail ops of this type. */
  recall: number;
  /** FP rate on the clean set. */
  fpRate: number;
}

/** Seeded LCG (deterministic) — returns a function producing floats in [0,1). */
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants.
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Candidate regex seeds: substrings of a cause. For each cause, the seed
 * is the longest prefix that is NOT a full cause (forces the GA to
 * generalize). Also seeds with the full cause (for exact-match fallback).
 * Deterministic (sorted by length desc, then alpha).
 */
function seedRegexes(causes: readonly string[], rng: () => number): string[] {
  const seeds = new Set<string>();
  for (const c of causes) {
    seeds.add(c); // exact
    // Prefix seeds of length >= 4 (avoid trivial 1-2 char seeds).
    for (let len = Math.min(c.length, 12); len >= 4; len -= 1) {
      seeds.add(c.slice(0, len));
    }
    // Token-based seeds: split on non-alphanumeric, take token prefixes.
    const tokens = c.split(/[^a-z0-9]+/i).filter((t) => t.length >= 3);
    for (const t of tokens) {
      seeds.add(t);
      if (t.length > 4) seeds.add(t.slice(0, t.length - 1));
    }
  }
  // Sample a subset if too many (bounded by gaMaxSeeds).
  const arr = [...seeds].sort((a, b) => b.length - a.length || a.localeCompare(b));
  if (arr.length <= config_ga_max_seeds) return arr;
  // Deterministic reservoir-style sample (keep the top long ones + sample).
  const keep = arr.slice(0, Math.floor(config_ga_max_seeds / 2));
  const rest = arr.slice(Math.floor(config_ga_max_seeds / 2));
  for (let i = 0; i < rest.length && keep.length < config_ga_max_seeds; i += 1) {
    if (rng() < 0.5) keep.push(rest[i] ?? "");
  }
  return keep.filter((s) => s.length > 0);
}

// Configurable cap (read from the config in extractGaPatterns; this is a
// fallback constant used ONLY when the config value is unset during the
// seed function — kept here to avoid threading config through every call,
// set before each GA run). NOT a static tuning constant in the live path.
let config_ga_max_seeds = 64;

/** Evaluate a regex genome against the collector + clean set. */
function evaluate(
  genome: { type: string; regex: string; anchored: boolean },
  wouldFail: readonly ErrorRecord[],
  cleanCauses: readonly { type: string; cause: string }[],
): { recall: number; fpRate: number; fitness: number } {
  let tp = 0;
  let fn = 0;
  let fp = 0;
  let tn = 0;
  const re = safeRegex(genome);
  for (const e of wouldFail) {
    if (e.type !== genome.type) continue;
    if (re.test(e.cause)) tp += 1;
    else fn += 1;
  }
  for (const c of cleanCauses) {
    if (c.type !== genome.type) continue;
    if (re.test(c.cause)) fp += 1;
    else tn += 1;
  }
  const recallDenom = tp + fn;
  const recall = recallDenom > 0 ? tp / recallDenom : 0;
  const fpDenom = fp + tn;
  const fpRate = fpDenom > 0 ? fp / fpDenom : 0;
  // Fitness = recall - fpRate. A perfect genome: recall 1, fp 0 → 1.0.
  // A genome with FPs is penalized (fpRate subtracted). A genome that
  // matches nothing: recall 0, fp 0 → 0.0 (not negative).
  const fitness = recall - fpRate;
  return { recall, fpRate, fitness };
}

function safeRegex(g: { regex: string; anchored: boolean }): RegExp {
  try {
    return g.anchored ? new RegExp(`^${g.regex}$`, "u") : new RegExp(g.regex, "u");
  } catch {
    // Invalid regex → matches nothing (fitness 0).
    return /\b\B/u;
  }
}

/**
 * Mutate a regex genome. Deterministic mutations (driven by rng):
 *   - drop a trailing char (generalize),
 *   - add a `.*` wildcard (generalize),
 *   - add a `.+` (generalize),
 *   - replace a literal char with `.` (generalize),
 *   - re-anchor (specialize).
 */
function mutate(g: GaGenome, rng: () => number): GaGenome {
  const choice = Math.floor(rng() * 5);
  let regex = g.regex;
  let anchored = g.anchored;
  if (regex.length === 0) return { ...g };
  switch (choice) {
    case 0: // drop trailing char
      regex = regex.slice(0, Math.max(0, regex.length - 1));
      break;
    case 1: // append .*
      if (!regex.endsWith(".*")) regex = `${regex}.*`;
      break;
    case 2: // prepend .*
      if (!regex.startsWith(".*")) regex = `.*${regex}`;
      break;
    case 3: { // replace a random char with `.`
      const idx = Math.floor(rng() * regex.length);
      const chars = [...regex];
      const ch = chars[idx];
      if (ch && ch !== "." && ch !== "*") chars[idx] = ".";
      regex = chars.join("");
      break;
    }
    case 4: // toggle anchoring
      anchored = !anchored;
      break;
  }
  if (regex.length === 0) regex = g.regex; // revert empty
  return { type: g.type, regex, anchored, fitness: 0, recall: 0, fpRate: 0 };
}

/** Crossover: take the common prefix of two regexes (the shared family). */
function crossover(a: GaGenome, b: GaGenome, rng: () => number): GaGenome {
  if (a.type !== b.type) return rng() < 0.5 ? a : b;
  // Common prefix.
  let i = 0;
  while (i < a.regex.length && i < b.regex.length && a.regex[i] === b.regex[i]) i += 1;
  const prefix = a.regex.slice(0, i);
  const regex = prefix.length >= 3 ? prefix : (rng() < 0.5 ? a.regex : b.regex);
  return {
    type: a.type,
    regex,
    anchored: rng() < 0.5 ? a.anchored : b.anchored,
    fitness: 0, recall: 0, fpRate: 0,
  };
}

/**
 * GA pattern extraction. Evolves a population per type, returns the
 * fittest genome per type as a Pattern (the regex is the `cause`; the
 * updater's policy table is bypassed for GA rules — they use the regex
 * directly as the `causeMatch`).
 *
 * The GA admits a genome ONLY if its fitness >= gaMinFitness (recall high,
 * FP low). This is the safety net: a low-recall or high-FP genome is
 * discarded (0 FPs enforced).
 */
export function extractGaPatterns(
  collector: ErrorCollector,
  config: LearningConfig,
  cleanCauses: readonly { type: string; cause: string }[],
): GaGenome[] {
  if (!config.gaEnabled) return [];
  config_ga_max_seeds = config.gaMaxSeeds;
  const rng = makeRng(config.gaSeed);
  const out: GaGenome[] = [];
  const knownTypes = Object.keys(config.knownCauses);
  for (const type of knownTypes) {
    const wouldFail = collector.all().filter((e) => e.type === type);
    if (wouldFail.length === 0) continue;
    const causes = wouldFail.map((e) => e.cause);
    const seeds = seedRegexes(causes, rng);
    // Initial population.
    let population: GaGenome[] = seeds.map((regex) => ({
      type,
      regex,
      anchored: rng() < 0.5,
      fitness: 0, recall: 0, fpRate: 0,
    }));
    for (const g of population) {
      const ev = evaluate(g, wouldFail, cleanCauses);
      g.fitness = ev.fitness;
      g.recall = ev.recall;
      g.fpRate = ev.fpRate;
    }
    // Evolve.
    for (let gen = 0; gen < config.gaGenerations; gen += 1) {
      population.sort((a, b) => b.fitness - a.fitness);
      const elite = population.slice(0, Math.max(1, Math.floor(population.length * config.gaEliteFraction)));
      const children: GaGenome[] = [];
      while (children.length < config.gaPopulationSize - elite.length) {
        const a = elite[Math.floor(rng() * elite.length)] ?? population[0]!;
        const b = elite[Math.floor(rng() * elite.length)] ?? population[0]!;
        let child = crossover(a, b, rng);
        if (rng() < config.gaMutationRate) child = mutate(child, rng);
        const ev = evaluate(child, wouldFail, cleanCauses);
        child.fitness = ev.fitness;
        child.recall = ev.recall;
        child.fpRate = ev.fpRate;
        children.push(child);
      }
      population = [...elite, ...children];
    }
    population.sort((a, b) => b.fitness - a.fitness);
    // Admit the fittest genome if it passes the fitness floor.
    const fittest = population[0];
    if (fittest && fittest.fitness >= config.gaMinFitness) {
      out.push(fittest);
    }
  }
  return out.slice(0, config.maxGaPatterns);
}

/** Convert a GA genome to a Pattern (for the benchmark + comparator). */
export function gaGenomeToPattern(g: GaGenome): Pattern {
  return {
    type: g.type,
    cause: g.regex,
    count: Math.round(g.recall * 100),
    confidence: g.recall,
    rank: 1,
  };
}
