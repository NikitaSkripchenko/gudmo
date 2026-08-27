# Gudmo Five-Hour Renewal Design

## Goal

`gudmo run` ensures the Codex five-hour usage-window timer is active for every discovered account. It skips model usage when the reset is already less than five hours away and otherwise renews the window. The command succeeds only when every account is already active or has verified renewal.

Gudmo cannot guarantee behavior that the upstream Codex service does not expose. Its guarantee is therefore operational: it reads every account, skips active windows, sends a real non-cacheable prompt when renewal is needed, verifies the reset metadata, and returns a nonzero exit code for any account it cannot classify or verify.

## Supported Product Surface

Keep these commands:

- `gudmo run`: renew and verify the five-hour window for all accounts.
- `gudmo eval`: measure the exact production prompt tiers for internal evaluation.
- `gudmo doctor`: validate the local platform, Codex CLI, and account credentials.
- `gudmo help` and `gudmo version`: basic CLI support.

Remove these commands and their implementation:

- `init`
- `tick`
- `daemon`
- `status`
- `logs`
- `install`
- `uninstall`

Also remove seven-day-window behavior, launchd integration, background scheduling, rolling daily request ceilings, and scheduling-only state.

## Run Behavior

Every explicit `gudmo run` invocation reads fresh server metadata for every account. A 300-minute reset arriving in less than five hours means the window is already active, so no prompt is sent. The comparison includes a five-second precision allowance because server resets have second precision while the client timestamp has milliseconds. Missing metadata continues into renewal rather than incorrectly skipping an account.

The flow for each account is:

1. Prepare its isolated `CODEX_HOME` when the account came from `codex-auth`.
2. Read the current five-hour rate-limit window.
3. Return `active` without a prompt when its reset is less than five hours away.
4. Otherwise send the first production prompt tier with a fresh nonce.
5. Wait for the observation interval.
6. Read the five-hour window again.
7. Succeed when the reset is fixed or changed in a way that demonstrates the timer was anchored.
8. If the reset continues sliding with wall-clock time, retry with the next workload tier.
9. Stop after three attempts and fail that account if renewal is still unverified.

Accounts run concurrently so one slow account does not serialize the full command. Results remain ordered according to account discovery. The overall command exits with code 0 only when every account succeeds.

## Prompt Strategy

The prompt must be small enough to minimize usage but substantial enough to trigger real model work. It must also avoid becoming a fully reusable cached request.

Every tier contains:

- A fresh random nonce.
- A bounded task with explicit output expectations.

The first tier uses the live-verified 128-word/medium-reasoning workload. If the first verification read still floats, Gudmo polls metadata for up to two additional minutes before allowing another model call. Retries remain bounded at 256 and 512 output words with high reasoning. Prompt construction is a pure function so nonce placement, workload, reasoning effort, and response contracts are unit-testable.

Live calibration established why both workload and propagation time matter. Exact `OK`/low and 64 words/medium were still floating at their first verification reads. One 64-word attempt became active later, proving the server can apply renewal after Gudmo has already declared failure. A 128-word/medium request renewed the remaining floating account with 1,110 output tokens; production starts with that observed working profile and polls delayed metadata before escalating.

The initial tier sizes and escalation curve are implementation constants, not user configuration. Live end-to-end results may justify tuning them before completion. The final values must be recorded in tests and the README.

## Verification Semantics

Only the five-hour server window, identified by a 300-minute duration, is relevant.

Verification outcomes:

- `renewed`: before and after metadata are comparable and show an anchored reset.
- `still-floating`: the reset moved by approximately the observation interval without increased usage evidence; retry with the next tier.
- `unavailable`: the five-hour window is absent or timestamps cannot be compared; retry the metadata read once, then fail as unverified without claiming success.
- `request-failed`: Codex did not complete successfully or did not return valid telemetry; retry using the normal bounded attempt sequence.

Gudmo never labels unavailable metadata as success. The final output includes the account label, attempts, elapsed time, prompt tier used, and verification result.

## State and Concurrency

Retain only state needed for safe manual execution and diagnosis:

- Per-account lock to prevent duplicate concurrent sends.
- Bounded request/verification history needed by the current invocation and useful failure output.
- Isolated credential homes for `codex-auth` accounts.

Remove next-wake calculations, window due dates, scheduler retry dates, launch-agent state, and rolling 24-hour request-limit state.

A manual run encountering an existing live lock waits for a bounded period and reuses a verified result produced after the current invocation began. Stale locks remain reclaimable.

## Eval Behavior

`gudmo eval` is retained as an internal live measurement command. It executes the same prompt-builder and Codex invocation used by `run`, across all configured tiers or a selected tier, and records:

- Gudmo and Codex versions.
- Prompt tier, target output, and reasoning effort.
- Per-run input, cached-input, output, and total tokens.
- Tier-specific response-contract compliance.
- Median and p95 token totals.

Eval calls consume real usage. They are not part of renewal success and do not substitute for the end-to-end `run` verification.

## Error Handling

- Account discovery or credential preparation errors are reported against the affected account when possible.
- One account failure does not cancel other accounts already running.
- Missing or malformed Codex telemetry is a failed attempt.
- Unsupported app-server responses fail closed as unverified.
- Process timeouts and child-process failures include bounded stderr details without exposing credentials.
- The command prints progress during sends, observation waits, lock waits, and retries.

## Testing

Unit tests cover:

- Prompt uniqueness, tier workloads, deterministic task structure, reasoning escalation, and tier-specific reply contracts.
- Five-hour-only verification classification.
- Retry escalation and the five-attempt cap.
- Always-send behavior on repeated manual invocations.
- Concurrent all-account execution and stable output order.
- Nonzero aggregate exit when any account fails.
- Lock waiting, stale-lock recovery, timeouts, unavailable metadata, malformed telemetry, and credential isolation.
- `eval` using the exact production prompt builder.
- Removed commands returning an unknown-command error and removed modules no longer being referenced.

Verification proceeds in layers:

1. Focused unit and integration tests with fake Codex executables and fake app-server responses.
2. Full `npm test` and `npm run check`.
3. `gudmo doctor` against the installed local Codex CLI.
4. A live `gudmo eval` sample to confirm prompt telemetry.
5. A live `gudmo run` across every discovered account, requiring verified five-hour renewal for all accounts.

## Acceptance Criteria

- The CLI builds and runs on macOS with Node.js 20 or newer.
- Every `gudmo run` invocation checks every discovered account.
- Accounts with less than five hours remaining are skipped without a model call.
- Only the five-hour timer is targeted and evaluated.
- Each successful account has observable five-hour renewal evidence.
- Any failed or unverified account makes the overall command fail.
- Prompt attempts start small and escalate only after failed verification.
- `eval`, `doctor`, `help`, and `version` remain functional.
- Scheduler, launchd, status, logs, init, tick, daemon, and seven-day functionality are removed.
- Unit and integration tests pass with no new syntax-check failures.
- The live end-to-end run verifies all locally discovered accounts, or the exact external blocker is reported without claiming completion.
