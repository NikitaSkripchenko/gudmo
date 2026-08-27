import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import {
  buildFiveHourVerification,
  createEmptyState,
  loadState,
  renewFiveHourWindow,
} from "../src/scheduler.js";
import { writeJsonAtomic } from "../src/storage.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-08-27T00:00:00.000Z");

test("verification classifies a fixed five-hour reset as renewed", () => {
  const result = buildFiveHourVerification({
    beforeWindows: [windowAt("2026-08-27T05:00:00.000Z")],
    afterWindows: [windowAt("2026-08-27T05:00:00.000Z")],
    beforeCheckedAt: "2026-08-27T00:00:00.000Z",
    checkedAt: "2026-08-27T00:01:00.000Z",
  });
  assert.equal(result.status, "renewed");
  assert.equal(result.changeSeconds, 0);
  assert.equal(result.observationSeconds, 60);
});

test("verification classifies a reset sliding with wall time as still floating", () => {
  const result = buildFiveHourVerification({
    beforeWindows: [windowAt("2026-08-27T05:00:00.000Z")],
    afterWindows: [windowAt("2026-08-27T05:01:00.000Z")],
    beforeCheckedAt: "2026-08-27T00:00:00.000Z",
    checkedAt: "2026-08-27T00:01:00.000Z",
  });
  assert.equal(result.status, "still-floating");
  assert.equal(result.changeSeconds, 60);
});

test("verification fails closed without comparable five-hour metadata", () => {
  const result = buildFiveHourVerification({
    beforeWindows: [{ durationMinutes: 10_080, resetsAt: "2026-09-03T00:00:00.000Z" }],
    afterWindows: [],
    beforeCheckedAt: "2026-08-27T00:00:00.000Z",
    checkedAt: "2026-08-27T00:01:00.000Z",
  });
  assert.equal(result.status, "unavailable");
});

test("every renewal invocation sends after a previous success", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  const options = {
    paths,
    clock: () => now,
    nonceFactory: () => `nonce-${sends}`,
    verificationDelayMs: MINUTE,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async () => {},
    runner: async () => { sends += 1; return successfulCodexResult(); },
    verifier: anchoredReader(() => now),
  };
  assert.equal((await renewFiveHourWindow(options)).status, "renewed");
  assert.equal((await renewFiveHourWindow(options)).status, "renewed");
  assert.equal(sends, 2);
});

test("a floating timer escalates to a larger production prompt", async (t) => {
  const paths = await setup(t);
  let now = START;
  const messages = [];
  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    nonceFactory: () => `nonce-${messages.length}`,
    verificationDelayMs: MINUTE,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async () => {},
    runner: async (config) => { messages.push(config.message); return successfulCodexResult(); },
    verifier: floatingThenAnchoredReader(() => now, 1),
  });
  assert.equal(result.status, "renewed");
  assert.equal(result.attempts, 2);
  assert.equal(result.tier, 1);
  assert.ok(messages[1].length > messages[0].length);
});

test("five floating results exhaust all prompt tiers", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    nonceFactory: () => `nonce-${sends}`,
    verificationDelayMs: MINUTE,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async () => {},
    runner: async () => { sends += 1; return successfulCodexResult(); },
    verifier: floatingReader(() => now),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.attempts, 5);
  assert.equal(result.tier, 4);
  assert.equal(sends, 5);
});

test("unavailable metadata gets one verification-only retry", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  let reads = 0;
  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    nonceFactory: () => "nonce",
    verificationDelayMs: MINUTE,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async (delay) => { now += delay; },
    runner: async () => { sends += 1; return successfulCodexResult(); },
    verifier: async () => { reads += 1; return { fetchedAt: new Date(now).toISOString(), windows: [] }; },
  });
  assert.equal(result.status, "unverified");
  assert.equal(sends, 1);
  assert.equal(reads, 3);
});

test("a failed Codex request retries and can recover", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    nonceFactory: () => `nonce-${sends}`,
    verificationDelayMs: MINUTE,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async () => {},
    runner: async () => {
      sends += 1;
      return sends === 1 ? { ok: false, error: "offline" } : successfulCodexResult();
    },
    verifier: anchoredReader(() => now),
  });
  assert.equal(result.status, "renewed");
  assert.equal(result.attempts, 2);
  assert.equal(sends, 2);
});

test("version-one scheduler state migrates to manual renewal state", async (t) => {
  const paths = await setup(t);
  await writeJsonAtomic(paths.state, {
    version: 1,
    lastAttemptAt: "2026-08-26T23:00:00.000Z",
    lastSuccessAt: "2026-08-26T22:00:00.000Z",
    lastError: null,
    totalAttempts: 4,
    totalSuccesses: 3,
  });
  assert.deepEqual(await loadState(paths.state), {
    ...createEmptyState(),
    lastAttemptAt: "2026-08-26T23:00:00.000Z",
    lastSuccessAt: "2026-08-26T22:00:00.000Z",
    totalAttempts: 4,
    totalSuccesses: 3,
  });
});

test("a run waiting on a lock reuses a concurrent verified renewal", async (t) => {
  const paths = await setup(t);
  await fs.mkdir(paths.lock, { recursive: true });
  await fs.writeFile(path.join(paths.lock, "owner.json"), JSON.stringify({ pid: process.pid }));
  let now = START;
  let sends = 0;

  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    lockRetryMs: 1_000,
    maxLockWaitMs: 2_000,
    retryWaiter: async (delay) => {
      now += delay;
      await writeJsonAtomic(paths.state, {
        ...createEmptyState(),
        lastSuccessAt: new Date(now).toISOString(),
        lastResult: {
          status: "renewed",
          tier: 0,
          completedAt: new Date(now).toISOString(),
          verification: { status: "renewed" },
        },
      });
    },
    runner: async () => { sends += 1; return successfulCodexResult(); },
  });

  assert.equal(result.status, "renewed");
  assert.equal(result.reused, true);
  assert.equal(result.attempts, 0);
  assert.equal(sends, 0);
});

function windowAt(resetsAt) {
  return { durationMinutes: 300, resetsAt, usedPercent: 0 };
}

function successfulCodexResult() {
  return {
    ok: true,
    minimalReply: true,
    usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 1, totalTokens: 101 },
  };
}

function anchoredReader(clock) {
  let reset = null;
  return async () => {
    reset ||= new Date(clock() + 5 * HOUR).toISOString();
    return { fetchedAt: new Date(clock()).toISOString(), windows: [windowAt(reset)] };
  };
}

function floatingReader(clock) {
  return async () => ({
    fetchedAt: new Date(clock()).toISOString(),
    windows: [windowAt(new Date(clock() + 5 * HOUR).toISOString())],
  });
}

function floatingThenAnchoredReader(clock, floatingAttempts) {
  let reads = 0;
  let anchoredReset = null;
  return async () => {
    const attempt = Math.floor(reads / 2);
    if (attempt >= floatingAttempts) anchoredReset ||= new Date(clock() + 5 * HOUR).toISOString();
    reads += 1;
    return {
      fetchedAt: new Date(clock()).toISOString(),
      windows: [windowAt(anchoredReset || new Date(clock() + 5 * HOUR).toISOString())],
    };
  };
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-renewal-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = getPaths({ GUDMO_HOME: root });
  await ensureConfig(paths.config);
  return paths;
}
