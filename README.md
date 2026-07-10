# omp-reflect

**Activity Reflections** — an [oh-my-pi](https://github.com/can1357/oh-my-pi) extension that periodically audits your recent coding-agent sessions with your own active model and produces short, actionable findings about prompt and workflow efficiency: better prompting patterns, model choice, reasoning effort, skill usage, and tool habits.

Findings feed the **Activity** tab of the `omp stats` dashboard and are browsable in-session with `/reflect show`.

```
┌─────────────────┐   ctx.stats    ┌──────────────────────────┐
│ omp stats DB    │───────────────▶│ bounded observability     │
│ (host aggregates)│               │ snapshot (top-N matrices) │
└─────────────────┘                └────────────┬─────────────┘
┌─────────────────┐  session branch             │
│ recent completed│────────────────▶ sanitized, │ bounded payload
│ task windows    │                 ┌───────────▼─────────────┐
└─────────────────┘                 │ active model, structured │
                                    │ `respond` tool, ≤3       │
                                    │ findings                 │
                                    └───────────┬─────────────┘
                                    ┌───────────▼─────────────┐
                                    │ __omp-reflect.jsonl      │──▶ omp stats
                                    │ sidecar (wire v1)        │    Activity tab
                                    └──────────────────────────┘
```

## Requirements

- [Bun](https://bun.sh) ≥ 1.3
- An **oh-my-pi build that exposes `ctx.stats`** on the extension context (newer than the published 16.3.15). On an older host every audit fails fast with:
  `Activity Reflections requires an oh-my-pi build with ctx.stats.`
- One configured model credential — reflections always use your **active session model** and never fall back to another model.

## Install & load

```bash
git clone https://github.com/praneybehl/omp-reflect
cd omp-reflect && bun install
```

Load it into an interactive session:

```bash
omp --extension /path/to/omp-reflect
# or, from an oh-my-pi source checkout:
bun packages/coding-agent/src/cli.ts --extension ../omp-reflect
```

The package manifest (`"omp": { "extensions": ["./src/index.ts"] }`) makes the directory itself loadable.

## Commands

| Command | Effect |
|---|---|
| `/reflect run` | Wait for idle, audit up to **6** recent completed tasks, persist the attempt, notify accepted-finding count and the model used. Bypasses the 24 h cadence, but not another process's active lease. |
| `/reflect show` (or bare `/reflect`) | Browse the latest accepted findings — observation as the label, evidence/suggestion as the description. Esc closes. Empty state: `No reflections yet. Run /reflect run.` |
| `/reflect status` | Auto state, active model, last attempt/success, retry floor, lease holder. |
| `/reflect auto on\|off` | Persist automatic mode (see below). |
| `--reflect-daily` (CLI flag) | Enable auto mode for **this process only**, without rewriting the persisted switch. |

## Automatic mode

With auto enabled, a reflection is scheduled after `agent_end` on a **top-level interactive** session (print/RPC/ACP modes and nested subagents are skipped). Scheduling is conservative:

- at most one success per **24 hours**; failed scheduled attempts retry no sooner than **1 hour**;
- a cross-process **lease** (2 min TTL, 30 s heartbeat) in `~/.omp/agent/omp-reflect.sqlite` prevents two OMP processes from auditing concurrently — a crashed holder recovers after expiry;
- scheduled runs only audit task windows **not already covered** by a previous successful reflection of that session;
- switching or shutting down the session aborts an in-flight owned run and records it as `aborted`; a late completion can never commit under a lost lease.

## What the model sees (and what it never sees)

Each audit sends one bounded, sanitized payload:

- Up to 6 task windows: the user prompt (≤ 2,000 chars), the final assistant answer (≤ 3,000 chars), elapsed time, effective reasoning level, provider usage/cost, tool names/counts/error flags, and activated skills.
- Host observability aggregates fetched through `ctx.stats` after a fresh sync: 30-day and lifetime behavior-by-model matrices (top 8 each, one slot always reserved for the active model), all-time model aggregates (top 8), 30-day tool usage (top 12) and active-model tool breakdown (top 12), and the project's Snapcompact gain totals. The extension **never opens `stats.db` directly and never recomputes these signals** from transcript text.
- The complete payload — observability JSON included — is capped at **24,000 characters**.

Excluded always: tool arguments and results, images, system prompts, hidden custom message bodies, and subagent transcripts.

Before dispatch, project and global secret entries are reloaded and every excerpt passes a sanitizer that obfuscates secrets and neutralizes prompt-injection control delimiters (`<|system|>`, `[INST]`, ANSI/C0 sequences, …). The same obfuscation is applied to persisted model output; reflection output is never deobfuscated.

The prompts additionally forbid psychological or causal claims about the user, restrict model-comparison findings to models with ≥ 10 responding messages or requests, and prohibit correctness/test claims that the supplied metrics don't prove.

## The reflection call

- Model: the active session model, via the host's key resolution. Missing model or credential records a non-dispatched failure — no fallback.
- One forced structured `respond` tool; low reasoning effort when the model supports it; **1,600** max output tokens; default (non-priority) tier; **90 s** deadline.
- At most **3 findings** are accepted. Each must match the wire schema — category (`prompting | model | reasoning | skills | tools | workflow`), observation, evidence, suggestion, expected impact, confidence (`low | medium | high`), and known source entry ids. Unknown ids, empty fields, invalid shape, or a provider error/abort reject the attempt (`invalid` / `provider_error` / `aborted`).

## Persistence & the wire contract

Every dispatched attempt writes an append-only **sidecar** next to the audited session's artifacts:

```
~/.omp/agent/sessions/<project>/<session>/__omp-reflect.jsonl
```

One `omp.activity-reflection.start` entry before dispatch and exactly one `omp.activity-reflection.finish` entry (`success | invalid | provider_error | aborted`) after — including reported provider usage even for failed responses, since those are real billed requests. Raw excerpts and raw provider errors are never persisted.

`src/wire.ts` mirrors the host's `packages/stats/src/reflection-wire.ts` (schema version 1) so this package installs from published dependencies alone; `test/wire.test.ts` asserts exact constant equality against a sibling oh-my-pi checkout to catch drift. The host's stats parser folds sidecars into its database, where they appear in the Activity dashboard's reflection feed, lifetime token totals, model ranking, and the `reflection` agent-type share.

Sessions are resolved by **stable session id** before every sidecar write: moved sessions write at their new path; dropped sessions discard late finishes and never recreate old directories.

## Non-goals

Reflect never writes memories or managed skills, never injects advice into the conversation, never interrupts or continues the agent loop, and never estimates compaction savings. It observes, audits, and reports — nothing else.

## Development

```bash
bun install --frozen-lockfile
bun run check   # biome + tsgo --noEmit
bun test        # 28 tests across 6 files
```

| Path | Responsibility |
|---|---|
| `src/index.ts` | Extension factory: `/reflect` command, `--reflect-daily` flag, auto-mode lifecycle hooks |
| `src/wire.ts` | Mirrored sidecar wire contract (constants + payload types) |
| `src/host-stats.ts` | Structural `ctx.stats` guard against the published `ExtensionContext` |
| `src/observability.ts` | Fetches and bounds host aggregates (`behavior/models/tools/gain`) |
| `src/snapshot.ts` | Task-window extraction, selection, and payload bounding |
| `src/sanitizer.ts` | Secret obfuscation + control-delimiter neutralization |
| `src/runner.ts` | The model call: forced `respond` tool, validation, acceptance |
| `src/recorder.ts` | Serialized sidecar writer with owner re-resolution |
| `src/schedule.ts` | `bun:sqlite` cadence state + cross-process lease |
| `src/ui/findings.ts` | `/reflect show` presentation |
| `src/prompts/*.md` | System/user prompt templates |

See [AGENTS.md](./AGENTS.md) for the rules that keep this extension safe to modify.
