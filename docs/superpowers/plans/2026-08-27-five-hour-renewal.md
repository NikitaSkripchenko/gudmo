# Gudmo Five-Hour Renewal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every `gudmo run` invocation ensure the Codex five-hour timer is active for every discovered account, without sending when less than five hours remain.

**Architecture:** Replace the scheduler-oriented state machine with a manual renewal pipeline. A pure prompt builder supplies five nonce-bearing workload tiers; each account runs under its existing isolated credentials and lock, verifies only the 300-minute server window, and escalates generated output plus reasoning effort until renewal is observed or five attempts fail. Keep `eval` on the same prompt builder, while deleting scheduling, launchd, seven-day, status, and logging surfaces.

**Tech Stack:** Node.js 20+, ECMAScript modules, built-in `node:test`, Codex CLI JSON events, Codex app-server JSON-RPC, macOS.

**Spec:** `docs/superpowers/specs/2026-08-27-five-hour-renewal-design.md`

## Global Constraints

- Support macOS with Node.js 20 or newer.
- Add no runtime dependencies.
- Every `gudmo run` invocation checks every discovered account and skips model usage when fresh metadata shows less than five hours remaining.
- Only the 300-minute Codex window is targeted or reported.
- Exit successfully only when every account is verified renewed.
- Use at most five prompt attempts per account, escalating only after failed verification.
- Keep `eval`, `doctor`, `help`, and `version`; remove all other commands.
- Preserve isolated `codex-auth` credentials and per-account concurrency locks.
- Never report missing or malformed server metadata as success.

## Live Calibration Amendment

The initial task steps below record the original input-size hypothesis. Live end-to-end testing falsified it: a 1,024-word input with an `OK`-only response did not anchor one account. The implemented tiers instead escalate generated output and reasoning effort: exact `OK`/low, 64 words/medium, 128 words/medium, 256 words/high, and 512 words/high. The final configuration is defined in `src/prompt.js`, covered by `test/prompt.test.js`, and reflected in the updated design spec and README. Where the original task samples below mention `PROMPT_WORD_COUNTS`, input payload growth, or exact `OK` at every tier, this calibration amendment supersedes them.

The final user correction also supersedes original always-send requirements: a fresh 300-minute reset less than five hours away is already active and returns success without a prompt. `hasActiveFiveHourWindow` applies a five-second precision allowance so a floating reset near exactly five hours is still renewed.

---

### Task 1: Production prompt tiers

**Files:**
- Create: `src/prompt.js`
- Create: `test/prompt.test.js`
- Modify: `src/constants.js`
- Modify: `test/codex.test.js`

**Interfaces:**
- Produces: `PROMPT_WORD_COUNTS: readonly number[]` with `[64, 128, 256, 512, 1024]`.
- Produces: `buildRenewalPrompt({ tier, nonce }): { tier, nonce, wordCount, message }`.
- Tasks 2 and 4 pass `message` to `runCodex` through `{ ...config, message }`.

- [ ] **Step 1: Write the failing tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { buildRenewalPrompt, PROMPT_WORD_COUNTS } from "../src/prompt.js";

test("renewal prompts have five increasing tiers", () => {
  assert.deepEqual(PROMPT_WORD_COUNTS, [64, 128, 256, 512, 1024]);
  const lengths = PROMPT_WORD_COUNTS.map((_, tier) =>
    buildRenewalPrompt({ tier, nonce: "nonce-a" }).message.length);
  assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
  assert.equal(new Set(lengths).size, 5);
});

test("a prompt includes its nonce once and demands exact OK", () => {
  const prompt = buildRenewalPrompt({ tier: 0, nonce: "unique-nonce" });
  assert.equal(prompt.message.split("unique-nonce").length - 1, 1);
  assert.match(prompt.message, /Reply exactly OK/);
  assert.equal(prompt.wordCount, 64);
});

test("unknown tiers and empty nonces are rejected", () => {
  assert.throws(() => buildRenewalPrompt({ tier: 5, nonce: "x" }), /tier/);
  assert.throws(() => buildRenewalPrompt({ tier: 0, nonce: "" }), /nonce/);
});
```

- [ ] **Step 2: Prove the tests fail**

Run: `node --test test/prompt.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/prompt.js`.

- [ ] **Step 3: Implement the prompt builder**

```js
export const PROMPT_WORD_COUNTS = Object.freeze([64, 128, 256, 512, 1024]);

const WORDS = Object.freeze([
  "amber", "birch", "cedar", "delta", "ember", "frost", "grove", "harbor",
  "island", "juniper", "kernel", "linen", "meadow", "north", "orbit", "pine",
]);

export function buildRenewalPrompt({ tier, nonce }) {
  if (!Number.isInteger(tier) || tier < 0 || tier >= PROMPT_WORD_COUNTS.length) {
    throw new Error(`prompt tier must be an integer from 0 to ${PROMPT_WORD_COUNTS.length - 1}`);
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("prompt nonce must be a non-empty string");
  }
  const wordCount = PROMPT_WORD_COUNTS[tier];
  const words = Array.from({ length: wordCount }, (_, index) => WORDS[index % WORDS.length]);
  words[Math.floor(words.length / 2)] = nonce;
  words[words.length - 1] = "pine";
  return {
    tier,
    nonce,
    wordCount,
    message: [
      "Silently inspect the payload below. Confirm that its unique nonce appears exactly once and that the final payload word is pine. Do not explain your work. Reply exactly OK if both checks pass.",
      `Payload: ${words.join(" ")}`,
    ].join("\n"),
  };
}
```

The builder explicitly forces the last payload word to `pine`. Do not add user-configurable prompt content.

- [ ] **Step 4: Remove the old default message and update Codex tests**

Reduce `DEFAULT_CONFIG` to `retrySeconds`, `timeoutSeconds`, `reasoningEffort`, `model`, and `codexPath`. Change the Codex argument test to:

```js
const config = { ...DEFAULT_CONFIG, message: "production prompt" };
const args = buildCodexArgs(config, "/tmp");
assert.equal(args.at(-1), "production prompt");
```

- [ ] **Step 5: Verify and commit**

Run: `node --test test/prompt.test.js test/codex.test.js`

Expected: PASS.

```bash
git add src/prompt.js src/constants.js test/prompt.test.js test/codex.test.js
git commit -m "feat: add adaptive renewal prompts"
```

---

### Task 2: Five-hour verification and renewal engine

**Files:**
- Modify: `src/scheduler.js`
- Modify: `test/scheduler.test.js`
- Modify: `src/rate-limits.js`
- Modify: `test/rate-limits.test.js`

**Interfaces:**
- Consumes: `buildRenewalPrompt({ tier, nonce })` and `PROMPT_WORD_COUNTS`.
- Produces: `createEmptyState()` with manual-run fields only.
- Produces: `buildFiveHourVerification({ beforeWindows, afterWindows, beforeCheckedAt, checkedAt, error })`.
- Produces: `renewFiveHourWindow(options)` returning `{ status, attempts, tier, elapsedMs, verification, error? }`.
- `status` is `renewed`, `unverified`, `failed`, or `locked`.

- [ ] **Step 1: Replace scheduler tests with failing renewal tests**

Delete coverage for due dates, seven-day windows, daily ceilings, next wakes, and daemon backoff. Retain lock coverage. Add:

```js
test("every invocation sends after a previous success", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  const options = {
    paths,
    clock: () => now,
    nonceFactory: () => `nonce-${sends}`,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delay) => { now += delay; },
    runner: async () => { sends += 1; return successfulCodexResult(); },
    verifier: anchoredFiveHourReader(() => now),
  };
  assert.equal((await renewFiveHourWindow(options)).status, "renewed");
  assert.equal((await renewFiveHourWindow(options)).status, "renewed");
  assert.equal(sends, 2);
});

test("a floating timer escalates prompt tiers", async (t) => {
  const paths = await setup(t);
  let now = START;
  const messages = [];
  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    nonceFactory: () => `nonce-${messages.length}`,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async () => {},
    runner: async (config) => { messages.push(config.message); return successfulCodexResult(); },
    verifier: floatingThenAnchoredReader(() => now, 2),
  });
  assert.equal(result.status, "renewed");
  assert.equal(result.attempts, 2);
  assert.ok(messages[1].length > messages[0].length);
});

test("five floating results exhaust all tiers", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    nonceFactory: () => `nonce-${sends}`,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async () => {},
    runner: async () => { sends += 1; return successfulCodexResult(); },
    verifier: floatingFiveHourReader(() => now),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 5);
  assert.equal(sends, 5);
});
```

Add explicit cases for missing 300-minute metadata, invalid timestamps, failed Codex execution, busy/stale locks, bounded lock waiting, and reuse of a success newer than the invocation start.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test test/scheduler.test.js`

Expected: FAIL because `renewFiveHourWindow` and `buildFiveHourVerification` are absent.

- [ ] **Step 3: Reduce and migrate state**

Set `STATE_VERSION` to `2` and implement:

```js
export function createEmptyState() {
  return {
    version: STATE_VERSION,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastResult: null,
    totalAttempts: 0,
    totalSuccesses: 0,
  };
}
```

`loadState` accepts version 1 by copying only those shared fields into a version-2 state. Validate `lastAttemptAt`, `lastSuccessAt`, and `lastResult.completedAt`; reject malformed timestamps.

- [ ] **Step 4: Implement five-hour classification**

Select only `durationMinutes === 300`. Return:

```js
{
  status: "renewed" | "still-floating" | "unavailable",
  beforeResetsAt,
  afterResetsAt,
  changeSeconds,
  observationSeconds,
  error,
}
```

Comparable fixed resets, increased usage evidence, or reset movement unlike wall-clock drift are `renewed`. Missing windows, invalid timestamps, zero observation time, or reader errors are `unavailable`. Movement within `max(5 seconds, 20% of observationSeconds)` of wall time without increased `usedPercent` is `still-floating`.

- [ ] **Step 5: Implement one attempt and the five-tier loop**

Use `crypto.randomUUID` as the default nonce factory. Each tier must:

1. Acquire the account lock.
2. Read before metadata.
3. Persist `lastAttemptAt` and increment `totalAttempts` before spawning Codex.
4. Run `{ ...config, message: prompt.message }`.
5. Wait 60 seconds by default.
6. Read after metadata and classify it.
7. On unavailable metadata, wait `retrySeconds` and perform one verification-only reread without another prompt.
8. Persist `lastResult` with attempt count, tier, prompt words, verification, completion time, and bounded error.
9. On renewal, set `lastSuccessAt`, clear `lastError`, and increment `totalSuccesses`.
10. Release the lock in `finally`.

If locked, wait in one-second increments for at most two minutes. After each wait, return `renewed` with `reused: true` if state shows `lastSuccessAt >= invocationStartedAt`.

- [ ] **Step 6: Remove seven-day constants and hardcoded versions**

Delete `WINDOW_DEFINITIONS`. Keep normalized upstream windows so the renewal classifier can locate 300 minutes regardless of primary/secondary placement. Import `VERSION` in `src/rate-limits.js` instead of hardcoding `0.4.2`.

- [ ] **Step 7: Verify and commit**

Run: `node --test test/scheduler.test.js test/rate-limits.test.js test/storage.test.js`

Expected: PASS.

```bash
git add src/scheduler.js src/rate-limits.js src/constants.js test/scheduler.test.js test/rate-limits.test.js test/storage.test.js
git commit -m "feat: renew and verify the five-hour window"
```

---

### Task 3: Manual all-account CLI

**Files:**
- Modify: `src/cli.js`
- Modify: `test/cli.test.js`
- Modify: `src/config.js`
- Modify: `test/config.test.js`
- Modify: `src/paths.js`

**Interfaces:**
- Consumes: `renewFiveHourWindow(options)` from Task 2.
- Produces: `run`, `eval`, `doctor`, `help`, and `version` commands only.
- Produces: `runForAccountsParallel(accounts, operation, out, err)` with stable output order and aggregate failure.

- [ ] **Step 1: Write failing CLI tests**

```js
test("run reports every account renewal", async () => {
  const accounts = [{ label: "one" }, { label: "two" }];
  const started = [];
  const code = await runForAccountsParallel(
    accounts,
    async (account) => {
      started.push(account.label);
      return { status: "renewed", attempts: 1, tier: 0, elapsedMs: 60_000 };
    },
    (line) => output.push(line),
    (line) => errors.push(line),
  );
  assert.equal(code, 0);
  assert.deepEqual(started, ["one", "two"]);
  assert.match(output.join("\n"), /one: renewed 5h timer/);
  assert.match(output.join("\n"), /two: renewed 5h timer/);
});

test("one unverified account fails the aggregate run", async () => {
  const code = await runForAccountsParallel(
    [{ label: "one" }, { label: "two" }],
    async ({ label }) => label === "one"
      ? { status: "renewed", attempts: 1, tier: 0, elapsedMs: 60_000 }
      : { status: "unverified", attempts: 1, tier: 0, elapsedMs: 61_000, error: "5h metadata unavailable" },
    (line) => output.push(line),
    (line) => errors.push(line),
  );
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /two: 5h renewal unverified/);
});
```

Add tests that `run --window 7d`, `status`, `tick`, `daemon`, `logs`, `install`, `uninstall`, and `init` fail.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test test/cli.test.js test/config.test.js`

Expected: FAIL because old commands and due-window behavior remain.

- [ ] **Step 3: Reduce configuration**

Keep and validate only:

- `timeoutSeconds`: integer 10–600.
- `retrySeconds`: integer 5–3600.
- `reasoningEffort`: existing allowed enum.
- `model`: null or non-empty string.
- `codexPath`: non-empty string.

When `ensureConfig` sees legacy keys, rewrite the file with only supported keys. This removes message, window, interval, poll, and request-ceiling configuration.

- [ ] **Step 4: Reduce CLI dispatch and output**

Remove scheduling, launchd, status, log, and window imports/branches. `run` accepts no options, prepares all accounts, and invokes `renewFiveHourWindow` concurrently.

Terminal messages:

- `<account>: renewed 5h timer with tier <N> in <attempts> attempt(s) (<elapsed>)`
- `<account>: 5h timer was renewed by the concurrent run (<elapsed>)`
- `<account>: 5h renewal unverified after <attempts> attempt(s): <error> (<elapsed>)`
- `<account>: 5h renewal failed after <attempts> attempt(s): <error> (<elapsed>)`

- [ ] **Step 5: Simplify paths**

Remove `schedulerLog`, `launchAgent`, and `log`. Keep `root`, `config`, `state`, `lock`, `evalReport`, and per-account `codexHome`.

- [ ] **Step 6: Verify and commit**

Run: `node --test test/cli.test.js test/config.test.js test/accounts.test.js test/codex.test.js`

Expected: PASS.

```bash
git add src/cli.js src/config.js src/paths.js test/cli.test.js test/config.test.js test/accounts.test.js test/codex.test.js
git commit -m "refactor: focus CLI on manual renewal"
```

---

### Task 4: Eval exact production prompt tiers

**Files:**
- Modify: `src/eval.js`
- Modify: `test/eval.test.js`
- Modify: `src/cli.js`
- Modify: `test/cli.test.js`

**Interfaces:**
- Consumes: `buildRenewalPrompt({ tier, nonce })` and `PROMPT_WORD_COUNTS`.
- Produces: `runTokenEval({ config, runs, tiers, nonceFactory, runner, runnerOptions, codexVersion, clock })`.
- Produces: per-tier token reports and an aggregate pass/fail.

- [ ] **Step 1: Write failing production-identity tests**

```js
test("eval builds every call through the production prompt builder", async () => {
  const messages = [];
  const report = await runTokenEval({
    config: DEFAULT_CONFIG,
    runs: 2,
    tiers: [0, 2],
    nonceFactory: ({ tier, run }) => `nonce-${tier}-${run}`,
    runner: async (config) => {
      messages.push(config.message);
      return sample(100 + messages.length, true);
    },
  });
  assert.equal(messages.length, 4);
  assert.match(messages[0], /nonce-0-0/);
  assert.match(messages[2], /nonce-2-0/);
  assert.deepEqual(report.tiers.map(({ tier }) => tier), [1, 3]);
});
```

Add CLI parsing cases for default tier 1, `--tier 3`, and `--tier all`; reject zero, six, and non-integers.

- [ ] **Step 2: Prove the tests fail**

Run: `node --test test/eval.test.js test/cli.test.js`

Expected: FAIL because per-tier prompt generation is absent.

- [ ] **Step 3: Implement per-tier evaluation**

```js
const prompt = buildRenewalPrompt({ tier, nonce: nonceFactory({ tier, run }) });
const sample = await runner({ ...config, message: prompt.message }, runnerOptions);
```

Each tier reports one-based `tier`, `wordCount`, `promptCharacters`, `runs`, `measurableRuns`, `exactReplies`, `medianTokens`, `p95Tokens`, and samples. Overall PASS requires valid telemetry and exact `OK` for every sample. Delete T24 and rolling-ceiling fields.

- [ ] **Step 4: Add safe CLI tier selection**

Default to tier `1`. Map `--tier all` to `[0,1,2,3,4]` and `1`–`5` to zero-based indexes. Keep `--runs 1..100` and `--json`.

- [ ] **Step 5: Verify and commit**

Run: `node --test test/eval.test.js test/cli.test.js`

Expected: PASS.

```bash
git add src/eval.js src/cli.js test/eval.test.js test/cli.test.js
git commit -m "refactor: evaluate production prompt tiers"
```

---

### Task 5: Delete unsupported surfaces

**Files:**
- Delete: `src/cycle.js`
- Delete: `src/daemon.js`
- Delete: `src/launchd.js`
- Delete: `test/cycle.test.js`
- Delete: `test/daemon.test.js`
- Delete: `test/launchd.test.js`
- Modify: `src/storage.js`
- Modify: `test/storage.test.js`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: no scheduling, launchd, append-log, seven-day, or next-wake imports anywhere.

- [ ] **Step 1: Add a failing help-surface test**

```js
test("help contains no scheduler or seven-day surface", async () => {
  const help = [];
  assert.equal(await main(["help"], { out: (line) => help.push(line) }), 0);
  const text = help.join("\n");
  for (const removed of ["7d", "tick", "daemon", "status", "logs", "install", "uninstall"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${removed}\\b`));
  }
});
```

- [ ] **Step 2: Delete dead modules and trim storage**

Delete the listed files. Remove `appendLog` and `MAX_LOG_BYTES` from `src/storage.js`, plus the rotation test. Keep atomic reads/writes and live/dead lock tests.

- [ ] **Step 3: Update version and package checks**

Change version `0.4.2` to `0.5.0` in `package.json`, `package-lock.json`, and `src/constants.js`. Change the description to `Reliably renew the Codex five-hour usage window for every local account.` Set `check` to syntax-check every retained source file, including `prompt.js`, while removing deleted modules.

- [ ] **Step 4: Prove dead surfaces are gone**

Run:

```bash
rg -n "cycle|daemon|launchd|WINDOW_DEFINITIONS|enabledWindows|nextWake|7d|appendLog|maxRequestsPer24Hours" src test package.json
```

Expected: no matches. Remove every source/test match before continuing.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test
npm run check
node bin/gudmo.js help
node bin/gudmo.js version
```

Expected: PASS; help lists only retained commands.

```bash
git add package.json package-lock.json src test
git commit -m "refactor: remove automatic scheduling surfaces"
```

---

### Task 6: Documentation and live end-to-end verification

**Files:**
- Modify: `README.md`
- Create: `.gstack/qa-reports/qa-report-gudmo-2026-08-27.md`
- Create: `.gstack/qa-reports/baseline.json`

**Interfaces:**
- Consumes: final CLI from Tasks 1–5.
- Produces: user instructions and reproducible verification evidence.

- [ ] **Step 1: Rewrite README around the single goal**

Document that `run` always sends to all accounts, targets only five hours, uses tiers of 64/128/256/512/1024 payload words with fresh nonces, runs accounts concurrently, waits 60 seconds per observation, and fails on any unverified account. Document `eval --runs N [--tier 1..5|all] [--json]`, credential isolation, paths, upstream metadata limitations, and the removal of scheduling/seven-day behavior in 0.5.0.

- [ ] **Step 2: Run automated verification**

Run:

```bash
npm test
npm run check
node bin/gudmo.js help
node bin/gudmo.js doctor
```

Expected: PASS. Remove the `caffeinate` doctor check because background scheduling no longer exists.

- [ ] **Step 3: Run a bounded live eval**

Run: `node bin/gudmo.js eval --runs 3 --tier 1 --json`

Expected: three measurable calls, three exact `OK` replies, distinct nonces, and PASS. Record input, cached input, output, and p95 totals without credentials.

- [ ] **Step 4: Run live all-account renewal**

Run: `node bin/gudmo.js run`

Expected: one `renewed 5h timer` result per discovered account and exit code 0. Capture attempts, tier, elapsed time, and before/after reset evidence. Redact account identifiers containing emails.

If an account stays floating, tune `PROMPT_WORD_COUNTS` once from the observed tiers, update prompt tests and README, rerun `npm test`, and repeat the live run. If metadata is unavailable, report the upstream blocker and do not claim success.

- [ ] **Step 5: Write QA evidence**

Write the Markdown report with environment versions, automated results, eval metrics, discovered account count, redacted per-account renewal evidence, and a PASS only when all accounts renew. Write `baseline.json` with date, version, account count, eval result, aggregate renewal result, and redacted account statuses.

- [ ] **Step 6: Final verification and commit**

Run:

```bash
npm test
npm run check
git diff --check
git status --short
```

Expected: all tests/checks PASS and the diff is clean.

```bash
git add README.md .gstack/qa-reports/qa-report-gudmo-2026-08-27.md .gstack/qa-reports/baseline.json
git commit -m "docs: document verified five-hour renewal"
```

---

## Final Acceptance Check

- [ ] `npm test` passes.
- [ ] `npm run check` passes.
- [ ] Help exposes only retained commands.
- [ ] Removed modules and seven-day vocabulary are absent from source and tests.
- [ ] Live eval returns valid telemetry and exact `OK` replies.
- [ ] Live `gudmo run` sends to every discovered account.
- [ ] Every account verifies five-hour renewal, or completion is explicitly blocked on upstream metadata.
- [ ] No credentials or unredacted account emails appear in committed QA artifacts.
