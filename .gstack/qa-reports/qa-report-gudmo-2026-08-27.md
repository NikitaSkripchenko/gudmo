# Gudmo 0.5.0 End-to-End QA Report

## Verdict

**PASS** — the final production build checked all three discovered accounts, recognized every 300-minute window as already active, sent no model prompts, and exited with code 0.

## Environment

- Date: 2026-08-27
- Platform: macOS
- Node.js: 26.3.1 (project minimum remains 20)
- Codex CLI: 0.145.0
- Gudmo: 0.5.0
- Accounts: 3 isolated `codex-auth` snapshots
- Test state: isolated under `GUDMO_HOME`; existing installed Gudmo state was not overwritten

## Automated Verification

- `npm test`: 50 passed, 0 failed
- `npm run check`: all retained JavaScript files passed `node --check`
- `node bin/gudmo.js help`: only `run`, `eval`, `doctor`, `help`, and `version` exposed
- `node bin/gudmo.js version`: `gudmo 0.5.0`
- `git diff --check`: passed

## Doctor

Live `doctor` passed platform, Node, Codex CLI, and all three credential snapshots. Testing found and fixed a regression where removing the obsolete caffeinate check also removed the `fs` import still needed for snapshot validation. `test/doctor.test.js` now covers valid isolated snapshots.

## Production Prompt Eval

Tier 1 was evaluated with three live calls:

- Prompt: finalized low-reasoning exact-`OK` tier, 133 characters
- Measurable calls: 3/3
- Exact `OK` replies: 3/3
- Median total tokens: 17,602
- P95 total tokens: 18,061
- Result: PASS

Codex CLI execution context dominated token totals, showing that input payload growth was not an efficient renewal lever.

## Calibration Findings

The first all-account run used input-size escalation and correctly failed closed for one account:

- Account 1: still floating after five tiers; final tier had 1,024 input words, 14,029 total tokens, and 5 output tokens.
- Account 2: renewed at tier 4.
- Account 3: renewed at tier 1.

Two isolated experiments established the effective workload dimension:

1. Low reasoning with 766 output tokens still floated; usage remained 0%.
2. High reasoning with a bounded 512-word response produced 2,444 output tokens, moved usage from 0% to 1%, and anchored the reset.

Production tiers were changed to generated-work escalation:

| Tier | Target output | Reasoning |
|---:|---:|---|
| 1 | exact `OK` | low |
| 2 | 64 words | medium |
| 3 | 128 words | medium |
| 4 | 256 words | high |
| 5 | 512 words | high |

## Renewal Calibration Run

The modified production command sent tier 1 to all accounts concurrently. Final ordered results:

| Account | Status | Tier | Attempts | Elapsed | Reset change / observation |
|---|---|---:|---:|---:|---:|
| account-1 | renewed | 1 | 1 | 66s | 0s / 65s |
| account-2 | renewed | 1 | 1 | 66s | 0s / 65s |
| account-3 | renewed | 1 | 1 | 66s | 0s / 65s |

- Aggregate exit code: 0
- Verified accounts: 3/3
- Credentials or email addresses stored in this report: none

## Final Active-Window Run

The corrected production command first compared each five-hour reset with its fresh metadata timestamp. All three resets were less than five hours away, so every account returned `active` without a model call:

| Account | Status | Prompts | Elapsed |
|---|---|---:|---:|
| account-1 | active | 0 | 1s |
| account-2 | active | 0 | 1s |
| account-3 | active | 0 | 1s |

- Aggregate exit code: 0
- Accounts checked: 3/3
- Model prompts sent: 0

## Acceptance Criteria

- App runs on macOS with Node.js 20+: PASS
- `run` checks every discovered account: PASS, observed 3/3 concurrently
- Active windows with less than five hours remaining are skipped: PASS, 3/3 live accounts and 0 prompts
- Only the five-hour window is evaluated: PASS
- Success requires observable anchored reset metadata: PASS
- Any unverified account fails the aggregate command: PASS in automated and initial live testing
- Prompt starts cheap and escalates bounded work only when needed: PASS
- `eval`, `doctor`, `help`, and `version` work: PASS
- Scheduler, launchd, status, logs, init, tick, daemon, and seven-day behavior removed: PASS
- Unit/integration tests and syntax checks pass: PASS

## PR Summary

QA reduced Gudmo to five-hour activation, calibrated adaptive renewal workloads, and verified 3/3 active accounts were skipped without model calls; automated suite: 50 passed, 0 failed.
