import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import { executeTick, loadState } from "../src/scheduler.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-08-11T00:00:00.000Z");

test("first tick anchors both windows with one request", async (t) => {
  const paths = await setup(t);
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { ok: true };
  };

  const result = await executeTick({ paths, runner, clock: () => START });
  const state = await loadState(paths.state);

  assert.equal(result.status, "sent");
  assert.deepEqual(result.windows, ["5h", "7d"]);
  assert.equal(calls, 1);
  assert.equal(state.windows["5h"].nextDueAt, "2026-08-11T05:00:00.000Z");
  assert.equal(state.windows["7d"].nextDueAt, "2026-08-18T00:00:00.000Z");
});

test("tick skips before due and renews only the due window", async (t) => {
  const paths = await setup(t);
  let now = START;
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { ok: true };
  };

  await executeTick({ paths, runner, clock: () => now });
  now += HOUR;
  assert.equal((await executeTick({ paths, runner, clock: () => now })).status, "not-due");
  now = START + 5 * HOUR;
  const result = await executeTick({ paths, runner, clock: () => now });
  const state = await loadState(paths.state);

  assert.deepEqual(result.windows, ["5h"]);
  assert.equal(calls, 2);
  assert.equal(state.windows["5h"].nextDueAt, "2026-08-11T10:00:00.000Z");
  assert.equal(state.windows["7d"].nextDueAt, "2026-08-18T00:00:00.000Z");
});

test("an overdue 5h window and due 7d window collapse into one request", async (t) => {
  const paths = await setup(t);
  let now = START;
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { ok: true };
  };

  await executeTick({ paths, runner, clock: () => now });
  now = START + 7 * DAY;
  const result = await executeTick({ paths, runner, clock: () => now });

  assert.deepEqual(result.windows, ["5h", "7d"]);
  assert.equal(calls, 2);
});

test("a forced single-window run leaves the other anchor unchanged", async (t) => {
  const paths = await setup(t);
  let now = START;
  const runner = async () => ({ ok: true });
  await executeTick({ paths, runner, clock: () => now });
  now += HOUR;

  await executeTick({ paths, runner, clock: () => now, forceWindows: ["7d"] });
  const state = await loadState(paths.state);

  assert.equal(state.windows["5h"].nextDueAt, "2026-08-11T05:00:00.000Z");
  assert.equal(state.windows["7d"].nextDueAt, "2026-08-18T01:00:00.000Z");
});

test("failed requests persist an error and obey retry backoff", async (t) => {
  const paths = await setup(t);
  let now = START;
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { ok: false, error: "offline" };
  };

  const failed = await executeTick({ paths, runner, clock: () => now });
  now += 30_000;
  const waiting = await executeTick({ paths, runner, clock: () => now });

  assert.equal(failed.status, "failed");
  assert.equal(waiting.status, "retry-wait");
  assert.equal(calls, 1);
  assert.equal((await loadState(paths.state)).lastError, "offline");
});

test("concurrent ticks cannot double-send", async (t) => {
  const paths = await setup(t);
  let releaseRunner;
  const runnerWait = new Promise((resolve) => {
    releaseRunner = resolve;
  });
  const first = executeTick({
    paths,
    clock: () => START,
    runner: async () => {
      await runnerWait;
      return { ok: true };
    },
  });

  await waitForPath(paths.lock);
  const second = await executeTick({ paths, clock: () => START, runner: async () => ({ ok: true }) });
  releaseRunner();

  assert.equal(second.status, "locked");
  assert.equal((await first).status, "sent");
});

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-scheduler-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = getPaths({ GUDMO_HOME: root });
  await ensureConfig(paths.config);
  return paths;
}

async function waitForPath(file) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fs.access(file).then(() => true).catch(() => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${file}`);
}
