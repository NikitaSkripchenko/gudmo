# gudmo

`gudmo` is a small macOS CLI that schedules minimal Codex prompts around your account's usage-window resets.

It is a best-effort local scheduler, not a way to increase your OpenAI plan's quota. Codex limit behavior is not guaranteed, and every prompt consumes some usage.

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
gudmo run                  Send a prompt now
gudmo run --window 5h      Send for one usage window
gudmo status               Show account and scheduler state
gudmo status --refresh     Refresh server reset times
gudmo logs --lines 50      Show recent activity
gudmo install              Install and start the scheduler
gudmo uninstall            Stop and remove the scheduler
gudmo help                 Show all commands
```

## How it works

Gudmo reads the reset times reported by the local Codex app server and schedules the next prompt just after the earliest reset. A five-hour local cap is used as a fallback when reset data is unavailable.

The scheduler runs only when needed. While waiting, macOS uses `caffeinate -s`, which prevents sleep on AC power but allows normal sleep on battery.

If a `codex-auth` registry is present, Gudmo detects its accounts automatically and gives each one an isolated `CODEX_HOME`. It does not switch your active Codex account or replace `~/.codex/auth.json`.

## Configuration

Gudmo creates its configuration on first use:

```text
~/.config/gudmo/config.json
```

The defaults use the prompt `gudmo`, low reasoning effort, both the 5-hour and 7-day windows, and the current Codex default model. Run `gudmo init` to create the file explicitly.

Runtime state and rotating activity logs are stored in:

```text
~/.local/state/gudmo/
```

After each successful prompt, Gudmo reads reset metadata again and compares it with the pre-send snapshot. Each new success entry contains `requestSucceeded: true` plus a `verification.windows` object. A window status is `advanced` when its observed reset moved later, `unchanged` when both timestamps exist but did not move later, or `unavailable` when either matching snapshot is absent. Each result includes `updated`, `beforeResetsAt`, `afterResetsAt`, and `changeSeconds`.

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
- Isolated account credentials are stored with owner-only permissions, but should still be treated as sensitive.

## License

[MIT](LICENSE)
