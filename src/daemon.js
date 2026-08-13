import { loadConfig } from "./config.js";
import { discoverAccounts, prepareAccount } from "./accounts.js";
import { runCodex } from "./codex.js";
import { readAccountRateLimits } from "./rate-limits.js";
import { acquireLock, appendLog, writeJsonAtomic } from "./storage.js";
import { executeTick, loadState } from "./scheduler.js";

export function calculateNextSend({ state, serverWindows = [], config, nowMs }) {
  const lastSuccessMs = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : null;
  const capBaseMs = lastSuccessMs ?? nowMs;
  const capAtMs = Math.max(nowMs, capBaseMs + config.maxIntervalSeconds * 1_000);
  const graceMs = config.resetGraceSeconds * 1_000;
  const candidates = serverWindows
    .map((window) => {
      const resetMs = Date.parse(window.resetsAt);
      return { window, resetMs, atMs: resetMs + graceMs };
    })
    .filter(({ resetMs }) => Number.isFinite(resetMs) && (lastSuccessMs === null || resetMs > lastSuccessMs))
    .sort((left, right) => left.atMs - right.atMs);

  let atMs = capAtMs;
  let reason = "five-hour-cap";
  let sourceWindow = null;
  if (candidates.length > 0 && candidates[0].atMs < atMs) {
    atMs = Math.max(nowMs, candidates[0].atMs);
    reason = "server-reset";
    sourceWindow = candidates[0].window;
  }

  const retryMs = state.lastError && state.retryAt ? Date.parse(state.retryAt) : null;
  if (Number.isFinite(retryMs)) {
    atMs = Math.max(nowMs, retryMs);
    reason = "retry-backoff";
    sourceWindow = null;
  }

  return {
    at: new Date(atMs).toISOString(),
    reason,
    sourceWindow,
    observedLastSuccessAt: state.lastSuccessAt,
  };
}

export async function planNextSend({
  paths,
  reader = readAccountRateLimits,
  readerOptions,
  rateLimits: suppliedRateLimits = null,
  clock = Date.now,
} = {}) {
  const config = await loadConfig(paths.config);
  let rateLimits = suppliedRateLimits;
  let rateLimitError = null;
  if (rateLimits === null) {
    try {
      rateLimits = await reader(config, readerOptions);
    } catch (error) {
      rateLimitError = error instanceof Error ? error.message : String(error);
      rateLimits = { fetchedAt: new Date(clock()).toISOString(), windows: [] };
    }
  }

  const release = await acquireLock(paths.lock);
  if (!release) return { status: "locked" };
  try {
    const state = await loadState(paths.state);
    const decision = calculateNextSend({
      state,
      serverWindows: rateLimits.windows,
      config,
      nowMs: clock(),
    });
    state.nextWakeAt = decision.at;
    state.nextWakeReason = decision.reason;
    state.rateLimits = {
      lastCheckedAt: rateLimits.fetchedAt,
      error: rateLimitError,
      windows: rateLimits.windows,
    };
    await writeJsonAtomic(paths.state, state);
    if (rateLimitError) {
      await appendLog(paths.log, {
        at: rateLimits.fetchedAt,
        event: "rate-limit-read-failure",
        error: rateLimitError,
        fallbackAt: decision.at,
      });
    }
    return { status: "planned", ...decision };
  } finally {
    await release();
  }
}

export async function runDaemon({
  paths,
  reader = readAccountRateLimits,
  runner,
  readerOptions,
  runnerOptions,
  clock = Date.now,
  waiter = waitUntil,
  signal,
  maxSends = Infinity,
} = {}) {
  let sends = 0;
  while (!signal?.aborted) {
    const plan = await planNextSend({ paths, reader, readerOptions, clock });
    if (plan.status === "locked") {
      await waiter(new Date(clock() + 1_000).toISOString(), { clock, signal });
      continue;
    }

    await waiter(plan.at, { clock, signal });
    if (signal?.aborted) break;

    const currentState = await loadState(paths.state);
    if (currentState.lastSuccessAt !== plan.observedLastSuccessAt) continue;

    const config = await loadConfig(paths.config);
    const result = await executeTick({
      paths,
      forceWindows: config.enabledWindows,
      clock,
      runner,
      runnerOptions,
      verifier: reader,
      verifierOptions: readerOptions,
    });
    if (result.status === "sent") {
      sends += 1;
      if (sends >= maxSends) return { status: "stopped", sends };
    }
  }
  return { status: "aborted", sends };
}

export async function runAccountsDaemon({
  paths,
  env = process.env,
  accountLoader = discoverAccounts,
  accountPreparer = prepareAccount,
  reader = readAccountRateLimits,
  runner = runCodex,
  clock = Date.now,
  waiter = waitUntil,
  signal,
  maxSends = Infinity,
} = {}) {
  let sends = 0;
  let discoveryAtMs = 0;
  let accounts = new Map();
  const plans = new Map();

  while (!signal?.aborted) {
    const nowMs = clock();
    if (nowMs >= discoveryAtMs) {
      const discovered = await accountLoader({ paths, env });
      const prepared = [];
      for (const account of discovered) prepared.push(await accountPreparer(account));
      accounts = new Map(prepared.map((account) => [account.key, account]));
      for (const key of plans.keys()) {
        if (!accounts.has(key)) plans.delete(key);
      }
      const config = await loadConfig(paths.config);
      discoveryAtMs = nowMs + config.maxIntervalSeconds * 1_000;
    }

    for (const account of accounts.values()) {
      if (plans.has(account.key)) continue;
      const plan = await planNextSend({
        paths: account.paths,
        reader,
        readerOptions: { env: account.codexEnv, account },
        clock,
      });
      plans.set(account.key, plan.status === "locked"
        ? { status: "planned", at: new Date(clock() + 1_000).toISOString(), observedLastSuccessAt: null }
        : plan);
    }

    const nextPlanMs = Math.min(
      ...[...plans.values()].map((plan) => Date.parse(plan.at)).filter(Number.isFinite),
      discoveryAtMs,
    );
    await waiter(new Date(nextPlanMs).toISOString(), { clock, signal });
    if (signal?.aborted) break;
    if (clock() >= discoveryAtMs) {
      continue;
    }

    const dueKeys = [...plans.entries()]
      .filter(([, plan]) => Date.parse(plan.at) <= clock())
      .map(([key]) => key);
    for (const key of dueKeys) {
      const account = accounts.get(key);
      const plan = plans.get(key);
      plans.delete(key);
      if (!account) continue;

      const currentState = await loadState(account.paths.state);
      if (currentState.lastSuccessAt !== plan.observedLastSuccessAt) continue;
      const config = await loadConfig(paths.config);
      const result = await executeTick({
        paths: account.paths,
        forceWindows: config.enabledWindows,
        clock,
        runner,
        runnerOptions: { env: account.codexEnv, account },
        verifier: reader,
        verifierOptions: { env: account.codexEnv, account },
      });
      if (result.status === "sent") {
        sends += 1;
        if (sends >= maxSends) return { status: "stopped", sends };
      }
    }
  }
  return { status: "aborted", sends };
}

export async function waitUntil(timestamp, { clock = Date.now, signal } = {}) {
  const delayMs = Math.max(0, Date.parse(timestamp) - clock());
  if (delayMs === 0 || signal?.aborted) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(finish, delayMs);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
