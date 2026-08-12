import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/constants.js";
import { calculateNextSend, planNextSend, runAccountsDaemon, runDaemon } from "../src/daemon.js";
import { getAccountPaths } from "../src/accounts.js";
import { getPaths } from "../src/paths.js";
import { createEmptyState, loadState } from "../src/scheduler.js";

const HOUR = 60 * 60 * 1_000;
const START = Date.parse("2026-08-11T00:00:00.000Z");

test("an earlier server reset wins over the five-hour cap", () => {
  const state = createEmptyState();
  state.lastSuccessAt = new Date(START).toISOString();
  const decision = calculateNextSend({
    state,
    config: DEFAULT_CONFIG,
    nowMs: START,
    serverWindows: [{ resetsAt: new Date(START + 2 * HOUR).toISOString() }],
  });

  assert.equal(decision.at, "2026-08-11T02:00:01.000Z");
  assert.equal(decision.reason, "server-reset");
});

test("the local cap schedules no later than five hours", () => {
  const state = createEmptyState();
  state.lastSuccessAt = new Date(START).toISOString();
  const decision = calculateNextSend({
    state,
    config: DEFAULT_CONFIG,
    nowMs: START,
    serverWindows: [{ resetsAt: new Date(START + 24 * HOUR).toISOString() }],
  });

  assert.equal(decision.at, "2026-08-11T05:00:00.000Z");
  assert.equal(decision.reason, "five-hour-cap");
});

test("a failed due send retries on backoff instead of waiting for a new reset", () => {
  const state = createEmptyState();
  state.lastError = "offline";
  state.retryAt = new Date(START + 60_000).toISOString();
  const decision = calculateNextSend({
    state,
    config: DEFAULT_CONFIG,
    nowMs: START,
    serverWindows: [{ resetsAt: new Date(START + 24 * HOUR).toISOString() }],
  });

  assert.equal(decision.at, "2026-08-11T00:01:00.000Z");
  assert.equal(decision.reason, "retry-backoff");
});

test("an already consumed server reset is ignored before grace is added", () => {
  const state = createEmptyState();
  state.lastSuccessAt = new Date(START + 500).toISOString();
  const decision = calculateNextSend({
    state,
    config: DEFAULT_CONFIG,
    nowMs: START + 500,
    serverWindows: [{ resetsAt: new Date(START).toISOString() }],
  });

  assert.equal(decision.at, "2026-08-11T05:00:00.500Z");
  assert.equal(decision.reason, "five-hour-cap");
});

test("a failed server read persists the five-hour fallback", async (t) => {
  const paths = await setup(t);
  const plan = await planNextSend({
    paths,
    clock: () => START,
    reader: async () => { throw new Error("protocol unavailable"); },
  });
  const state = await loadState(paths.state);

  assert.equal(plan.at, "2026-08-11T05:00:00.000Z");
  assert.equal(state.rateLimits.error, "protocol unavailable");
});

test("daemon waits once for the planned reset and sends once", async (t) => {
  const paths = await setup(t);
  let now = START;
  let waitedUntil;
  let calls = 0;
  const result = await runDaemon({
    paths,
    clock: () => now,
    maxSends: 1,
    reader: async () => ({
      fetchedAt: new Date(now).toISOString(),
      windows: [{ resetsAt: new Date(START + 2 * HOUR).toISOString() }],
    }),
    waiter: async (timestamp) => {
      waitedUntil = timestamp;
      now = Date.parse(timestamp);
    },
    runner: async () => {
      calls += 1;
      return { ok: true };
    },
  });

  assert.equal(waitedUntil, "2026-08-11T02:00:01.000Z");
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: "stopped", sends: 1 });
});

test("multi-account daemon schedules accounts independently without switching", async (t) => {
  const paths = await setup(t);
  let now = START;
  const calls = [];
  const accounts = ["one", "two"].map((key) => ({
    key,
    label: key,
    isolated: true,
    paths: getAccountPaths(paths, key),
    codexEnv: { CODEX_HOME: path.join(paths.root, key) },
  }));

  const result = await runAccountsDaemon({
    paths,
    maxSends: 2,
    clock: () => now,
    waiter: async (timestamp) => { now = Date.parse(timestamp); },
    accountLoader: async () => accounts,
    accountPreparer: async (account) => account,
    reader: async (_config, options) => ({
      fetchedAt: new Date(now).toISOString(),
      windows: [{
        resetsAt: new Date(START + (options.account.key === "one" ? HOUR : 2 * HOUR)).toISOString(),
      }],
    }),
    runner: async (_config, options) => {
      calls.push({ key: options.account.key, codexHome: options.env.CODEX_HOME, at: now });
      return { ok: true };
    },
  });

  assert.deepEqual(calls.map((call) => call.key), ["one", "two"]);
  assert.deepEqual(calls.map((call) => call.at), [START + HOUR + 1_000, START + 2 * HOUR + 1_000]);
  assert.notEqual(calls[0].codexHome, calls[1].codexHome);
  assert.deepEqual(result, { status: "stopped", sends: 2 });
});

test("five-hour account re-discovery does not defer the five-hour send", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sentAt = null;
  const account = {
    key: "one",
    label: "one",
    isolated: true,
    paths: getAccountPaths(paths, "one"),
    codexEnv: { CODEX_HOME: path.join(paths.root, "one") },
  };

  await runAccountsDaemon({
    paths,
    maxSends: 1,
    clock: () => now,
    waiter: async (timestamp) => { now = Date.parse(timestamp); },
    accountLoader: async () => [account],
    accountPreparer: async (value) => value,
    reader: async () => ({ fetchedAt: new Date(now).toISOString(), windows: [] }),
    runner: async () => {
      sentAt = now;
      return { ok: true };
    },
  });

  assert.equal(sentAt, START + 5 * HOUR);
});

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-daemon-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = getPaths({ GUDMO_HOME: root });
  await ensureConfig(paths.config);
  return paths;
}
