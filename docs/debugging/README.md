# Debugging the harness with the ledger

The ledger (`.bridlewise/timeline.db`, opened by the server at
`HARNESS_WEB_TIMELINE_DB_PATH`, default `.bridlewise/timeline.db` relative to
the repository root) records everything the harness does: every run, turn,
message, tool call, provider call, file effect, database call, HTTP request
and engine function call, with per-effect duration, CPU time, heap delta,
redacted payloads and full causal correlation (trace/span/parent ids,
run/turn/message ids). This page is how you read it without writing a script
— and, since Round 12, how you read the harness's own ANATOMY: what is
running, what it does, what it consumes, what started it.

The **engine lane** answers "what did the request make the harness itself
do": every engine function the server calls through the canonical hub is
span-decorated automatically (`engine:<function>` events, e.g.
`engine:resolveMemoryConfig`), recorded only inside request contexts, with
argument SHAPES (type names, key names, counts, byte lengths — never values)
and the same timing/CPU/heap document every effect lane carries. A new hub
re-export is covered the day it lands; the only escape is a reviewed
exclusion in the decoration owner's table
(`engine/src/performance/engine-instrumentation.ts`). Filter a request's
engine work with `node scripts/trace.ts tail --event-type engine`, or read
one request's whole chain (its engine calls included) with
`node scripts/trace.ts trace <trace-id>`.

## The incident walk-through, first

The question that built these tools, in the shape it actually arrived: *a
model called `mcp:filesystem:write_file` six times in a row with empty
arguments, every call bounced off the argument gate, and nobody knew what
the model had actually been sent.* When you do not know what broke or where,
start with ONE command:

```
$ node scripts/trace.ts doctor
doctor — the newest run with failures
run run-0a6750ed-910a-45af-9b9a-4acdca690ddf
  events    75 · 19:20:49.668 → 19:22:57.898 (128.2s wall)
  trace     trace-bc8f24c7-53a4-430b-807c-a14c6a17ec39
  llm       2 calls · 28,134 in · 56 out
  tools     tool:create_artifact ×1 (failed 1)
  errors    1 with recorded error detail

failed events — 2
    207228  19:20:53.508  tool        failed     5ms · cpu 5ms · ram +207KiB tool:create_artifact  [error tool/tool_gate_schema_mismatch]
    207229  19:20:53.509  error       denied     —                        Tool 'create_artifact' arguments failed schema validation: …

gate blocks — 1
  seq 207228  create_artifact  schema_mismatch  failed fields: type

llm payloads — 2 event(s)
    207241  19:20:53.586  provider    succeeded  3.9s · cpu 178ms  llm:google/gemma-4-31b-it
       ┆ document llm-request
       ┆ [{"role":"system","content":"You are an AI coding assistant …
       ┆ document llm-response
       ┆ {"text":"","toolCalls":[…]}
```

`doctor` finds the newest run with a failed or denied event — or, when no
run has one, the newest run period — and collapses the whole diagnosis into
that one answer: the run's header summary, its failed events, its gate-block
documents (which fields failed, whether the harness escalated the refusal
loop), and the provider payloads the run recorded. When nothing qualifies
it says so honestly and still exits 0 — "nothing to diagnose" is an answer,
not an error.

To understand WHY those are the three questions worth asking — or to dig
anywhere doctor's chosen run is not the one you care about — the same
moves exist as separate commands, and they are the rest of this page.

**1. What just happened?** The tail shows the newest events across all runs,
newest first, with run and trace ids:

```
$ node scripts/trace.ts tail 6
tail of 6
  events    6 · 22:37:15.682 → 22:39:36.354 (140.7s wall)
  trace     tool:retrieve_tool_result:9 · tool:edit:15 · ...
  llm       0 calls
  tools     tool:mcp:filesystem:write_file ×3 (failed 3)
  errors    3 with recorded error detail

    357  22:39:36.354  provider    succeeded  88.7s                    llm:google/gemma-4-31b-it  · run-1d39fa59-… · …
    354  22:39:36.324  error       denied     —                        Tool 'mcp:filesystem:write_file' arguments failed schema …  · …
    353  22:39:36.216  tool        failed     0ms                      tool:mcp:filesystem:write_file  [error tool/tool_gate_schema_mismatch]
    350  22:38:07.610  provider    succeeded  51.9s                    llm:google/gemma-4-31b-it  · …
    347  22:38:07.567  error       denied     —                        Tool 'mcp:filesystem:write_file' arguments failed schema …  · …
    346  22:38:07.550  tool        failed     0ms                      tool:mcp:filesystem:write_file  [error tool/tool_gate_schema_mismatch]
```

The `tools` line already names the loop: `tool:mcp:filesystem:write_file ×6
(failed 6)`. Grab the run id from any line's tail — or skip the grabbing
entirely: `runs` lists every run with its outcome rollup, and `runs
--failed` narrows to the ones with something to diagnose.

**2. What did the run do, and where did it go wrong?** `run` replays the
whole run in causal order — turn-correlated rows grouped under their turn —
and `--failed` keeps only the refusals:

```
$ node scripts/trace.ts run run-1d39fa59-4bbb-4440-a01e-7ea90298e8b4 --failed
run run-1d39fa59-4bbb-4440-a01e-7ea90298e8b4
  events    22 · 22:33:58.274 → 22:44:27.645 (629.4s wall)
  llm       0 calls
  tools     tool:edit ×1 (failed 1) · tool:mcp:filesystem:write_file ×6 (failed 6) · tool:retrieve_tool_result ×2 (failed 2)
  errors    9 with recorded error detail

     339  22:37:15.682  tool        failed     2ms                      tool:mcp:filesystem:write_file  [error tool/tool_gate_schema_mismatch]
     340  22:37:15.699  error       denied     —                        Tool 'mcp:filesystem:write_file' arguments failed schema validation: missing required field 'path' (a string); missing required field 'content' (a string). …
     ...
```

Every attempt is the same gate block — the model kept re-sending the call
with the same missing fields, and the gate kept refusing it. Six provider
calls sit between the refusals; the question left is what the model was
actually sent and answered.

**3. What did the provider see?** `--llm` prints the stored provider payloads
and the redacted arguments, per event, exactly as recorded:

```
$ node scripts/trace.ts run <runId> --llm
...
   814  03:20:44.529  provider    succeeded  3.3s · cpu 958ms · ram −372KiB llm:google/gemma-4-31b-it
       ┆ document effect-args
       ┆ {"model":"google/gemma-4-31b-it","toolChoice":"auto","toolNames":["edit", …]}
       ┆ document llm-request
       ┆ [{"role":"system","content":"You are an AI coding assistant working in the project \"bridlewise-self\".…
       ┆ document llm-response
       ┆ {"text":"ok","toolCalls":[]}
```

The request document is the FINAL message list the provider received (already
redacted); the response document is the assembled answer (text + tool-call
name/argument pairs). Between the request, the response and the gate blocks,
"what did the model send and why did the gate refuse it" is answered from the
ledger alone. (This run predates payload capture, so its provider events
carry no `llm-request`/`llm-response` documents — runs recorded with
`timeline.captureProviderPayloads` on, the default, have them. The excerpt
above is from a run that does.)

The same three moves answer any incident: `tail` to find it, `run`/`trace` to
replay it, `--llm`/`--documents` to read what was actually sent — and
`doctor` runs all three for you when you do not yet know which run to ask
about.

## CLI reference — `scripts/trace.ts`

All commands read the ledger READ-ONLY (the tool opens its own `node:sqlite`
connection with `readOnly: true` and only SELECTs) and work from any cwd —
the ledger path comes from the server's config owner, anchored at the
repository root. The path override is the server's own:
`HARNESS_WEB_TIMELINE_DB_PATH`.

```
node scripts/trace.ts run <runId>      [flags]  every event of one run, causal order
node scripts/trace.ts trace <traceId>  [flags]  the same shape, scoped to one HTTP request
node scripts/trace.ts tail [N]         [flags]  newest N events across all runs (default 20)
node scripts/trace.ts runs             [flags]  one line per run: span, outcomes, failures, tokens
node scripts/trace.ts doctor           [flags]  the newest run with failures, collapsed to one answer
node scripts/trace.ts anatomy          [--json] the harness anatomy: process census + component registry
node scripts/trace.ts --schema                  the JSON contract of every command's --json output
```

| Flag | Meaning |
|---|---|
| `--event-type <t>` | only events of this recorded type (`tool`, `provider`, `db`, `network`, `engine`, `run`, `error`, …) — validated against the vocabulary, case-insensitive; an unknown value is refused with the whole recorded list — dig commands only |
| `--failed` | only events whose outcome is `failed` or `denied` — the verdict column, never error-field presence (see the consumer note below) — dig commands only; for `runs`, only runs containing one |
| `--llm` | print the stored `llm-request` / `llm-response` documents and the redacted `effect-args`, per event — dig commands only |
| `--documents` | print every stored document per event (adds `effect-timing`, `usage`, and any future document type) — dig commands only |
| `--since <when>` | only events at or after this wall time — an ISO-8601 timestamp (`2026-08-31T12:00:00Z`, `2026-08-31`) or a relative duration (`2h`, `30m`, `3d`, `1h30m`) — dig commands only, bounds inclusive |
| `--until <when>` | only events at or before this wall time (same grammar) — dig commands only |
| `--all-types` | `tail` only: include the sampler's `resource` events the default tail scan excludes (see the resource note below) |
| `--follow [ms]` | `tail` only: keep printing NEW events as the ledger grows, polling every ms (default 1000). Runs until interrupted — Ctrl-C exits cleanly with code 0. Bounded by design: each poll examines the newest 500 events, so on a ledger that grows faster than that between polls the stream can leave gaps — lower the interval on a hot ledger |
| `--last <N>` | `runs` only: the newest N runs |
| `--chat <id>` | `runs`/`doctor` only: runs of this chat — the ledger's session id, shown by the web UI's chat routes and echoed in `runs --json` as `chatId` |
| `--json` | machine-readable structured output instead of the text dump (all commands, including `anatomy` and `--schema`) |
| `--help` | the usage screen |

Examples:

```
node scripts/trace.ts run run-76b589e5-ea28-4b5f-acf4-f481096b212c
node scripts/trace.ts run run-76b589e5-… --failed
node scripts/trace.ts run run-76b589e5-… --llm --json
node scripts/trace.ts trace trace-3601f42b-e7b4-4beb-a477-1702266ddfae
node scripts/trace.ts tail 50 --event-type provider
node scripts/trace.ts runs --failed --last 5
node scripts/trace.ts doctor
node scripts/trace.ts doctor --chat 8380eb52-618a-4203-8b3d-031c1bf39af1 --json
node scripts/trace.ts tail 100 --since 2h
node scripts/trace.ts tail 20 --until 2026-08-31T12:00:00Z
node scripts/trace.ts tail 10 --follow 250
node scripts/trace.ts --schema | head -60
```

### Exit codes — the caller's first signal

| Code | Meaning |
|---|---|
| 0 | an answer was produced — including an honest EMPTY scope: filters that matched nothing inside an existing run/trace/chat, `doctor`'s "nothing to diagnose", a tail that found nothing |
| 1 | the scope itself is ABSENT — no run/trace/chat with that id in the ledger (a typo, not an empty result) — or the arguments are invalid (unknown flag, unknown event type, unparseable time bound) |

A typo'd run id says `no run with id <id> in the ledger` on stderr and
exits 1; the same run with `--failed` when nothing failed prints the honest
empty dump and exits 0. Scripts and agents should read the code before the
output: 0 means "believe the answer", 1 means "fix the question".

### The resource rows, and why the tail hides them by default

The resource sampler writes a `resource` event every few seconds (RSS,
heap, event-loop utilization, CPU deltas) — measured at roughly a third of
a live ledger's rows. They are the ledger's background hum, and in a tail
they bury the incident rows the command exists for, so the tail's default
scan excludes them. They still exist and are fully readable when you want
them: `tail --all-types` opts the default scan back in, and
`tail --event-type resource` asks for them by name (an explicit type is a
narrower request than the default scan, never a contradiction). The run and
trace replays are complete by design — they never exclude a row the run
recorded.

### `--json` and the schema

Every command's `--json` output is a stable contract, and the tool tells
you the contract itself: `--schema` prints the JSON shape of every
command's machine-readable output — field names, types, nullability, the
document vocabulary — derived from the reader's type shapes (the table
beside the types is its one documentation, and the owning suite walks
every command's real output against it, so it cannot drift silently).
One load-bearing detail for every consumer: a document's `contentJson` is
a STRING — the document body stored JSON-ENCODED. Parse the event with
`JSON.parse`, then parse the document's `contentJson` a second time for
the object (a double-parse). The text dump prints it verbatim either way.

The text dump's shape:

- a summary header — event count and wall span, the trace id(s), provider
  call count and token sums, tool groups with per-outcome tallies, and the
  count of events carrying recorded error detail;
- then one line per event: sequence, wall time, type, outcome, the measured
  cost (`duration`, plus `cpu`/`ram` when the resource-delta gate was on —
  `—` when the event carries no timing document, never an invented zero),
  the description, and `[error category/code]` when error detail is
  recorded;
- turn-correlated rows are grouped under a `turn <turnId>` header with a `│`
  gutter; run-level rows carry a plain pad. The tail view is flat and prints
  run/trace ids on every line (an event with none says `—`);
- documents print verbatim under their event. They were redacted before they
  were written; the tool does not re-redact and cannot unredact.

Where is the trace id to start from? Three places: the response header
`x-trace-id` on every API response; the run pane's `trace` row in the web UI
(copy button included); and the `trace` column of any `tail` line.

## The harness anatomy — `scripts/trace.ts anatomy` + the `observability.anatomy` block

The ledger dig answers "what did a run do". The anatomy answers the other
half of the debug directive — **what is the harness right now**: every
process that belongs to it, every live component inside the server process,
and the honest relation between them. Two owners, two doors:

- **The process census** (`server/observability/process-census.ts`) walks
  `/proc` live: every process whose cwd is this repository, plus the
  harness's known children even when their cwd differs (the npx-cached MCP
  servers). Per process: pid, ppid, the full **parent chain** walked to init
  (bounded), start time (boot-relative + wall), cwd, cmdline, sampled CPU
  (two `/proc` reads ~500ms apart → ms of CPU per second), RSS, a
  **classification** (what it does — `api server`, `vite`, `dev-all`,
  `mcp filesystem`, `mcp stdio fixture`, `intelligence farm child`,
  `trace CLI`, or `unrelated-bystander`) and a **provenance** (what
  started it / how it was classified).
- **The component registry** (`server/observability/component-registry.ts`)
  is the server process's own live component list. Every choke point that
  creates a component registers ON ITS OWN create/destroy path — the worker
  pool (every pooled worker thread), the DB thread backend (writer +
  readers), the intelligence folder watches, the resource sampler timer,
  the open run feeds, the stdio MCP children. A closed component leaves the
  registry; nothing is hand-listed.

**The one shape, both doors**: the CLI reads the census live and fetches the
registry through the `observability.anatomy` block read
(`GET /api/b/observability.anatomy`, gated like the metrics routes); the
block answers `{ data: { processes, components }, meta }` in the same shapes
the CLI prints. When the server is down the CLI still prints the census and
says plainly that the registry lives in the server process — never a
fabricated empty list.

```
$ node scripts/trace.ts anatomy
process census — 23 process(es), 9 in the server tree
  pid 2413407  ppid 2413398  api server                       pidfile-owned   cpu 1380.0ms/s  rss 2215.3MiB  up 55m ...
      chain MainThread(2413398) ← systemd(220)
      cmd node --experimental-strip-types server/index.ts
      why pidfile-owned: a live .dev pidfile names this pid
  ...
component registry — 5 live
  db-thread
    db reader  · role reader · threadId 12  since 13:00:36  (server/db/thread-backend.ts ThreadBackend.open)
    db writer  · role writer · threadId 11  ...
```

**Provenance semantics** (the "what started it" column):

| Kind | Meaning |
|---|---|
| `pidfile-owned` | a live `.dev/*.pid` pidfile names this pid (dev-all, api, web) |
| `descendant-of-server` | an ancestor in the chain is pidfile-owned (vite's wrappers, the MCP children, farm children) |
| `orphaned` | a server-tree argv shape with NO pidfile ancestor — the previous-tree leak class `sd.mjs` reconciles; run `node scripts/sd.mjs stop` to terminate |
| `outside-tree` | an operator tool (`trace CLI`) or a repo-cwd bystander (an editor's language server, another agent's MCP) — never signalled by the lifecycle |

**Component kinds**: `worker-thread` (pooled one-shot workers, with their
task label + thread id), `db-thread` (the SQLite writer + readers),
`folder-watch` (the recursive project watchers), `sampler-timer` (the
resource sampler's interval), `run-feed` (open run feeds / SSE replays),
`mcp-child` (stdio MCP server processes). Farm children are deliberately
NOT registry entries — they are forked from worker-thread isolates whose
module state the server's block read can never read; the census owns their
anatomy instead (they are real OS processes with chains, CPU and RSS).
A prevention guard (`tests/prevention/raw-handle-owner.test.ts`) reds on any
raw `fs.watch`/`setInterval`/`spawn`/`new Worker` site outside the
registry-registering owners — every standing handle must be a visible
component or an argued, documented exception.

## Querying the ledger over HTTP

The same ledger is queryable through the authenticated API:

- `POST /api/timeline/query` — a filtered, paginated event list. Filters
  include `chatId`/`projectId` (resolved to your runs), `runId`/`runIds`
  (kept only for runs you own), `turnId`, `agentId`, `taskId`, `eventType`,
  `effectId`, sequence/wall-time ranges, `limit`/`offset`/`cursor`, and —
  the causal scope — `traceId`: every event one HTTP request produced,
  across lanes (http, db, provider, run). A trace is ownership-gated like
  every client-supplied scope: the trace must carry an event whose run
  belongs to you, otherwise the trace is a hidden absence (404).
- `GET /api/timeline/events/:eventId` — one event's full record
  (documents, edges), ownership-gated the same way.

The SSE run stream carries the trace id out-of-band in its `metadata` frame,
and the web UI shows it in the run pane.

## Client telemetry — the browser's own lane

The browser is a harness component, and it reports about itself through one
door: the page captures its facts and POSTs them to the
`client.telemetry/ingest` block action, where the server redacts every
string through the single redaction owner, verifies every claimed
run/chat/trace id against the caller's own data (an unverified claim is
dropped, never attributed), and records them as two ledger event kinds:

- `client-error` — an UNCAUGHT page exception (`window.onerror`) or an
  unhandled promise rejection: message, source file name, line, column,
  first stack frame. Always buffered, never displaced.
- `client-metric` — a renderer measurement: `longTaskMs` + `longTaskCount`
  (main-thread blocks ≥ 50 ms, via the Long Tasks API), `ingestLagMs` +
  `ingestFrames` (dispatch-to-applied per SSE frame, aggregated per run and
  reported at run end), `bootMs` (the boot controller's own measured total),
  and `droppedClientEvents` (what the client could not send — the hole is
  recorded, never silent).

Query them like any lane:

```
$ node scripts/trace.ts run <runId> --event-type client-metric   # the run's ingest-lag report
$ node scripts/trace.ts trace <traceId> --event-type client-error # errors on one request's chain
```

`client-error` events carry `outcome: failed` and an error summary
(`client/client_error`), so they surface in `doctor` and every failure
filter; `client-metric` events are `succeeded` observations. The instruments
room's client-health signals (browser errors received, worst browser long
task) read the same ingestion door's counters the ledger rows came through.
The capture bounds — buffer cap, flush batch size, per-run metric cap, text
clamps — are named constants in `src/client-config.ts`; the flush policy
(beacon on visibility-hidden, broker POST while the page lives) is cited
against `research/client-telemetry/RESEARCH.md`.

## Config knobs

All three live in `engine/bridlewise.config.json` (the single source of
truth); the server reads them through its config owners at boot.

| Knob | Section | Default | What it gates |
|---|---|---|---|
| `captureProviderPayloads` | `timeline` | `true` | storing the redacted `llm-request`/`llm-response` documents on provider events |
| `resourceDeltas.enabled` | `performance` | `true` | the `cpuMs`/`heapDeltaBytes` fields in `effect-timing` documents |
| `resourceSampler.enabled` / `resourceSampler.intervalMs` | `performance` | `true` / `5000` | the periodic `resource` lane events (RSS, heap, event-loop utilization, CPU deltas) |

## The ledger's document vocabulary

Documents are attached to events, `name` → JSON, bounded by the timeline
limits (`timeline.maxDocumentBytes`, `maxDocuments`). The recurring names:

| Name | Who writes it | What is in it |
|---|---|---|
| `effect-timing` | the effect sink (`server/observability/timeline-bridge.ts`) | `{ durationMs, cpuMs?, heapDeltaBytes? }` — the effect's wall cost plus, when the resource-delta gate is on, the CPU time it consumed and the heap growth it caused |
| `effect-args` | the effect sink, from the choke points | the effect's REDACTED invocation arguments — tools carry the redacted args, the db lane carries argument SHAPES only (count + types + byte sizes, never values), the http lane carries method/path/redacted query, and the engine lane carries per-argument SHAPES (type names, object key names + counts, string byte lengths — never values) |
| `llm-request` | the LLM bridge's capture at the message-build choke point | the FINAL redacted message list sent to the provider |
| `llm-response` | the LLM bridge at stream settlement | the assembled response: accumulated text + tool-call name/argument pairs |
| `usage` | the run executor on the token event | `{ promptTokens, completionTokens, totalTokens }` |
| `metric` | the process resource sampler | the sampled RSS / heap / event-loop utilization / CPU deltas of the server process |
| `effect` | `recordFileEffect` | a file change's path, operation and pre/postimage digests |
| `check-status` | the auto-checks upsert | one check's name, previous and new status, its chat/project scope |
| `client-facts` | the client-telemetry ingestion route (`server/blocks/client-telemetry.ts`) | the REDACTED facts one browser reported: an uncaught error's message/source/line/column/first stack frame, or a renderer measurement — long-task ms + count, feed-ingest lag, boot total, dropped-event counts |
| `gate-block` | the tool executor when the safety gate blocked a call | the block kind and the argument fields that failed schema validation — the structured half of the refusal message, so "which fields failed" is answerable without parsing prose |

## Consumer note: read `outcome`, not error-field presence

An http effect for a thrown 4xx is classified by its mapped status, so its
`outcome` is `succeeded` WHILE its `error_category`/`error_code`/
`error_message` fields are populated — the refusal travelled as the event's
detail. A consumer that infers failure from "error fields present" will
disagree with the recorded outcome. The verdict is the `outcome` column;
`--failed` filters on it; the summary's error list shows error detail
whatever the outcome, so a thrown 4xx appears there with `succeeded` beside
it. Event types and the vocabulary live in
`engine/src/timeline/timeline-types.ts` (`TIMELINE_EVENT_TYPES`).

## Redaction guarantees

Every document is masked by the single redaction owner
(`server/llm/redaction.ts` over the engine's privacy module) BEFORE it is
written; the store keeps document content verbatim, so nothing redacted at
write time can be weakened or undone by a reader. The tool prints documents
as stored. The guarantee is canary-proven: the recording-fidelity suite
writes a credential through the real capture paths and asserts zero secret
bytes appear in any stored document.
