# gudmo

`gudmo` is a small macOS CLI that schedules measured, minimal Codex prompts around your account's usage-window resets.

It is a best-effort local scheduler, not a way to increase your OpenAI plan's quota. Codex limit behavior is not guaranteed, and every prompt consumes some usage. Gudmo reports model token telemetry separately from Codex usage-window percentages; it does not claim that the two are equivalent.

## Requirements

- macOS
- Node.js 20 or newer
- [Codex CLI](https://github.com/openai/codex) signed in with ChatGPT
- Optional: [codex-auth](https://github.com/Loongphy/codex-auth) for multiple accounts

## Install

Clone the repository, then run:

```sh
npm link
gudmo doctor
gudmo install
```

`gudmo install` creates and starts a macOS launch agent. To create it without starting the scheduler:

```sh
gudmo install --no-start
```

## Usage

```text
gudmo doctor               Check the local setup
gudmo eval --runs 20       Measure the repeatable token footprint
gudmo eval --runs 20 --json  Emit the same eval as machine-readable JSON
gudmo run                  Anchor any due usage-window timers
gudmo run --window 5h      Anchor the 5-hour timer when it is due
gudmo status               Show account and scheduler state
gudmo status --refresh     Refresh server reset times
gudmo logs --lines 50      Show recent activity
gudmo install              Install and start the scheduler
gudmo uninstall            Stop and remove the scheduler
gudmo help                 Show all commands
```

`gudmo run` skips accounts whose requested timers are already anchored and not due. For due timers, the explicit command bypasses the automatic scheduler's rolling request ceiling and makes up to five verified attempts. Each attempt takes about one minute when server window metadata is available. Gudmo runs isolated accounts concurrently, samples each reset before its prompt, waits 60 seconds, and samples again so it can distinguish an anchored timer from a reset that is still sliding with wall-clock time. If a background tick already holds an account lock, the manual command waits up to two minutes and reuses any window result completed while it waited. Locks left behind by interrupted processes are reclaimed immediately.

Manual runs stream account-prefixed progress while they work: current-window checks, prompt attempts, timer-verification waits, lock contention, and retries. Final account results include elapsed time, so an intentional observation or backoff never looks like a hung command.

## How it works

Gudmo reads the reset times reported by the local Codex app server and schedules the next prompt just after the earliest reset. A five-hour local cap is used as a fallback when reset data is unavailable.

The scheduler runs only when needed. While waiting, macOS uses `caffeinate -s`, which prevents sleep on AC power but allows normal sleep on battery.

If a `codex-auth` registry is present, Gudmo detects its accounts automatically and gives each one an isolated `CODEX_HOME`. It does not switch your active Codex account or replace `~/.codex/auth.json`.

## Configuration

Gudmo creates its configuration on first use:

```text
~/.config/gudmo/config.json
```

The defaults use the prompt `Reply only: OK`, low reasoning effort, both the 5-hour and 7-day windows, a five-request rolling 24-hour ceiling, and the current Codex default model. Existing configurations using the former default prompt, `gudmo`, are migrated automatically; custom prompts are preserved. Run `gudmo init` to create the file explicitly.

### Measurable token footprint

Gudmo's repeatable metric is **T24**, the conservative estimated token footprint of a default rolling 24-hour window:

```text
tokens/request = input_tokens + output_tokens
T24 = p95(tokens/request across repeated runs) × max requests per rolling 24 hours
```

Cached input tokens remain included in `input_tokens`; Gudmo does not discount them. The default scheduler and `tick` paths share a hard ceiling of five attempted model requests in any rolling 24 hours, including failures and retries. When the ceiling is reached, automatic scheduling resumes only after the oldest attempt leaves the window. An explicit `gudmo run` bypasses that automatic ceiling for due timers and has a separate five-attempt limit for the invocation, so manual usage can exceed T24.

Run the production invocation 20 times and print a human-readable report:

```sh
gudmo eval --runs 20
```

The eval passes only when every run reports valid token telemetry and replies with exactly `OK`. It records the Gudmo version, Codex version, model, reasoning effort, prompt, timestamp, per-run usage, median, p95, and T24 estimate. The same report is saved to `~/.local/state/gudmo/eval-latest.json`; `--json` also prints it for CI or comparison.

`gudmo eval` deliberately makes the requested number of live Codex calls and is separate from the scheduler ceiling. Use it intentionally: the eval itself consumes usage and its calls are not included in the T24 scheduler estimate.

Runtime state and rotating activity logs are stored in:

```text
~/.local/state/gudmo/
```

Gudmo reads fresh reset metadata immediately before each prompt, waits 60 seconds after the prompt, and reads it again. A window is `anchored` when its reset stays fixed while wall-clock time advances. It is `still-floating` when the reset advances by approximately the observation interval, which means the prompt completed but failed to start the server timer. Missing metadata is `unavailable`, never success. Each result includes `updated`, `beforeResetsAt`, `afterResetsAt`, `changeSeconds`, and `observationSeconds`.

A `still-floating` window remains due and retries after `retrySeconds`. A manual `gudmo run` performs up to five attempts regardless of rolling request history; background cycles persist the retry time for their next wake and remain subject to the rolling 24-hour ceiling. Unavailable metadata gets one short verification-only retry without another model request; if it remains unavailable, Gudmo reports `unverified` and uses the local five-hour fallback. Activity logs use `success` only for verified anchored windows, `verification-failure` for floating timers, and `verification-pending`/`verification-unavailable` for missing metadata.

This comparison is observational evidence from the experimental Codex app-server metadata, not a guarantee of subscription behavior. For example, if the app-server exposes only its 10,080-minute window, Gudmo can verify `7d` while correctly reporting `5h` as unavailable.

## Development

The test suite uses fake Codex executables and does not contact a model:

```sh
npm test
npm run check
node bin/gudmo.js help
```

## Limitations

- Background scheduling is supported on macOS only.
- Reset-time data comes from an experimental Codex app-server method and may change.
- Prompts delayed while the Mac is asleep run after it wakes.
- Without `codex-auth`, Gudmo uses the Codex account active at execution time.
- Token counts come from Codex CLI telemetry. They measure model tokens, not subscription quota percentages or billing.
- Custom prompts, explicit manual runs, and eval runs can use more tokens than the default measured scheduler configuration.
- Isolated account credentials are stored with owner-only permissions, but should still be treated as sensitive.

## License

[MIT](LICENSE)
