# gudmo

`gudmo` ensures the Codex five-hour usage-window timer is active for every local account. It renews only accounts whose window has not started yet.

It is a manual macOS CLI, not a quota-increase tool. Each prompt consumes usage. Reset metadata comes from an experimental Codex app-server method and may change.

## Requirements

- macOS
- Node.js 20 or newer
- [Codex CLI](https://github.com/openai/codex) signed in with ChatGPT
- Optional: [codex-auth](https://github.com/Loongphy/codex-auth) for multiple accounts

## Install

```sh
npm link
gudmo doctor
```

## Renew every account

```sh
gudmo run
```

Every invocation checks every discovered account. If its 300-minute reset arrives in less than five hours, the window is already active and Gudmo sends no prompt. A five-second precision allowance prevents a floating `now + 5h` reset from being mistaken for an active window.

For each account, Gudmo:

1. Reads the current 300-minute Codex window.
2. Stops successfully without a model call when the reset is less than five hours away.
3. Otherwise sends a nonce-bearing prompt that starts with a cheap exact-`OK` task.
4. Waits 60 seconds and reads the window again.
5. Succeeds only when the reset stops sliding with wall time.
6. If needed, escalates generated work: 64 and 128 output words at medium reasoning, then 256 and 512 words at high reasoning.

Accounts run concurrently and print account-prefixed progress. The process exits with code 0 when every account is either already active or verifies renewal. Missing metadata, malformed telemetry, exhausted prompt tiers, or any account failure produces a nonzero exit.

The five prompt tiers make the common case inexpensive while allowing Gudmo to escalate when a tiny prompt does not renew the timer. A fresh nonce prevents the production request from being fully reusable as a cached prompt. Tier 1 replies exactly `OK`; later tiers deliberately generate bounded output because live testing showed that increasing input length alone does not reliably activate every account's window.

## Internal prompt evaluation

`eval` makes live Codex calls and consumes usage. It measures the exact prompt builder used by `run`.

```sh
gudmo eval --runs 3
gudmo eval --runs 3 --tier 3
gudmo eval --runs 3 --tier all
gudmo eval --runs 3 --tier 1 --json
```

The default is tier 1. Each tier report includes target output, reasoning effort, measurable calls, valid replies, median tokens, p95 tokens, and per-call telemetry. Reports are also saved as `eval-latest.json` in Gudmo's state directory.

## Commands

```text
gudmo run                         Renew every account's 5h timer
gudmo eval [--runs N] [--tier 1..5|all] [--json]
                                  Measure production prompt tiers
gudmo doctor                      Check Codex and credentials
gudmo help                        Show help
gudmo version                     Show the installed version
```

## Accounts and credentials

Without `codex-auth`, Gudmo uses the active Codex account. When a compatible registry exists, Gudmo discovers every account and creates a private, isolated `CODEX_HOME` for each one. It copies the corresponding credential snapshot with owner-only permissions and never switches the user's active Codex account.

Account renewal operations run concurrently. A per-account lock prevents duplicate simultaneous prompts. A second `gudmo run` waits up to two minutes for an existing renewal and reuses its verified result when possible. Dead-process locks are reclaimed.

## Configuration and state

Configuration is created automatically:

```text
~/.config/gudmo/config.json
```

Supported settings are:

- `codexPath`
- `model`
- `reasoningEffort`
- `timeoutSeconds`
- `retrySeconds`

Legacy scheduler, window, request-ceiling, and custom-message keys are removed when configuration is loaded.

Runtime state and isolated account homes are stored under:

```text
~/.local/state/gudmo/
```

Set `GUDMO_HOME` to place configuration and state together in another directory. This is useful for isolated testing.

## Verification semantics

Gudmo compares the five-hour reset timestamp before and after a real prompt:

- `renewed`: the reset is fixed, usage increased, or reset movement differs from wall-clock drift.
- `still-floating`: the reset advanced by approximately the observation interval; Gudmo escalates the prompt.
- `unavailable`: comparable 300-minute metadata is missing; Gudmo performs one metadata-only retry, then fails without claiming success.
- `failed`: the Codex call failed or all five tiers left the timer floating.

This is observable evidence from experimental metadata, not a service-level guarantee from OpenAI.

## Development

Tests use fake Codex executables and do not contact a model:

```sh
npm test
npm run check
node bin/gudmo.js help
```

Live verification intentionally consumes usage:

```sh
node bin/gudmo.js eval --runs 3 --tier 1 --json
node bin/gudmo.js run
```

## Version 0.5.0

Gudmo now focuses on one job: ensuring the five-hour window is active for all accounts. Automatic scheduling, launchd installation, seven-day renewal, status/log commands, and rolling request ceilings were removed.

## License

[MIT](LICENSE)
