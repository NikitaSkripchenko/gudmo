# gudmo

`gudmo` ensures the five-hour usage-window timer is active for every local account, across both [Codex CLI](https://github.com/openai/codex) and [Claude Code](https://claude.com/claude-code). It renews only accounts whose window has not started yet.

It is a manual macOS CLI, not a quota-increase tool. Each prompt consumes usage. Reset metadata comes from an experimental Codex app-server method and from Claude Code's `/usage` report, and either may change.

## Requirements

- macOS
- Node.js 20 or newer
- At least one of:
  - [Codex CLI](https://github.com/openai/codex) signed in with ChatGPT
  - [Claude Code](https://claude.com/claude-code) signed in with a Claude subscription
- Optional: [codex-auth](https://github.com/Loongphy/codex-auth) for multiple Codex accounts

## Install

```sh
npm link
gudmo doctor
```

## Renew every account

```sh
gudmo run                     # every provider
gudmo run --provider claude   # Claude Code only
gudmo run --provider codex    # Codex only
```

Every invocation checks every discovered account across the selected providers. If its 300-minute reset arrives in less than five hours, the window is already active and Gudmo sends no prompt. A five-second precision allowance prevents a floating `now + 5h` reset from being mistaken for an active window.

For each account, Gudmo:

1. Reads the current 300-minute Codex window.
2. Stops successfully without a model call when the reset is less than five hours away.
3. Otherwise sends a nonce-bearing 256-word prompt with low reasoning.
4. Waits 60 seconds and reads the window again.
5. If the first read still floats, polls metadata for up to two more minutes without sending another model prompt.
6. Succeeds only when the reset stops sliding with wall time.
7. If the full propagation grace period expires, retries once with 512 output words, also at low reasoning.

Steps 3 through 7 describe the Codex pipeline. Claude Code anchors its five-hour window on the first request of the window, so its reset never floats: Gudmo sends one minimal nonce-bearing prompt and accepts the renewal once `/usage` reports a five-hour window whose reset is still ahead. A missing window is never counted as success.

Accounts run concurrently and print account-prefixed progress. The process exits with code 0 when every account is either already active or verifies renewal. Missing metadata, malformed telemetry, exhausted prompt tiers, or any account failure produces a nonzero exit.

Live calibration originally found that only `high` reasoning renewed a problematic account: 256 words/high cost 2,146 output tokens, while the preceding 128-word/medium request burned 14,942 tokens and still left it floating. Both tiers were later switched to `low` reasoning by deliberate choice to cut cost, overriding that finding — this combination has not been through the same live-account calibration, so watch `gudmo run` output (or `gudmo eval --tier 1`/`--tier 2`) for accounts that stay floating and raise reasoning effort back to `high` if it recurs. A fresh nonce prevents the request from being fully reusable as a cached prompt, and delayed metadata is polled before the single fallback is allowed.

## Internal prompt evaluation

`eval` makes live Codex calls and consumes usage. It measures the exact prompt builder used by `run`.

```sh
gudmo eval --runs 3
gudmo eval --runs 3 --tier all
gudmo eval --runs 3 --tier 1 --json
gudmo eval --runs 3 --provider claude
```

The default is tier 1 of the Codex provider. Each tier report includes target output, reasoning effort, measurable calls, valid replies, median tokens, p95 tokens, and per-call telemetry. Reports are also saved as `eval-latest.json` in Gudmo's state directory.

## Commands

```text
gudmo run [--provider codex|claude|all]
                                  Renew every account's 5h timer
gudmo eval [--runs N] [--tier 1..N|all] [--provider codex|claude] [--json]
                                  Measure production prompt tiers
gudmo doctor [--provider codex|claude|all]
                                  Check provider CLIs and credentials
gudmo help                        Show help
gudmo version                     Show the installed version
```

`--provider` defaults to `all` for `run` and `doctor`, and to `codex` for `eval`.

## Accounts and credentials

Claude Code exposes one signed-in account. Gudmo labels it from `~/.claude.json` and drives it through the installed `claude` binary, reading `~/.claude.json` only for that label. It never writes Claude credentials and never changes the signed-in account.

Without `codex-auth`, Gudmo uses the active Codex account. When a compatible registry exists, Gudmo discovers every account and creates a private, isolated `CODEX_HOME` for each one. It copies the corresponding credential snapshot with owner-only permissions and never switches the user's active Codex account.

Account renewal operations run concurrently. A per-account lock prevents duplicate simultaneous prompts. A second `gudmo run` waits up to two minutes for an existing renewal and reuses its verified result when possible. Dead-process locks are reclaimed.

## Configuration and state

Configuration is created automatically:

```text
~/.config/gudmo/config.json
```

Supported settings are:

- `codexPath`
- `claudePath`
- `model` (Codex)
- `claudeModel` (Claude Code)
- `reasoningEffort` (Codex)
- `timeoutSeconds`
- `retrySeconds`

Legacy scheduler, window, request-ceiling, and custom-message keys are removed when configuration is loaded.

Runtime state and isolated account homes are stored under:

```text
~/.local/state/gudmo/
```

Set `GUDMO_HOME` to place configuration and state together in another directory. This is useful for isolated testing.

## Verification semantics

### Codex

Gudmo compares the five-hour reset timestamp before and after a real prompt:

- `renewed`: the reset is fixed, usage increased, or reset movement differs from wall-clock drift.
- `still-floating`: the reset advanced by approximately the observation interval; Gudmo escalates the prompt.
- `unavailable`: comparable 300-minute metadata is missing; Gudmo performs one metadata-only retry, then fails without claiming success.
- `failed`: the Codex call failed or both tiers left the timer floating after propagation polling.

### Claude Code

Claude reports a five-hour window only while one is running, and its reset is anchored to the window start. Gudmo therefore treats the window's presence after the prompt as the renewal evidence:

- `renewed`: `/usage` reports a five-hour window whose reset is still in the future.
- `unavailable`: no five-hour window is reported, or the reset cannot be parsed; Gudmo retries the read once, then fails without claiming success.
- `failed`: the `claude` call failed or returned no measurable token usage.

Gudmo reads Claude usage with `claude --print --output-format json --no-session-persistence /usage`, which makes no model call and consumes no usage. The report is human-formatted text, so its reset phrase is parsed against the timezone it names and fails closed when it does not match.

This is observable evidence from experimental metadata, not a service-level guarantee from OpenAI or Anthropic.

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
node bin/gudmo.js eval --runs 3 --provider claude
node bin/gudmo.js run
```

## Version 0.5.0

Gudmo focuses on one job: ensuring the five-hour window is active for all accounts. Automatic scheduling, launchd installation, seven-day renewal, status/log commands, and rolling request ceilings were removed.

Claude Code support was added on top of that job. Providers are renewed independently, hold separate locks and state, and each account still fails closed on unverified metadata.

## License

[MIT](LICENSE)
