# The "10× Harder" Definition (EXP471, Fix 6)

**Binding directive:** "Increase test difficulty 10× when you get 100%. This is a RULE, not a one-off. If 100 turns pass, test 1000. If 1000 pass, test 10000."

**Problem (EXP468):** the "10×" directive was vague for non-D3 tasks — the test unit was undefined. An audit has no "turns." This file makes "10×" CONCRETE per test type so every agent applies the same scale.

## The base rule

`10×` means multiply the PRIMARY load axis by 10. If you pass at the new scale, multiply again. **Never stop at 100% — escalate until something breaks, then report the breaking point.** If a test is too hard, make it harder, not easier (weakening/faking is prohibited).

## Per-test-type definition

| Test type | Primary axis (×10) | Secondary axes (×10) | Concrete escalation |
|---|---|---|---|
| **Memory** | turns | facts stored, probes per turn | 100 turns / 100 facts → 1000/1000 → 10000/10000 → 100000/100000 |
| **Editor** | refactors in one task | call sites renamed, file size (lines) | 70 refactors / 50 call sites / 1k lines → 700/500/10k → 3000/3000/100k |
| **Search** | queries | functions indexed (codebase size) | 250 queries / 5k fns → 2500/50k → 25000/500k |
| **Quality** | codebases scanned | checks per codebase | 7 codebases / 25 checks → 70/250 → 700/2500 |
| **Safety** | traps (adversarial inputs) | rounds (repeated exposure) | 50 traps / 1 round → 500/10 → 5000/100 |
| **Learning** | generations (self-improve loop) | rules extracted | 15 gen / 5 rules → 150/50 → 1500/500 |
| **Tools/MCP** | concurrent calls | servers, dependency-chain depth | 5000 calls / 15 servers → 50000/150 → 500000/1500 |
| **E2e** | tasks (multi-step) | codebases exercised | 20 tasks / 4 codebases → 200/40 → 2000/400 |
| **Dedup/Compression** | entries deduplicated | input size (tokens) | 10k entries → 100k → 1M |
| **Context/Trim** | conversation turns | tokens retained | 1000 turns → 10000 → 100000 |
| **Audit (12-point)** | audit cells (layer×point) | repeat iterations | 1 layer / 12 points → 11 layers / 12 → repeat until all PASS |

## Non-D3 tasks (the gap EXP468 flagged)

For tasks that don't have a natural "turn" unit (audits, research, merges):
- **Audit**: 10× = audit ALL layers (11 × 12 = 132 cells) instead of one layer (12 cells), then REPEAT the audit until all PASS.
- **Merge/e2e**: 10× = 10× more experiments merged in one round, OR 10× larger integration tree, OR run the full suite (not smoke) 10 times back-to-back.
- **Research/benchmark**: 10× = 10× more candidate techniques benchmarked, OR 10× more real codebases, OR 10× more queries per technique.

## Improper-usage requirement (binding)

**ALSO** test 10× more IMPROPER/UNKNOWN/SHOULD-FAIL inputs. "Build tests with IMPROPER USAGE, UNKNOWN RESULTS, things that should NOT work." If 10 improper inputs pass, test 100. Cancellation, concurrency, partial effects, resource pressure, and failure paths must scale the same way.

## How to report

Always state: the previous scale (with pass rate), the new 10× scale (with pass rate), and the breaking point (where it stops being 100%). Example: "Memory 100/100 at 10000 turns → 100000 turns 70/70 (10× harder, still passing). Breaking point: not found at 100k." If you hit a breaking point, report it honestly — do NOT weaken the test to restore 100%.
