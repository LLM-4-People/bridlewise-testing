# OpenCode evidence study analysis framework

This directory contains the analysis framework for the OpenCode evidence study
(delivery map item 14). It is research/verification code in the verification
realm. No product runtime module may import it. The harness must NOT depend on
OpenCode at runtime (USR-032, REQ-032, DER-021, DER-022).

## Status

- SEC-001: `open-blocking`. Real OpenCode data access is blocked.
- This framework is qualified on synthetic fixtures only (200 tests, 3 runs).
- It will work on real sanitized data when SEC-001 closes and the production
  methodology v4.11.0 is admitted.
- No real OpenCode data has been accessed, read, hashed, copied, or analyzed.

## Modules

### `source-record-contract.ts`

The sanitized SourceRecord contract (v4.6.1). A generic exchange format that
mirrors the Python read-only adapter's output. Contains NO OpenCode-specific
schema, table names, or identifiers. Validates corpora with fail-closed typed
errors.

### `study-metrics.ts`

The study metrics engine. Computes coverage denominators, steering dynamics,
friction patterns, code quality indicators, alignment trajectory, and
interaction patterns from a validated corpus. All metrics are deterministic and
hashable.

### `findings-report.ts`

The findings report generator. Produces a versioned, hashable report with
findings (categorized and severity-rated) and limitations. Enforces
`sec001Open: true`, `realHistoryReady: false`, `syntheticOnly: true` for
synthetic reports.

### `synthetic-fixtures.ts`

Deterministic synthetic corpus generators with controlled structure for
analysis qualification. All content is synthetic; marker
`generated-synthetic-only/v1`.

## Tests

`test/research/opencode-history-analysis.test.ts` — 200 tests covering
contract validation, metric computation, findings generation, fixture
generation, and cross-module integration. Three complete runs pass 200/200
each.

## Usage

```typescript
import { generateSyntheticCorpus } from "../../verification/benchmarks/opencode-history/analysis/synthetic-fixtures.ts";
import { computeStudyMetrics } from "../../verification/benchmarks/opencode-history/analysis/study-metrics.ts";
import { produceFindingsReport } from "../../verification/benchmarks/opencode-history/analysis/findings-report.ts";

const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 4 });
const report = produceFindingsReport(corpus, {
  generatedAt: new Date().toISOString(),
  sec001Open: true,
  realHistoryReady: false,
  syntheticOnly: true,
});
console.log(report.metrics.coverage);
console.log(report.findings);
```

## Privacy and standalone boundary

- This framework consumes only sanitized SourceRecords — no raw OpenCode data.
- It contains NO OpenCode-specific schema, table names, or identifiers.
- It is in the verification realm, not product source.
- It imports only shared utilities (`src/integrity.ts`, `src/json-integrity.ts`)
  — no product runtime module imports it.
- The standalone boundary verifier (DER-021/DER-022) should allow this path as
  research/verification evidence.

## SEC-001 closure path

See `docs/research/opencode-history/reports/sec-001-closure-path.md` for the
exact qualified path to close SEC-001 and enable real-data analysis.

## Findings so far

See `docs/research/opencode-history/reports/synthetic-qualification-findings.md`
for findings from the synthetic qualification.
