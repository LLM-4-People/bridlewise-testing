/**
 * Hostile fixture: below-threshold duplicate (FN1 documented — neither
 * pass catches). Two identical functions with bodySize < 80 chars. The
 * detector skips them because they're below the minBodySize threshold (80).
 * This documents the recall limit: real duplicates below 80 chars are
 * NOT caught. The test asserts the detector returns zero findings for
 * this fixture, documenting FN1.
 */
export function tinyHelperA(x: number): number { return x + 1; }
export function tinyHelperB(x: number): number { return x + 1; }
