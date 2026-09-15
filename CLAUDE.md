# CLAUDE.md

Guidance for agents working in this repository.

## What gudmo is

`gudmo` is a manual macOS CLI that ensures the **five-hour usage-window timer** is active
for every locally discovered account, across two providers: **Codex CLI** and **Claude
Code**. It renews only accounts whose window has not started yet.

It is **not** a quota-increase tool. Every renewal prompt consumes real usage. Reset
metadata comes from an experimental Codex app-server method and may change upstream.

Scope discipline matters here: automatic scheduling, launchd installation, seven-day
windows, `status`/`logs` commands, and rolling request ceilings were **deliberately
removed** in 0.5.0. Do not reintroduce them.

## Stack and constraints

- macOS, Node.js >= 20, ECMAScript modules.
- **No runtime dependencies.** Tests use the built-in `node:test` runner only.
- External interfaces:
  - Codex: `codex exec --json` events, and app-server JSON-RPC over `stdio://` for
    rate-limit metadata.
  - Claude Code: `claude --print --output-format json` for renewal, and the same command
    with `/usage` for rate-limit metadata (a local command that makes no model call).
- Only the **300-minute** Codex window is targeted, verified, or reported.
- Never report missing or malformed server metadata as success.
- At most one prompt attempt per tier per account, escalating only after failed
  verification. Codex has two tiers; Claude has one.
- Preserve isolated `codex-auth` credentials and per-account concurrency locks.

## Commands

```text
gudmo run [--provider codex|claude|all]
                                  Check every account; renew inactive 5h timers
gudmo eval [--runs N] [--tier 1..N|all] [--provider codex|claude] [--json]
                                  Measure production prompt tiers (live, consumes usage)
gudmo doctor [--provider codex|claude|all]
                                  Check platform, provider CLIs, and login
gudmo help                        Show help
gudmo version                     Show the installed version
```

`--provider` defaults to `all` for `run` and `doctor`, and to `codex` for `eval`.

Any other command must fail with an unknown-command error.

## Source layout

| File | Responsibility |
| --- | --- |
| `bin/gudmo.js` | Entry point; delegates to `src/cli.js`. |
| `src/cli.js` | Argument parsing, command dispatch, provider selection, parallel per-account execution, progress and result formatting, aggregate exit code. |
| `src/providers.js` | Provider registry: runner, verifier, tiers, prompt builder, and verification strategy per provider. The only place a provider is assembled. |
| `src/scheduler.js` | Renewal pipeline: `renewFiveHourWindow`, `buildFiveHourVerification`, `hasActiveFiveHourWindow`, state load/persist. Despite the name it schedules nothing. |
| `src/prompt.js` | Pure prompt builders `buildRenewalPrompt` / `buildClaudeRenewalPrompt` and their tier tables. |
| `src/accounts.js` | Per-provider account discovery (`codex-auth` registry, Claude's signed-in account), isolated `CODEX_HOME` preparation, per-account paths. |
| `src/codex.js` | `buildCodexArgs` / `runCodex`; spawns the Codex CLI and parses JSON telemetry. |
| `src/rate-limits.js` | `readAccountRateLimits`; app-server JSON-RPC client returning normalized windows. |
| `src/claude.js` | `buildClaudeArgs` / `runClaude`; spawns Claude Code headless and parses its JSON result. |
| `src/claude-usage.js` | `readClaudeRateLimits` plus the pure `/usage` text parser, returning the same normalized window shape as `rate-limits.js`. |
| `src/config.js` | Config load/validate/normalize; drops unsupported legacy keys. |
| `src/storage.js` | Atomic JSON/text writes and the directory-based lock with dead-process reclaim. |
| `src/doctor.js` | Platform, Codex CLI, and credential checks. |
| `src/eval.js` | Live token measurement over the production prompt builder. |
| `src/paths.js` | Config/state/lock/eval-report path resolution, `GUDMO_HOME` override. |
| `src/constants.js` | `VERSION`, `STATE_VERSION`, `DEFAULT_CONFIG`. |

Every `src/*.js` file has a matching `test/*.test.js`. New modules must be added to the
`check` script in `package.json`.

Both providers share one renewal pipeline. `renewFiveHourWindow` takes `runner`,
`verifier`, `tiers`, `buildPrompt`, and `verify` as injectables; a provider is just a
descriptor supplying those five. Add a provider in `src/providers.js` — never by branching
on provider id inside the scheduler.

## Run behavior

Each `gudmo run` reads fresh metadata for every discovered account of every selected
provider. Providers hold separate locks and state directories and are renewed
independently. Per account:

1. Prepare the isolated `CODEX_HOME` when the account came from `codex-auth`.
2. Read the current 300-minute window.
3. Return `active` with **no model call** if the reset is less than five hours away.
   A five-second precision allowance (`RESET_PRECISION_TOLERANCE_MS`) prevents a floating
   `now + 5h` reset from being mistaken for an active window.
4. Otherwise send tier 1 with a fresh nonce.
5. Wait 60s, then read the window again.
6. If still floating, poll metadata for up to two more minutes (30s interval) **without
   sending another prompt**.
7. On continued float, retry once with tier 2.
8. Missing metadata continues into renewal rather than skipping the account.

Steps 5 through 7 are the Codex float-detection path. Claude reports a five-hour window
only while one is running, and its reset is anchored to the window start, so its
verification is presence-based: after the prompt, a five-hour window whose reset is still
ahead is the renewal evidence. Nothing about Claude ever classifies as `still-floating`.

Accounts run concurrently; output stays ordered by discovery. Exit code is 0 only when
every account is `active` or verified `renewed`.

## Prompt tiers

Defined in `src/prompt.js`. Codex:

| Tier | Target output | Reasoning |
| --- | --- | --- |
| 1 | 256 words | high |
| 2 | 512 words | high |

Claude Code needs exactly one minimal tier (1 output word, no reasoning control): the
window anchors on the first request of the window regardless of workload, so there is no
floating reset to out-work. A measured live renewal costs 7 billed tokens.

Every prompt carries a fresh nonce so the request cannot be served fully from cache, and
states a bounded task with an explicit response contract (final word `DONE`).

These values come from live calibration, not theory: exact `OK`/low, 64 words/medium, and
128 words/medium all left the problematic account floating (the 128-word attempt burned
14,942 tokens); 256 words/high renewed it with 2,146 output tokens. Delayed propagation
was also real — one account became active only after gudmo had already declared failure,
which is why propagation polling precedes the single fallback tier.

Tier sizes and the escalation curve are implementation constants, **not user
configuration**. Any change must be reflected in `test/prompt.test.js`,
`test/scheduler.test.js`, the README, and the design spec.

## Verification semantics

### Codex

Compare the 300-minute reset before and after a real prompt:

- `renewed` — the reset is anchored, usage increased, or reset movement differs from
  wall-clock drift.
- `still-floating` — the reset advanced by roughly the observation interval; poll, then
  escalate.
- `unavailable` — comparable 300-minute metadata is missing; one metadata-only retry,
  then fail **without claiming success**.
- `failed` — the Codex call failed, or both tiers left the timer floating after
  propagation polling.

### Claude Code

- `renewed` — `/usage` reports a five-hour window whose reset is still in the future.
- `unavailable` — no five-hour window, or its reset phrase does not parse; one retry, then
  fail without claiming success.
- `failed` — the `claude` call failed or returned no measurable token usage.

`/usage` returns human-formatted text, not structured data: `Current session: 12% used ·
resets Sep 15 at 10pm (Europe/Kiev)`. `src/claude-usage.js` parses it against the timezone
the line names, infers the omitted year as the nearest candidate, and returns `null`
rather than a guess when the phrase does not match. Treat that parser as the fragile
surface: if Claude Code changes the wording, this is what breaks, and it must keep failing
closed rather than inventing a timestamp.

This is observable evidence from experimental metadata, not a service-level guarantee.

## Accounts, state, and concurrency

Claude Code exposes one signed-in account. Gudmo reads `~/.claude.json` (or
`$CLAUDE_CONFIG_DIR/.claude.json`) solely for the account label and otherwise drives the
installed `claude` binary. It never writes Claude credentials and never switches accounts.

Without `codex-auth`, gudmo uses the active Codex account. With a compatible registry
(`$CODEX_HOME/accounts/registry.json`, schema 2-4, max 100 accounts, max 1 MiB) it
discovers every account and creates a private isolated `CODEX_HOME` per account under the
state directory, copying the credential snapshot with owner-only permissions
(`0700` dir, `0600` files). It never switches the user's active Codex account.

A per-account directory lock prevents duplicate simultaneous prompts. A second `gudmo run`
waits up to two minutes and reuses a verified result produced after it started. Locks held
by dead processes are reclaimed.

Paths:

```text
~/.config/gudmo/config.json        configuration
~/.local/state/gudmo/              state, per-account homes, eval-latest.json
```

`GUDMO_HOME` places config and state together in one directory (useful for isolated
testing). `XDG_CONFIG_HOME` / `XDG_STATE_HOME` are honored otherwise.

Supported config keys: `codexPath`, `claudePath`, `model` (Codex), `claudeModel` (Claude
Code), `reasoningEffort` (Codex), `timeoutSeconds`, `retrySeconds`. Keep the two providers'
model settings separate — a Codex model name is not a valid Claude model. Legacy scheduler, window, request-ceiling, and custom-message keys are
stripped on load. Prompt content is never user-configurable.

## Error handling

- Discovery or credential errors are attributed to the affected account.
- One account failure never cancels other running accounts.
- Malformed telemetry and unsupported app-server responses fail closed as unverified.
- Timeouts and child-process failures include bounded stderr, never credentials.
- Progress is printed for sends, observation waits, propagation polls, lock waits, and
  retries.

## Development workflow

Tests use fake Codex executables and never contact a model:

```sh
npm test
npm run check
node bin/gudmo.js help
```

Live verification intentionally consumes usage — only run it when asked:

```sh
node bin/gudmo.js eval --runs 3 --tier 1 --json
node bin/gudmo.js run
```

Write the failing test first, prove it fails, then implement. Unit tests must cover prompt
tiers and reply contracts, five-hour-only classification, retry escalation and the attempt
cap, skip-on-active behavior, concurrent execution with stable output order, nonzero
aggregate exit on any failure, lock waiting and stale-lock recovery, unavailable metadata,
malformed telemetry, credential isolation, `eval` using the production prompt builder,
provider selection and rejection, and the `/usage` parser's edge cases (missing session
line, missing reset, minutes, midnight/noon, year rollover, unparseable phrases).
Removed commands must keep returning unknown-command errors.

## Reference docs

- `docs/superpowers/specs/2026-08-27-five-hour-renewal-design.md` — authoritative design.
- `docs/superpowers/plans/2026-08-27-five-hour-renewal.md` — historical implementation
  plan. Its early task samples (five tiers, `64..1024` words, exact `OK`, cheap-first
  ladder) are **superseded** by the live-calibration amendment and by `src/prompt.js`.
- `README.md` — user-facing documentation; keep it in sync with behavior changes.
