# Development Rules

`omp-reflect` is a standalone [oh-my-pi](https://github.com/can1357/oh-my-pi) extension. It is developed against the **published** `@oh-my-pi/*` packages pinned in `package.json` — never against a workspace catalog or `bun link`. A fresh clone must build with nothing but `bun install`.

## Commands

```bash
bun install --frozen-lockfile   # install (lockfile is committed)
bun run check                   # biome check . && tsgo --noEmit
bun test                        # full suite; must stay green
```

Never use `tsc`/`npx`; this is a Bun-only project (Bun APIs over `node:*` equivalents, `bun:sqlite`, `Bun.file`/`Bun.write`).

## Hard constraints

These are load-bearing invariants. Breaking any of them is a bug even if every test passes.

### Wire contract

- `src/wire.ts` is a **verbatim mirror** of the host's `packages/stats/src/reflection-wire.ts` (constants, literal types, payload shapes, `ACTIVITY_REFLECTION_SCHEMA_VERSION = 1`). Any change must land in the host first; `test/wire.test.ts` imports the host file by relative sibling path (`../../oh-my-pi/...`) and fails on drift.
- The sidecar filename is exactly `__omp-reflect.jsonl`, written beside the audited session's artifacts. One `start` entry per attempt before dispatch, exactly one `finish` after — statuses `success | invalid | provider_error | aborted` only.
- Persist reported provider usage on every finish that has it (failed responses are billed activity). Never persist raw task excerpts or raw provider error text.

### Host facade boundary

- The host's stats database is optional and is accessed **only** through a present `ctx.stats` five-method facade mirrored in `src/host-stats.ts`. No file in this repo may value-import `@oh-my-pi/omp-stats` aggregator, db, or gain modules — type-only imports from `@oh-my-pi/omp-stats/types` are the sole allowed dependency on that package.
- `requireHostStats()` must keep throwing the exact string `Activity Reflections requires an oh-my-pi build with ctx.stats.` for callers that explicitly require that facade. Reflection observability itself must instead prefer a valid host facade and otherwise use the injected standalone source.
- Host-only behavior matrices and Snapcompact gain are never inferred from transcript text. Standalone mode may provide only its own model/tool aggregates; its behavior and gain payload sections stay empty.

### Extension-owned activity analytics

- The only activity store is `${getAgentDir()}/omp-reflect-activity.sqlite`. Never open, attach, read, write, migrate, copy, or inspect the host `~/.omp/stats.db` (or any host `stats.db`) directly. The extension-owned database is intentionally independent even when `ctx.stats` exists.
- `ActivityDb` lease invariants are transactional: claim, renew, and release use `IMMEDIATE` transactions; every mutation that applies parsed facts or reconciles missing owners verifies the live owner lease before its first write; a stale owner throws before changing offsets or facts. Sync keeps the lease alive with its heartbeat and releases only its own lease.
- Port parser and aggregate behavior from oh-my-pi branch `feat/activity-insights`, not a new transcript interpretation. Preserve the post-review handling for custom-message skill prompts, rejected `?#` suffixes, monotonic read confirmation, image-only tasks, nested tool-result timestamps, reflection sidecars, and agent-kind path classification. Record any required published-16.3.15 API adaptation in the implementation report.
- The local `/activity` dashboard reads only `ActivityDb`; its server and tests use injected DB/runtime seams and never depend on a real agent directory.

### Payload bounds & sanitization

- Bounds are contractual: user prompt ≤ 2,000 chars, final assistant answer ≤ 3,000, complete payload including observability JSON ≤ 24,000; ≤ 6 task windows per attempt; observability matrices bounded to top-8/8/12/12 with one slot reserved for the active model.
- Reflection is an **ongoing, watermarked process**: BOTH manual and scheduled runs select only windows whose `sourceEntryIds` are not yet covered by a successful attempt in the session's sidecar — the sidecar IS the durable watermark, and six is the per-attempt batch bound, not the coverage horizon. A fully covered session is the caught-up steady state: notify, dispatch nothing, record no attempt (never burn the retry floor on it). `/reflect status` must keep reporting the watermark (`covered/total` + insights-through timestamp).
- Excluded from the payload, always: tool arguments/results, images, system prompts, hidden custom message bodies, subagent text.
- Every excerpt passes `createReflectionSanitizer()` (fresh secret reload per dispatch, control-delimiter neutralization, secret obfuscation) **before provider transmission and before persistence**. Reflection output is never deobfuscated.
- Prompts (`src/prompts/*.md`) must keep their guardrails: no psychological/causal claims about the user, rate comparisons only over nonzero denominators, model-category findings only when every compared model has ≥ 10 responding messages or requests, no correctness/test claims unproven by the supplied metrics.

### Model call

- Always the **active session model** via `ctx.modelRegistry.getApiKey` + resolver; a missing model/credential records a non-dispatched failure. Never fall back to another model.
- One forced structured `respond` tool, low reasoning when supported, 1,600 max output tokens, default (non-priority) tier, 90 s deadline, ≤ 3 accepted findings. Reject unknown source ids, empty fields, invalid shape.
- The extension exposes **no operational tools** to the reflection model.

### Scheduling & lifecycle

- Cadence state lives in `${getAgentDir()}/omp-reflect.sqlite` (single row). Semantics: 24 h success interval, 1 h scheduled-failure floor, 2 min cross-process lease renewed every 30 s, owner-guarded commit/release. Manual runs bypass cadence/backoff — but never an active foreign lease, and never the coverage watermark.
- Auto mode is **interactive-only** (`ctx.hasUI`), top-level main sessions only (≤ 2 path segments under the sessions root), and detaches from `agent_end`. `session_before_switch`/`session_shutdown` abort owned work, best-effort record `aborted`, and a completion under a lost lease must not commit.
- Sidecar owners are re-resolved by stable session id before every open/append; verify the owning main JSONL exists. Moved sessions write at the new path; dropped sessions discard late finishes.

### Non-goals

No memory/skill writes, no advice injection, no conversation interruption, no `agent.continue()`, no Snapcompact estimation, and no host stats-database access. The extension-owned activity database and loopback `/activity` dashboard are intentional scope, not host integration.

## Code conventions

- Strict TypeScript, `moduleResolution: Bundler`, `.ts` import extensions allowed. No `any`; no `ReturnType<>` for public contracts; top-level `import type` (never inline `import("pkg").Type`).
- ES `#private` fields; no `private`/`protected`/`public` keywords except constructor parameter properties.
- `Promise.withResolvers()` over hand-rolled promise executors; promise-tail queues for serialized writers (see `ReflectRecorder`).
- Prompts live in `src/prompts/*.md`, imported with `with { type: "text" }` (`src/md.d.ts` provides ambient types). Never build prompts from string concatenation in code.
- Logging via `logger` from `@oh-my-pi/pi-utils`; never `console.log` (this runs inside a TUI host).

## Testing rules

- Every test defends one externally observable contract (wire equality, guard acceptance/rejection with the exact error string, sanitizer leak-prevention, lease races, bound enforcement, no-fallback dispatch). No tautologies, no "code ran" assertions, no source-grep tests.
- Never `mock.module()`. Inject seams instead — most modules take explicit deps (`dbPath` on `openReflectSchedule`, `agentDir` on the sanitizer, structural `ctx` fixtures, `buildObservabilitySnapshotFromAggregates`).
- Tests must be full-suite safe: temp dirs per test, no writes outside them, no reliance on `~/.omp`, deterministic timing (short injected TTLs, no wall-clock sleeps beyond what a lease case requires).
- `test/wire.test.ts` and `test/host-stats.test.ts` intentionally type-check against external sources (sibling repo file, published package types). Keep them compiling — they are the drift alarms.

## Releasing / versioning

The package is `private: true` and not published. Bumping the pinned `@oh-my-pi/*` versions is a deliberate compatibility decision: re-run the full suite and re-verify `test/host-stats.test.ts` still models the delta between published types and the running host correctly.
