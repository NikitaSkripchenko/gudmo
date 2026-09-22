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
      ? { status: "renewed", attempts: 1, tier: 0, elapsedMs: 90_000 }
      : { status: "unverified", attempts: 1, tier: 0, elapsedMs: 120_000, error: "5h metadata unavailable" },
    (line) => output.push(line),
    (line) => errors.push(line),
  );

  assert.equal(code, 1);
  assert.deepEqual(output, ["one: renewed 5h timer with tier 1 in 1 attempt (90s)"]);
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
  printRunProgress({ phase: "sending", attempt: 1, maxAttempts: 2, tier: 0, outputWords: 256 }, "work", write);
  printRunProgress({ phase: "verifying", delayMs: 60_000 }, "work", write);
  printRunProgress({ phase: "propagation-wait", delayMs: 30_000, poll: 3, maxPolls: 4 }, "work", write);
  printRunProgress({ phase: "retrying", delayMs: 60_000, nextAttempt: 2, maxAttempts: 2 }, "work", write);

  assert.deepEqual(output, [
    "work: waiting for an existing renewal (up to 2m)...",
    "work: sending tier 1 prompt (target 256 output words, attempt 1/2)...",
    "work: prompt completed; verifying 5h timer for 1m...",
    "work: timer update still propagating; metadata poll 3/4 in 30s...",
    "work: timer not renewed; retrying in 1m (attempt 2/2)...",
  ]);
});

test("manual run progress pluralizes a single-word claude prompt", () => {
  const output = [];
  printRunProgress({ phase: "sending", attempt: 1, maxAttempts: 1, tier: 0, outputWords: 1 }, "work", (line) => output.push(line));
  assert.deepEqual(output, [
    "work: sending tier 1 prompt (target 1 output word, attempt 1/1)...",
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
  '{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":600}}'
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ codexPath: executable }));
  const output = [];

  const code = await main(["eval", "--runs", "1", "--tier", "2", "--json"], {
    env: { GUDMO_HOME: root, HOME: root },
    out: (line) => output.push(line),
  });
  const report = JSON.parse(output.join("\n"));

  assert.equal(code, 0);
  assert.deepEqual(report.tiers.map(({ tier }) => tier), [2]);
  assert.equal(report.tiers[0].outputWords, 512);
});

test("eval rejects prompt tiers outside 1 through 2", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-tier-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { GUDMO_HOME: root, HOME: root };
  await assert.rejects(main(["eval", "--tier", "0"], { env }), /--tier/);
  await assert.rejects(main(["eval", "--tier", "3"], { env }), /--tier/);
});

test("run and doctor reject an unsupported provider", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-provider-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { GUDMO_HOME: root, HOME: root };

  await assert.rejects(main(["run", "--provider", "gemini"], { env }), /--provider must be one of/);
  await assert.rejects(main(["doctor", "--provider", "gpt"], { env }), /--provider must be one of/);
  await assert.rejects(main(["run", "--provider"], { env }), /--provider requires a value/);
});

test("eval measures the claude provider with its own single tier", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-claude-eval-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-claude");
  await fs.writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '2.1.270 (Claude Code)\\n'
  exit 0
fi
cat <<'JSON'
{"subtype":"success","is_error":false,"result":"DONE","usage":{"input_tokens":2,"cache_read_input_tokens":30000,"output_tokens":5}}
JSON
`, { mode: 0o700 });
  await fs.writeFile(path.join(root, "config.json"), JSON.stringify({ claudePath: executable }));
  const output = [];

  const code = await main(["eval", "--runs", "1", "--provider", "claude", "--json"], {
    env: { GUDMO_HOME: root, HOME: root },
    out: (line) => output.push(line),
  });
  const report = JSON.parse(output.join("\n"));

  assert.equal(code, 0);
  assert.equal(report.metadata.provider, "claude");
  assert.equal(report.metadata.codexVersion, "2.1.270 (Claude Code)");
  assert.deepEqual(report.tiers.map(({ tier }) => tier), [1]);
  assert.equal(report.tiers[0].outputWords, 1);
  assert.equal(report.tiers[0].samples[0].usage.totalTokens, 7);
});

test("eval rejects a second claude tier that does not exist", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-claude-tier-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { GUDMO_HOME: root, HOME: root };
  await assert.rejects(main(["eval", "--provider", "claude", "--tier", "2"], { env }), /--tier must be an integer from 1 to 1/);
});

test("help documents provider selection", async () => {
  const output = [];
  await main(["help"], { out: (line) => output.push(line) });
  const text = output.join("\n");
  assert.match(text, /--provider/);
  assert.match(text, /claude/);
});
