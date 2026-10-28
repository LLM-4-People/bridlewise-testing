# Performance

The performance domain: the metrics collectors, budgets, and the profiling that keeps the harness inside its runtime budget.

## What each file does

- `benchmark-cli.ts` — the benchmark-cli module.
- `benchmark-runner.ts` — the benchmark-runner module.
- `diagnostic-cli.ts` — the diagnostic-cli module.
- `diagnostic-modes.ts` — the diagnostic-modes module.
- `engine-instrumentation.ts` — the engine auto-instrumentation decoration owner: `engineSpans` wraps every function-valued re-export of the canonical hub with an "engine" effect span (recorded only inside request contexts, argument shapes only — never values), `withoutEngineSpans` is the sink's re-entrancy guard, and `ENGINE_SPAN_EXCLUSIONS` is the reviewed hot-path/machinery exclusion table the function manifest's own validator gates.
- `function-manifest.ts` — the function manifest: the generated inventory of every in-scope exported engine function, and — since the auto-instrumentation round — the coverage GATE for the decoration's exclusions (every exclusion must name a real inventoried function with rationale, owner, evidence and scope; a stale or evidence-free exclusion reds in `engine/test/performance/function-manifest.test.ts`). Adding a function to the exclusion table is a REVIEWED act: fill all four fields, and cite the call-rate measurement or machinery reasoning in the rationale.
- `index.ts` — the index module.
- `metrics-collector.ts` — the low-overhead metrics collector: per-scope call/error/cancellation counts and duration histograms, plus the resource aggregates (`totalCpuMs`, `totalHeapDeltaBytes`) fed by `recordCall`'s optional delta, and `startResourceDeltaProbe` — the one owner of the "what did this window cost" measurement (CPU time + heap growth) that the effect wrapper and the metrics call sites both use.
- `performance-config.ts` — the central performance configuration schema: scope, sampling, histograms, budgets, retention, exporters, label schema, cardinality, privacy, backpressure, failure behavior, diagnostic modes, and the resource knobs — `resourceDeltas.enabled` (the per-effect CPU/heap capture gate, default on) and `resourceSampler.enabled`/`intervalMs` (the process resource sampler, default on at 5000 ms).
- `configured-performance.ts` — `performanceConfigOf`: THE one resolution of a `performance` section (undeclared = the declared default), shared by the engine CLI and the web server's metrics collector (CFG-0 B4); `configuredPerformanceConfig`: the document's section through it, for every performance command; a refused document propagates.

## Where it lives

The folder lives at `engine/src/performance/`.
