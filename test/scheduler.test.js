import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import {
  buildWindowVerification,
  createEmptyState,
  executeTick,
  executeTickUntilVerified,
  loadState,
} from "../src/scheduler.js";
import { writeJsonAtomic } from "../src/storage.js";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const START = Date.parse("2026-08-11T00:00:00.000Z");

test("first tick anchors both windows with one request", async (t) => {
  const paths = await setup(t);
  let calls = 0;
  const verification = createAnchoredVerification(() => START);
  const runner = async () => {
    calls += 1;
    return { ok: true };
  };

  const result = await executeTick({ paths, runner, clock: () => START, ...verification });
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
  const verification = createAnchoredVerification(() => now);
  const runner = async () => {
    calls += 1;
    return { ok: true };
  };

  await executeTick({ paths, runner, clock: () => now, ...verification });
  now += HOUR;
  assert.equal((await executeTick({ paths, runner, clock: () => now, ...verification })).status, "not-due");
  now = START + 5 * HOUR;
  const result = await executeTick({ paths, runner, clock: () => now, ...verification });
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
  const verification = createAnchoredVerification(() => now);
  const runner = async () => {
    calls += 1;
    return { ok: true };
  };

  await executeTick({ paths, runner, clock: () => now, ...verification });
  now = START + 7 * DAY;
  const result = await executeTick({ paths, runner, clock: () => now, ...verification });

  assert.deepEqual(result.windows, ["5h", "7d"]);
  assert.equal(calls, 2);
});

test("a forced single-window run leaves the other anchor unchanged", async (t) => {
  const paths = await setup(t);
  let now = START;
  const runner = async () => ({ ok: true });
  const verification = createAnchoredVerification(() => now);
  await executeTick({ paths, runner, clock: () => now, ...verification });
  now += HOUR;

  await executeTick({ paths, runner, clock: () => now, forceWindows: ["7d"], ...verification });
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

test("the rolling 24-hour ceiling includes failed and forced requests", async (t) => {
  const paths = await setup(t);
  let now = START;
  let calls = 0;
  const runner = async () => {
    calls += 1;
    return { ok: false, error: "model failure" };
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await executeTick({ paths, runner, clock: () => now, forceWindows: ["5h"] });
    assert.equal(result.status, "failed");
    now += HOUR;
  }
  assert.equal((await loadState(paths.state)).requestLimitRetryAt, "2026-08-12T00:00:00.000Z");
  const limited = await executeTick({ paths, runner, clock: () => now, forceWindows: ["5h"] });

  assert.equal(limited.status, "daily-limit");
  assert.equal(limited.retryAt, "2026-08-12T00:00:00.000Z");
  assert.equal((await loadState(paths.state)).requestLimitRetryAt, limited.retryAt);
  assert.equal(calls, 5);

  now = START + DAY;
  assert.equal(
    (await executeTick({ paths, runner, clock: () => now, forceWindows: ["5h"] })).status,
    "failed",
  );
  assert.equal(calls, 6);
});

test("a manual run can bypass rolling request history for a due window", async (t) => {
  const paths = await setup(t);
  const state = createEmptyState();
  state.requestHistory = [1, 2, 3, 4, 5].map((hoursAgo) => ({
    at: new Date(START - hoursAgo * HOUR).toISOString(),
    ok: true,
    minimalReply: true,
    usage: null,
  }));
  state.totalAttempts = 5;
  await writeJsonAtomic(paths.state, state);
  let sends = 0;

  const result = await executeTickUntilVerified({
    paths,
    forceWindows: ["5h"],
    onlyDueWindows: true,
    ignoreRequestLimit: true,
    clock: () => START,
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
    ...createAnchoredVerification(() => START, ["5h"]),
  });

  assert.equal(result.status, "sent");
  assert.equal(sends, 1);
  assert.equal((await loadState(paths.state)).requestHistory.length, 6);
});

test("progress reports the rolling request number instead of the lifetime attempt count", async (t) => {
  const paths = await setup(t);
  const state = createEmptyState();
  state.totalAttempts = 15;
  state.requestHistory = [
    { at: "2026-08-10T02:00:00.000Z", ok: true, minimalReply: true, usage: null },
    { at: "2026-08-10T03:00:00.000Z", ok: true, minimalReply: true, usage: null },
  ];
  await writeJsonAtomic(paths.state, state);
  const progress = [];

  await executeTick({
    paths,
    forceWindows: ["7d"],
    clock: () => START,
    runner: async () => ({ ok: false, error: "offline" }),
    onProgress: (event) => progress.push(event),
  });

  assert.deepEqual(progress.find((event) => event.phase === "sending"), {
    phase: "sending",
    attempt: 3,
    maxAttempts: 5,
  });
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
    ...createAnchoredVerification(() => START),
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

test("window verification treats a reset sliding with wall time as still floating", () => {
  const verification = buildWindowVerification({
    windowNames: ["7d"],
    beforeWindows: [
      { durationMinutes: 10_080, resetsAt: "2026-08-18T13:27:00.000Z", usedPercent: 0 },
    ],
    afterWindows: [
      { durationMinutes: 10_080, resetsAt: "2026-08-18T13:28:00.000Z", usedPercent: 0 },
    ],
    beforeCheckedAt: "2026-08-11T13:27:00.000Z",
    checkedAt: "2026-08-11T13:28:00.000Z",
  });

  assert.deepEqual(verification.windows["7d"], {
    status: "still-floating",
    updated: false,
    beforeResetsAt: "2026-08-18T13:27:00.000Z",
    afterResetsAt: "2026-08-18T13:28:00.000Z",
    changeSeconds: 60,
    observationSeconds: 60,
  });
});

test("window verification treats a fixed reset as anchored", () => {
  const verification = buildWindowVerification({
    windowNames: ["7d"],
    beforeWindows: [
      { durationMinutes: 10_080, resetsAt: "2026-08-18T13:27:00.000Z", usedPercent: 0 },
    ],
    afterWindows: [
      { durationMinutes: 10_080, resetsAt: "2026-08-18T13:27:00.000Z", usedPercent: 0 },
    ],
    beforeCheckedAt: "2026-08-11T13:27:00.000Z",
    checkedAt: "2026-08-11T13:28:00.000Z",
  });

  assert.equal(verification.windows["7d"].status, "anchored");
  assert.equal(verification.windows["7d"].updated, true);
  assert.equal(verification.windows["7d"].changeSeconds, 0);
  assert.equal(verification.windows["7d"].observationSeconds, 60);

  const unavailable = buildWindowVerification({
    windowNames: ["5h"],
    beforeWindows: [],
    afterWindows: [],
    beforeCheckedAt: "2026-08-11T13:27:00.000Z",
    checkedAt: "2026-08-11T13:28:00.000Z",
  });
  assert.equal(unavailable.windows["5h"].status, "unavailable");
  assert.equal(unavailable.windows["5h"].updated, null);
});

test("a successful prompt with a still-floating window fails and keeps the short retry", async (t) => {
  const paths = await setup(t);
  let now = START;
  let reads = 0;
  const result = await executeTick({
    paths,
    forceWindows: ["7d"],
    clock: () => now,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delayMs) => { now += delayMs; },
    runner: async () => ({ ok: true, minimalReply: true }),
    verifier: async () => {
      const fetchedAt = new Date(now).toISOString();
      const resetsAt = new Date(now + 7 * DAY).toISOString();
      reads += 1;
      return {
        fetchedAt,
        windows: [{ durationMinutes: 10_080, resetsAt, usedPercent: 0 }],
      };
    },
  });
  const state = await loadState(paths.state);

  assert.equal(reads, 2);
  assert.equal(result.status, "failed");
  assert.equal(result.verification.windows["7d"].status, "still-floating");
  assert.equal(state.windows["7d"].lastSuccessAt, null);
  assert.equal(state.windows["7d"].nextDueAt, null);
  assert.equal(state.retryAt, "2026-08-11T00:02:00.000Z");
  assert.equal(state.totalSuccesses, 0);
});

test("a manual run retries a floating timer on the short backoff", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  let reads = 0;
  let secondAttemptReset = null;
  const progress = [];
  const result = await executeTickUntilVerified({
    paths,
    forceWindows: ["7d"],
    clock: () => now,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delayMs) => { now += delayMs; },
    retryWaiter: async (delayMs) => { now += delayMs; },
    onProgress: (event) => progress.push(event),
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
    verifier: async () => {
      if (reads === 2) secondAttemptReset = now + 7 * DAY;
      const resetsAt = reads >= 2 ? secondAttemptReset : now + 7 * DAY;
      reads += 1;
      return {
        fetchedAt: new Date(now).toISOString(),
        windows: [{
          durationMinutes: 10_080,
          resetsAt: new Date(resetsAt).toISOString(),
          usedPercent: 0,
        }],
      };
    },
  });

  assert.equal(result.status, "sent");
  assert.equal(sends, 2);
  assert.equal((await loadState(paths.state)).totalAttempts, 2);
  assert.equal((await loadState(paths.state)).totalSuccesses, 1);
  assert.deepEqual(progress.map((event) => event.phase), [
    "checking",
    "sending",
    "verifying",
    "retrying",
    "checking",
    "sending",
    "verifying",
  ]);
  assert.equal(progress[1].attempt, 1);
  assert.equal(progress[3].nextAttempt, 2);
  assert.equal(progress[3].maxAttempts, 5);
  assert.equal(result.elapsedMs, 180_000);
});

test("a manual run stops after five floating-timer attempts", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  const progress = [];

  const result = await executeTickUntilVerified({
    paths,
    forceWindows: ["5h"],
    onlyDueWindows: true,
    ignoreRequestLimit: true,
    maxManualAttempts: 5,
    clock: () => now,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delayMs) => { now += delayMs; },
    retryWaiter: async (delayMs) => { now += delayMs; },
    onProgress: (event) => progress.push(event),
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
    verifier: async () => ({
      fetchedAt: new Date(now).toISOString(),
      windows: [{
        durationMinutes: 300,
        resetsAt: new Date(now + 5 * HOUR).toISOString(),
        usedPercent: 0,
      }],
    }),
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "5h window timer is still floating");
  assert.equal(sends, 5);
  assert.deepEqual(
    progress.filter((event) => event.phase === "sending").map((event) => event.attempt),
    [1, 2, 3, 4, 5],
  );
});

test("a manual run skips a requested window whose timer is already active", async (t) => {
  const paths = await setup(t);
  const state = createEmptyState();
  state.windows["5h"] = {
    lastSuccessAt: new Date(START).toISOString(),
    nextDueAt: new Date(START + 5 * HOUR).toISOString(),
  };
  await writeJsonAtomic(paths.state, state);
  let sends = 0;

  const result = await executeTickUntilVerified({
    paths,
    forceWindows: ["5h"],
    onlyDueWindows: true,
    clock: () => START + HOUR,
    runner: async () => {
      sends += 1;
      return { ok: false, error: "unexpected send" };
    },
  });

  assert.equal(result.status, "not-due");
  assert.deepEqual(result.windows, []);
  assert.equal(sends, 0);
});

test("a manual run sends only requested windows that are due", async (t) => {
  const paths = await setup(t);
  const state = createEmptyState();
  state.windows["5h"] = {
    lastSuccessAt: new Date(START).toISOString(),
    nextDueAt: new Date(START + 5 * HOUR).toISOString(),
  };
  await writeJsonAtomic(paths.state, state);
  let sends = 0;

  const result = await executeTickUntilVerified({
    paths,
    forceWindows: ["5h", "7d"],
    onlyDueWindows: true,
    clock: () => START + HOUR,
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
    ...createAnchoredVerification(() => START + HOUR),
  });

  assert.equal(result.status, "sent");
  assert.deepEqual(result.windows, ["7d"]);
  assert.deepEqual(result.sentWindows, ["7d"]);
  assert.equal(sends, 1);
});

test("pending verification does not swallow the remaining manual windows", async (t) => {
  const paths = await setup(t);
  let now = START + 60_000;
  let sends = 0;
  let reads = 0;
  let sevenDayReset = null;
  const state = createEmptyState();
  state.pendingVerification = {
    windows: ["5h"],
    beforeCheckedAt: new Date(START).toISOString(),
    beforeWindows: [],
    completedAt: new Date(START).toISOString(),
  };
  state.retryAt = new Date(START).toISOString();
  await writeJsonAtomic(paths.state, state);

  const result = await executeTickUntilVerified({
    paths,
    forceWindows: ["5h", "7d"],
    clock: () => now,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delayMs) => { now += delayMs; },
    retryWaiter: async (delayMs) => { now += delayMs; },
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
    verifier: async () => {
      if (reads === 0) {
        reads += 1;
        return { fetchedAt: new Date(now).toISOString(), windows: [] };
      }
      if (sevenDayReset === null) sevenDayReset = now + 7 * DAY;
      reads += 1;
      return {
        fetchedAt: new Date(now).toISOString(),
        windows: [{ durationMinutes: 10_080, resetsAt: new Date(sevenDayReset).toISOString(), usedPercent: 0 }],
      };
    },
  });

  assert.equal(result.status, "partial");
  assert.deepEqual(result.sentWindows, ["7d"]);
  assert.deepEqual(result.unverifiedWindows, ["5h"]);
  assert.equal(sends, 1);
});

test("a manual run waits for a temporary account lock", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  const waits = [];
  const progress = [];
  await fs.mkdir(paths.lock, { recursive: true });

  const result = await executeTickUntilVerified({
    paths,
    forceWindows: ["7d"],
    clock: () => now,
    retryWaiter: async (delayMs) => {
      waits.push(delayMs);
      now += delayMs;
      await fs.rm(paths.lock, { recursive: true, force: true });
    },
    onProgress: (event) => progress.push(event),
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
    ...createAnchoredVerification(() => now, ["7d"]),
  });

  assert.equal(result.status, "sent");
  assert.equal(sends, 1);
  assert.deepEqual(waits, [1_000]);
  assert.deepEqual(progress.filter((event) => event.phase === "lock-wait"), [{
    phase: "lock-wait",
    maxWaitMs: 120_000,
  }]);
});

test("unavailable verification retries metadata without sending another prompt", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;
  let reads = 0;
  const options = {
    paths,
    forceWindows: ["7d"],
    clock: () => now,
    verificationDelayMs: 60_000,
    verificationWaiter: async (delayMs) => { now += delayMs; },
    runner: async () => {
      sends += 1;
      return { ok: true };
    },
    verifier: async () => {
      reads += 1;
      return { fetchedAt: new Date(now).toISOString(), windows: [] };
    },
  };

  const first = await executeTick(options);
  now = Date.parse(first.retryAt);
  const second = await executeTick(options);

  assert.equal(first.status, "verification-pending");
  assert.equal(second.status, "unverified");
  assert.equal(sends, 1);
  assert.equal(reads, 3);
  const state = await loadState(paths.state);
  assert.equal(state.totalAttempts, 1);
  assert.equal(state.totalSuccesses, 0);
  assert.equal(state.pendingVerification, null);
  assert.equal(state.retryAt, null);
  assert.equal(state.windows["7d"].nextDueAt, "2026-08-18T00:00:00.000Z");
});

test("successful ticks log an anchored reset", async (t) => {
  const paths = await setup(t);
  const state = await loadState(paths.state);
  state.rateLimits = {
    lastCheckedAt: "2026-08-10T00:00:00.000Z",
    error: null,
    windows: [{ durationMinutes: 10_080, resetsAt: "2026-08-18T00:00:00.000Z" }],
  };
  await writeJsonAtomic(paths.state, state);

  const result = await executeTick({
    paths,
    clock: () => START,
    runner: async () => ({
      ok: true,
      minimalReply: true,
      usage: { inputTokens: 100, cachedInputTokens: 80, outputTokens: 1, totalTokens: 101 },
    }),
    verificationDelayMs: 0,
    verifier: createAnchoredVerification(() => START).verifier,
  });
  const [entry] = (await fs.readFile(paths.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(result.verification.windows["5h"].status, "anchored");
  assert.equal(result.verification.windows["7d"].status, "anchored");
  assert.equal(entry.requestSucceeded, true);
  assert.equal(entry.minimalReply, true);
  assert.equal(entry.usage.totalTokens, 101);
  assert.equal(entry.verification.windows["7d"].updated, true);
  assert.equal((await loadState(paths.state)).rateLimits.lastCheckedAt, "2026-08-11T00:01:00.000Z");
});

test("a verification read failure leaves the prompt pending instead of claiming success", async (t) => {
  const paths = await setup(t);
  const result = await executeTick({
    paths,
    clock: () => START,
    runner: async () => ({ ok: true }),
    verificationDelayMs: 0,
    verifier: async () => { throw new Error("metadata offline"); },
  });
  const [entry] = (await fs.readFile(paths.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));

  assert.equal(result.status, "verification-pending");
  assert.equal(entry.verification.error, "metadata offline");
  assert.equal(entry.verification.windows["7d"].status, "unavailable");
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

function createAnchoredVerification(clock, windowNames = ["5h", "7d"]) {
  let baseline = null;
  let firstSample = true;
  return {
    verificationDelayMs: 0,
    verifier: async () => {
      if (firstSample) baseline = clock();
      const fetchedAtMs = firstSample ? baseline : baseline + 60_000;
      const windows = windowNames.map((name) => ({
        durationMinutes: name === "5h" ? 300 : 10_080,
        resetsAt: new Date(baseline + (name === "5h" ? 5 * HOUR : 7 * DAY)).toISOString(),
        usedPercent: 0,
      }));
      firstSample = !firstSample;
      return { fetchedAt: new Date(fetchedAtMs).toISOString(), windows };
    },
  };
}
