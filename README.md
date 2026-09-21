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

1. Reads the current 300-minute window from the selected provider.
2. Stops successfully without a model call when the reset is less than five hours away.
3. Otherwise sends the shared nonce-bearing prompt that forbids tools and explanations and requests exactly `DONE`; Codex uses minimal reasoning.
4. Waits 60 seconds and reads the window again.
5. Polls metadata for up to two more minutes without sending another model prompt.
6. Succeeds only after two consecutive post-request snapshots show that the reset stopped sliding with wall time.
7. Fails closed when the reset cannot be confirmed; it never escalates to a larger model request.

Accounts run concurrently and print account-prefixed progress. The process exits with code 0 when every account is either already active or verifies renewal. Missing metadata, malformed telemetry, an unconfirmed reset, or any account failure produces a nonzero exit.

Codex and Claude share the same prompt, tier, renewal pipeline, and verification function. Only their CLI runners and metadata readers differ. Gudmo spends additional time on metadata-only polling instead of additional model work. A change in usage percentage alone is not accepted as proof: the reset timestamp itself must remain stable across consecutive observations.

## Internal prompt evaluation

`eval` makes live provider calls and consumes usage. It measures the exact shared prompt builder used by `run`.

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

### Shared verification

Gudmo compares the five-hour reset timestamp before and after a real prompt:

- `renewed`: two consecutive post-request observations show that the reset is no longer sliding with wall-clock time.
- `still-floating`: the reset advanced by approximately the observation interval; Gudmo continues metadata-only polling.
- `unavailable`: comparable 300-minute metadata is missing; Gudmo performs one metadata-only retry, then fails without claiming success.
- `failed`: the single minimal provider call failed or the timer remained unconfirmed after propagation polling.

### Provider metadata

Codex reads rate-limit metadata from its app server. Claude reads `/usage` with `claude --print --output-format json --no-session-persistence`, which makes no model call and consumes no usage. Claude's report is human-formatted text, so its reset phrase is parsed against the timezone it names and fails closed when it does not match.

This is observable evidence from experimental metadata, not a service-level guarantee from OpenAI or Anthropic.

## Development

Tests use fake Codex and Claude executables and do not contact a model:

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
