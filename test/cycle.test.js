import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getAccountPaths } from "../src/accounts.js";
import { ensureConfig } from "../src/config.js";
import { runSchedulerCycle } from "../src/cycle.js";
import { getPaths } from "../src/paths.js";
import { createEmptyState } from "../src/scheduler.js";
import { writeJsonAtomic } from "../src/storage.js";

const HOUR = 60 * 60 * 1_000;
const START = Date.parse("2026-08-11T00:00:00.000Z");

test("one scheduling cycle plans every account sequentially then exits", async (t) => {
  const paths = await setup(t);
  const accounts = createAccounts(paths);
  let activeReaders = 0;
  let maxReaders = 0;

  const result = await runSchedulerCycle({
    paths,
    clock: () => START,
    accountLoader: async () => accounts,
    accountPreparer: async (account) => account,
    reader: async (_config, options) => {
      activeReaders += 1;
      maxReaders = Math.max(maxReaders, activeReaders);
      await new Promise((resolve) => setImmediate(resolve));
      activeReaders -= 1;
      return {
        fetchedAt: new Date(START).toISOString(),
        windows: [{
          resetsAt: new Date(START + (options.account.key === "one" ? HOUR : 2 * HOUR)).toISOString(),
        }],
      };
    },
  });

  assert.equal(result.accounts, 2);
  assert.equal(result.delaySeconds, 3_601);
  assert.equal(maxReaders, 1);
});

test("a due cycle sends once, replans, and leaves no resident Node work", async (t) => {
  const paths = await setup(t);
  const [account] = createAccounts(paths).slice(0, 1);
  const state = createEmptyState();
  state.nextWakeAt = new Date(START).toISOString();
  await writeJsonAtomic(account.paths.state, state);
  let sends = 0;

  const result = await runSchedulerCycle({
    paths,
    clock: () => START,
    accountLoader: async () => [account],
    accountPreparer: async (value) => value,
    reader: async () => ({ fetchedAt: new Date(START).toISOString(), windows: [] }),
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
  });

  assert.equal(sends, 1);
  assert.equal(result.dueAccounts, 1);
  assert.equal(result.delaySeconds, 5 * 60 * 60);
});

test("a busy account lock uses a bounded 30-second retry instead of a tight loop", async (t) => {
  const paths = await setup(t);
  const [account] = createAccounts(paths).slice(0, 1);
  const state = createEmptyState();
  state.nextWakeAt = new Date(START).toISOString();
  await writeJsonAtomic(account.paths.state, state);
  await fs.mkdir(account.paths.lock, { recursive: true });

  const result = await runSchedulerCycle({
    paths,
    clock: () => START,
    accountLoader: async () => [account],
    accountPreparer: async (value) => value,
  });

  assert.equal(result.delaySeconds, 30);
});

function createAccounts(paths) {
  return ["one", "two"].map((key) => ({
    key,
    label: key,
    isolated: true,
    paths: getAccountPaths(paths, key),
    codexEnv: { CODEX_HOME: path.join(paths.root, key) },
  }));
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cycle-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = getPaths({ GUDMO_HOME: root });
  await ensureConfig(paths.config);
  return paths;
}
