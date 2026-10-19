# CAP-001 — Ambient PATH was mistaken for runtime absence

Status: `open-blocking`

Owner: runtime capability qualification

## Incident and impact

On 2026-07-12, two delegated environment assessments reported that Node was
absent after checking only the inherited process `PATH`. In the same execution
environment, bounded inspection of the configured user runtime-manager root
found Node v24.16.0 and Node v24.18.0 under
`$HOME/.nvm/versions/node/`. Direct execution of the required candidate reported
Node `v24.18.0` and npm `11.16.0`. The package engine is
`>=24.18.0 <25.0.0`.

The reports were therefore false absence claims. The required runtime was
installed but not activated in the inherited `PATH`. No product readiness,
clean-machine, or general capability-detection claim may use those reports.

Affected surfaces: builder and runtime.

Blocked capabilities: authoritative runtime-absence reporting, clean-machine
runtime qualification, automatic installation guidance, external-process
qualification, and final candidate freeze.

## Root cause

The probe collapsed “not resolved from ambient `PATH`” into “not installed.” It
did not use a single typed capability-state vocabulary, consult a centrally
configured bounded runtime-manager/path candidate set, verify an explicit
activation, or compare the observed executable version with both root policy
and `package.json#engines`. The agent report was treated as a conclusion instead
of untrusted observed evidence.

## Current narrow prevention

The exact read-only Node Unicode and ICU metadata needed by repository-path
qualification is owned by `src/runtime-capabilities.ts`. Governed production
source analysis permits only direct, noncomputed reads in that module and
rejects the same members from other modules, aliases, `globalThis`, computed or
unknown members, other `process.versions` members, mutation, deletion and
callable use. The command-effect inventory also accepts an exact absolute Python
analyzer executable only as caller-supplied input and records dynamic or
unmodeled external-process behavior as blocked rather than guessing a runtime.

This is deliberately narrower than the required resolver. It neither discovers
nor activates a runtime, establishes absence, qualifies an external executable,
nor closes this finding.

## Required correction

The canonical capability resolver must produce exactly one of these states with
source-linked evidence:

- `absent`: no allowed executable exists after bounded exact discovery of every
  centrally configured manager/path candidate;
- `incompatible`: an executable exists and runs, but its observed version or
  identity fails the declared engine, policy, platform, or trust constraint;
- `installed-not-activated`: a permitted executable is discovered outside the
  effective command path, while the ambient invocation is missing or resolves
  to a different unqualified executable; and
- `qualified`: an explicitly activated exact executable runs, its identity and
  version satisfy root policy and the package engine, and all capability-specific
  qualification checks pass.

Discovery is bounded to exact, normalized candidates declared through the
central configuration/runtime-manager registry. It must not crawl the machine,
source arbitrary shell startup files, execute an untrusted manager hook, infer
installation from a directory name, or silently select another version. An
activation is scoped to the planned child process, logged with the executable
identity and effective path, and reverified before use. Missing, incompatible,
or installed-but-inactive states block the affected path with truthful recovery
instructions; none authorizes a fallback.

## Permanent regression

The deterministic regression is
`runtime-capability-state-and-bounded-activation-matrix-x3`. It must run at least
three materially distinct repetitions of each required case:

1. ambient `PATH` omits Node while a permitted NVM candidate contains the exact
   required version: result `installed-not-activated`, never `absent`;
2. explicit scoped activation selects v24.18.0 and engine comparison succeeds:
   result may become `qualified` only after every remaining check passes;
3. only v24.16.0 is discoverable against `>=24.18.0 <25.0.0`: result
   `incompatible`, with no silent upgrade, fallback, or latest-version guess;
4. all declared candidates and ambient resolution are absent: result `absent`;
5. symlink escape, duplicate executable identity, unconfigured manager root,
   manager-output injection, changed executable after plan, malformed version,
   or engine disagreement: fail closed and do not report `qualified`.
6. direct Unicode or ICU metadata read outside the central capability module,
   alias, computed property, other version member, assignment, update, delete,
   call, construction or tag use: fail closed before the value is consumed.

The oracle independently compares the selected executable/version to the root
Node-24 policy and package engine. It also asserts that an ambient-only probe
cannot emit `absent`, that discovery stayed inside its exact candidate set, and
that no alternate runtime executed.

## Evidence and lifecycle

- Governing requirement: `traceability/canonical/harness-requirements.md#DER-035`
- Architecture boundary:
  `docs/architecture/architecture-v1.md#runtime-language-and-independent-oracle-boundary`
- Root invariant: `src/root-policy.ts#runtimeLanguageArchitecture`
- Reproduction: empty `command -v node` and `command -v npm` results under the
  inherited environment, followed by exact bounded discovery and direct
  execution of `$HOME/.nvm/versions/node/v24.18.0/bin/node --version` and the
  corresponding npm executable.

Removal condition: implement the central typed resolver and scoped activation
boundary, pass the hostile matrix x3 on clean and manager-backed environments,
retain exact receipts, and obtain independent review. Merely adding the NVM
directory to this shell's `PATH`, hard-coding this workstation path, or changing
the wording of the probe does not remove the finding.

Removal verification: an independent reviewer reruns the frozen matrix, mutates
every classification and discovery boundary, verifies engine comparison and
time-of-check/time-of-use fencing, confirms no fallback execution, and then
records a separately governed closure or supersession event.
