import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main, printRunProgress, runForAccountsParallel } from "../src/cli.js";
import { createEmptyState } from "../src/scheduler.js";

test("status initializes an isolated home and reports both manual windows due", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = [];

  const code = await main(["status", "--json"], {
    env: { GUDMO_HOME: root, HOME: root },
    out: (line) => output.push(line),
    err: (line) => output.push(line),
  });
  const status = JSON.parse(output.join("\n"));

  assert.equal(code, 0);
  assert.equal(status.accountMode, "active");
  assert.equal(status.accounts.length, 1);
  assert.deepEqual(status.accounts[0].manualTickDueNow, ["5h", "7d"]);
  assert.equal(status.schedulerConfigured, false);
  assert.equal(typeof status.schedulerRunning, "boolean");
  assert.deepEqual(status.accounts[0].tokenUsage24h, {
    requests: 0,
    measurableRequests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCeiling: 5,
  });
});

test("manual run skips an account whose requested timer is already active", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-active-window-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = createEmptyState();
  state.windows["5h"] = {
    lastSuccessAt: "2026-08-25T14:00:00.000Z",
    nextDueAt: "2099-08-25T19:00:00.000Z",
  };
  await fs.writeFile(path.join(root, "state.json"), JSON.stringify(state));
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({
    codexPath: path.join(root, "must-not-run"),
  }));
  const output = [];
  const errors = [];

  const code = await main(["run", "--window", "5h"], {
    env: { GUDMO_HOME: root, HOME: root },
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  });

  assert.equal(code, 0);
  assert.deepEqual(output, ["active account: nothing due."]);
  assert.deepEqual(errors, []);
});

test("eval emits a machine-readable, repeatable T24 report", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-eval-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-cli 9.9.9\\n'
  exit 0
fi
printf '%s\\n' \\
  '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"OK"}}' \\
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":80,"output_tokens":1}}'
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ codexPath: executable }));
  const output = [];

  const code = await main(["eval", "--runs", "3", "--json"], {
    env: { GUDMO_HOME: root, HOME: root },
    out: (line) => output.push(line),
    err: (line) => output.push(line),
  });
  const report = JSON.parse(output.join("\n"));

  assert.equal(code, 0);
  assert.equal(report.runs, 3);
  assert.equal(report.p95TokensPerRequest, 101);
  assert.equal(report.t24UpperEstimate, 505);
  assert.equal(report.metadata.codexVersion, "codex-cli 9.9.9");
  assert.equal(report.result, "PASS");
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(root, "eval-latest.json"), "utf8")),
    report,
  );
});

test("manual account runs execute concurrently and report in registry order", async () => {
  const accounts = ["one", "two", "three"].map((label) => ({ label }));
  const started = [];
  const output = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });

  const running = runForAccountsParallel(
    accounts,
    async (account) => {
      started.push(account.label);
      await gate;
      return { status: "sent", windows: ["7d"], at: account.label };
    },
    (line) => output.push(line),
    (line) => output.push(line),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["one", "two", "three"]);
  release();

  assert.equal(await running, 0);
  assert.deepEqual(output, [
    "one: sent prompt for 7d at one",
    "two: sent prompt for 7d at two",
    "three: sent prompt for 7d at three",
  ]);
});

test("a manual run says an account was not reset when its rolling ceiling is reached", async () => {
  const output = [];
  const errors = [];

  const code = await runForAccountsParallel(
    [{ label: "work@example.com" }],
    async () => ({
      status: "daily-limit",
      windows: ["5h", "7d"],
      retryAt: "2026-08-25T16:08:59.396Z",
      elapsedMs: 331_000,
    }),
    (line) => output.push(line),
    (line) => errors.push(line),
  );

  assert.equal(code, 1);
  assert.deepEqual(output, []);
  assert.deepEqual(errors, [
    "work@example.com: not reset: 24-hour request ceiling reached; scheduler will retry 5h + 7d at 2026-08-25T16:08:59.396Z (331s)",
  ]);
});

test("manual run progress explains waits with account context", () => {
  const output = [];
  const write = (line) => output.push(line);

  printRunProgress({ phase: "lock-wait", maxWaitMs: 120_000 }, "work@example.com", write);
  printRunProgress({ phase: "sending", attempt: 2, maxAttempts: 5 }, "work@example.com", write);
  printRunProgress({ phase: "verifying", delayMs: 60_000 }, "work@example.com", write);
  printRunProgress({ phase: "retrying", delayMs: 60_000, nextAttempt: 3, maxAttempts: 5 }, "work@example.com", write);

  assert.deepEqual(output, [
    "work@example.com: waiting for an existing tick (up to 2m)...",
    "work@example.com: sending prompt (attempt 2/5)...",
    "work@example.com: prompt completed; verifying timer for 1m...",
    "work@example.com: timer still floating; retrying in 1m (attempt 3/5)...",
  ]);
});
