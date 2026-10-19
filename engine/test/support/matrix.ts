import { createDevelopmentConfig, generateMatrix } from "../../src/evaluation/matrix-generator.ts";
import { SEED_SCENARIOS, SEED_PROJECTS } from "../../src/evaluation/scenarios.ts";
import type { MatrixDocument } from "../../src/evaluation/types.ts";

/**
 * Shared development-matrix factory. The single owner of the
 * `generateMatrix(createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS))`
 * call previously duplicated as `devMatrix` across the evaluation suite.
 */
export function devMatrix(): MatrixDocument {
  return generateMatrix(createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS));
}
