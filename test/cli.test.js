import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main, printRunProgress, runForAccountsParallel } from "../src/cli.js";

test("manual account runs execute concurrently and report renewal in discovery order", async () => {
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
      return { status: "renewed", attempts: 1, tier: 0, elapsedMs: 60_000 };
    },
    (line) => output.push(line),
    (line) => output.push(line),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["one", "two", "three"]);
  release();

  assert.equal(await running, 0);
  assert.deepEqual(output, [
    "one: renewed 5h timer with tier 1 in 1 attempt (1m)",
    "two: renewed 5h timer with tier 1 in 1 attempt (1m)",
    "three: renewed 5h timer with tier 1 in 1 attempt (1m)",
  ]);
});

test("one unverified account makes the aggregate run fail", async () => {
  const output = [];
  const errors = [];
  const code = await runForAccountsParallel(
    [{ label: "one" }, { label: "two" }],
    async ({ label }) => label === "one"
      ? { status: "renewed", attempts: 2, tier: 1, elapsedMs: 180_000 }
      : { status: "unverified", attempts: 1, tier: 0, elapsedMs: 120_000, error: "5h metadata unavailable" },
    (line) => output.push(line),
    (line) => errors.push(line),
  );

  assert.equal(code, 1);
  assert.deepEqual(output, ["one: renewed 5h timer with tier 2 in 2 attempts (3m)"]);
  assert.deepEqual(errors, [
    "two: 5h renewal unverified after 1 attempt: 5h metadata unavailable (2m)",
  ]);
});

test("an already active account is a successful no-send result", async () => {
  const output = [];
  const errors = [];
  const code = await runForAccountsParallel(
    [{ label: "active" }, { label: "renewed" }],
    async ({ label }) => label === "active"
      ? { status: "active", attempts: 0, elapsedMs: 100 }
      : { status: "renewed", attempts: 1, tier: 0, elapsedMs: 60_000 },
    (line) => output.push(line),
    (line) => errors.push(line),
  );

  assert.equal(code, 0);
  assert.deepEqual(output, [
    "active: 5h timer is already active; no prompt sent (0s)",
    "renewed: renewed 5h timer with tier 1 in 1 attempt (1m)",
  ]);
  assert.deepEqual(errors, []);
});

test("manual run progress names account, prompt tier, and waits", () => {
  const output = [];
  const write = (line) => output.push(line);
  printRunProgress({ phase: "lock-wait", maxWaitMs: 120_000 }, "work", write);
  printRunProgress({ phase: "sending", attempt: 2, maxAttempts: 5, tier: 1, outputWords: 64 }, "work", write);
  printRunProgress({ phase: "verifying", delayMs: 60_000 }, "work", write);
  printRunProgress({ phase: "retrying", delayMs: 60_000, nextAttempt: 3, maxAttempts: 5 }, "work", write);

  assert.deepEqual(output, [
    "work: waiting for an existing renewal (up to 2m)...",
    "work: sending tier 2 prompt (target 64 output words, attempt 2/5)...",
    "work: prompt completed; verifying 5h timer for 1m...",
    "work: timer not renewed; retrying in 1m (attempt 3/5)...",
  ]);
});

test("help exposes only the retained commands", async () => {
  const output = [];
  assert.equal(await main(["help"], { out: (line) => output.push(line) }), 0);
  const text = output.join("\n");
  for (const retained of ["run", "eval", "doctor", "help"]) assert.match(text, new RegExp(`\\b${retained}\\b`));
  for (const removed of ["7d", "tick", "daemon", "status", "logs", "install", "uninstall", "init"]) {
    assert.doesNotMatch(text, new RegExp(`\\b${removed}\\b`));
  }
});

test("removed commands and run options are rejected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-removed-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { GUDMO_HOME: root, HOME: root };
  for (const command of ["status", "tick", "daemon", "logs", "install", "uninstall", "init"]) {
    await assert.rejects(main([command], { env }), /unknown command/);
  }
  await assert.rejects(main(["run", "--window", "7d"], { env }), /unknown option/);
});

test("eval accepts a selected production prompt tier", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-eval-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-cli test\\n'
  exit 0
fi
printf '%s\\n' \\
  '{"type":"item.completed","item":{"type":"agent_message","text":"DONE"}}' \\
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":200}}'
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ codexPath: executable }));
  const output = [];

  const code = await main(["eval", "--runs", "1", "--tier", "3", "--json"], {
    env: { GUDMO_HOME: root, HOME: root },
    out: (line) => output.push(line),
  });
  const report = JSON.parse(output.join("\n"));

  assert.equal(code, 0);
  assert.deepEqual(report.tiers.map(({ tier }) => tier), [3]);
  assert.equal(report.tiers[0].outputWords, 128);
});

test("eval rejects prompt tiers outside 1 through 5", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-tier-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { GUDMO_HOME: root, HOME: root };
  await assert.rejects(main(["eval", "--tier", "0"], { env }), /--tier/);
  await assert.rejects(main(["eval", "--tier", "6"], { env }), /--tier/);
});
