/**
 * The live repository's architecture baseline runs in the routine guard set.
 *
 * The s1 scenario battery owns the deep verification of the architecture
 * machinery — planted defects on temporary candidate roots, hostile
 * fixtures, boundary escapes — and its control arm is the one part that
 * judges THIS tree: the real repository must report zero architecture- and
 * audit-matrix violations beyond the registered diagnostic classes. That
 * arm lived only inside the scenario battery, which no routine gate runs —
 * a round that lands a manifest defect is caught by nothing it runs, which
 * is how a duplicate architecture-manifest path survived a full round's
 * gates: the guard existed, but only a suite nobody invokes would have
 * redded on it.
 *
 * The control assertion is owned by the scenario support module and
 * registered twice on purpose — once by the scenario battery (the deep S1
 * admission slice) and once here (the routine tier) — so both tiers run the
 * SAME assertion from ONE owner rather than a copy that can drift. The
 * battery is unchanged; this file adds the routine registration only.
 */

import test from "node:test";

import { assertArchitectureBaselineClean } from "../support/s1-scenario-shared.ts";

test("the live repository's architecture verification reports zero unclassified architecture or audit-matrix violations", assertArchitectureBaselineClean);
