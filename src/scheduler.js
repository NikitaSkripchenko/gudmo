import { STATE_VERSION, WINDOW_DEFINITIONS } from "./constants.js";
import { loadConfig } from "./config.js";
import { runCodex } from "./codex.js";
import { acquireLock, appendLog, readJson, writeJsonAtomic } from "./storage.js";

export function createEmptyState() {
  return {
    version: STATE_VERSION,
    windows: {
      "5h": { lastSuccessAt: null, nextDueAt: null },
      "7d": { lastSuccessAt: null, nextDueAt: null },
    },
    lastAttemptAt: null,
    lastSuccessAt: null,
    retryAt: null,
    lastError: null,
    nextWakeAt: null,
    nextWakeReason: null,
    rateLimits: {
      lastCheckedAt: null,
      error: null,
      windows: [],
    },
    requestHistory: [],
    requestLimitRetryAt: null,
    pendingVerification: null,
    totalAttempts: 0,
    totalSuccesses: 0,
  };
}

export async function loadState(statePath) {
  const state = await readJson(statePath, createEmptyState());
  if (state.version !== STATE_VERSION || !state.windows?.["5h"] || !state.windows?.["7d"]) {
    throw new Error(`Unsupported or invalid state file: ${statePath}`);
  }
  for (const name of Object.keys(WINDOW_DEFINITIONS)) {
    validateTimestamp(state.windows[name].lastSuccessAt, `${name}.lastSuccessAt`, statePath);
    validateTimestamp(state.windows[name].nextDueAt, `${name}.nextDueAt`, statePath);
  }
  validateTimestamp(state.retryAt, "retryAt", statePath);
  validateTimestamp(state.nextWakeAt ?? null, "nextWakeAt", statePath);
  validateTimestamp(state.rateLimits?.lastCheckedAt ?? null, "rateLimits.lastCheckedAt", statePath);
  validateTimestamp(state.requestLimitRetryAt ?? null, "requestLimitRetryAt", statePath);
  validateTimestamp(state.pendingVerification?.beforeCheckedAt ?? null, "pendingVerification.beforeCheckedAt", statePath);
  validateTimestamp(state.pendingVerification?.completedAt ?? null, "pendingVerification.completedAt", statePath);
  if (!Array.isArray(state.requestHistory)) state.requestHistory = [];
  for (const request of state.requestHistory) {
    validateTimestamp(request.at, "requestHistory.at", statePath);
  }
  return state;
}

export function dueWindows(state, config, nowMs) {
  return config.enabledWindows.filter((name) => {
    const nextDueAt = state.windows[name].nextDueAt;
    return nextDueAt === null || Date.parse(nextDueAt) <= nowMs;
  });
}

export async function executeTickUntilVerified({
  retryWaiter = waitFor,
  lockRetryMs = 1_000,
  maxLockWaitMs = 120_000,
  maxManualAttempts = 5,
  onProgress = null,
  ...options
} = {}) {
  const startedAtMs = (options.clock || Date.now)();
  let requestedWindows = options.forceWindows ? [...options.forceWindows] : null;
  if (requestedWindows && options.onlyDueWindows) {
    requestedWindows = dueWindows(
      await loadState(options.paths.state),
      { enabledWindows: requestedWindows },
      startedAtMs,
    );
  }
  if (requestedWindows?.length === 0) {
    return withElapsed({ status: "not-due", windows: [] }, startedAtMs, options.clock);
  }
  let remainingWindows = requestedWindows ? [...requestedWindows] : null;
  const sentWindows = new Set();
  const reusedWindows = new Set();
  const unverifiedWindows = new Set();
  let lockWaitedMs = 0;
  let waitedForLock = false;
  let lastResult = null;
  let manualAttempts = 0;

  while (true) {
    if (waitedForLock && remainingWindows) {
      const state = await loadState(options.paths.state);
      for (const name of [...remainingWindows]) {
        const lastSuccessMs = Date.parse(state.windows[name].lastSuccessAt);
        if (Number.isFinite(lastSuccessMs) && lastSuccessMs >= startedAtMs) {
          reusedWindows.add(name);
          remainingWindows = remainingWindows.filter((windowName) => windowName !== name);
        }
      }
      waitedForLock = false;
      if (remainingWindows.length === 0) {
        return withElapsed(buildManualRunResult({
          requestedWindows,
          sentWindows,
          reusedWindows,
          unverifiedWindows,
          lastResult,
        }), startedAtMs, options.clock);
      }
    }

    const result = await executeTick({
      ...options,
      onProgress,
      forceWindows: remainingWindows || options.forceWindows,
      attemptNumber: options.ignoreRequestLimit ? manualAttempts + 1 : null,
      maxAttemptsOverride: options.ignoreRequestLimit ? maxManualAttempts : null,
    });
    lastResult = result;
    if (options.ignoreRequestLimit && Number.isInteger(result.attempt)) manualAttempts += 1;

    if (result.status === "locked") {
      if (lockWaitedMs >= maxLockWaitMs) return withElapsed(result, startedAtMs, options.clock);
      if (lockWaitedMs === 0) onProgress?.({ phase: "lock-wait", maxWaitMs: maxLockWaitMs });
      const delayMs = Math.min(lockRetryMs, maxLockWaitMs - lockWaitedMs);
      lockWaitedMs += delayMs;
      waitedForLock = true;
      await retryWaiter(delayMs);
      continue;
    }

    if (result.status === "retry-wait" && result.retryAt) {
      const nowMs = (options.clock || Date.now)();
      const delayMs = Math.max(0, Date.parse(result.retryAt) - nowMs);
      onProgress?.({ phase: "metadata-retry", delayMs });
      await retryWaiter(delayMs);
      continue;
    }

    const retryableVerification = result.status === "verification-pending"
      || (result.status === "failed" && result.verification);
    if (retryableVerification && result.retryAt) {
      if (options.ignoreRequestLimit && manualAttempts >= maxManualAttempts) {
        return withElapsed({ ...result, retryAt: null }, startedAtMs, options.clock);
      }
      const nowMs = (options.clock || Date.now)();
      const delayMs = Math.max(0, Date.parse(result.retryAt) - nowMs);
      if (result.status === "failed") {
        onProgress?.({
          phase: "retrying",
          delayMs,
          nextAttempt: (result.attempt || 1) + 1,
          maxAttempts: result.maxAttempts,
        });
      } else {
        onProgress?.({ phase: "metadata-retry", delayMs });
      }
      await retryWaiter(delayMs);
      continue;
    }

    if (result.status === "sent" || result.status === "unverified") {
      const destination = result.status === "sent"
        ? (result.verificationOnly ? reusedWindows : sentWindows)
        : unverifiedWindows;
      for (const name of result.windows) destination.add(name);
      for (const name of result.skippedWindows || []) reusedWindows.add(name);
      if (remainingWindows) {
        const completedWindows = new Set([...result.windows, ...(result.skippedWindows || [])]);
        remainingWindows = remainingWindows.filter((name) => !completedWindows.has(name));
        if (remainingWindows.length > 0) continue;
      }
      return withElapsed(buildManualRunResult({
        requestedWindows,
        sentWindows,
        reusedWindows,
        unverifiedWindows,
        lastResult: result,
      }), startedAtMs, options.clock);
    }

    return withElapsed(result, startedAtMs, options.clock);
  }
}

function withElapsed(result, startedAtMs, clock) {
  return { ...result, elapsedMs: Math.max(0, (clock || Date.now)() - startedAtMs) };
}

function buildManualRunResult({
  requestedWindows,
  sentWindows,
  reusedWindows,
  unverifiedWindows,
  lastResult,
}) {
  const sent = [...sentWindows];
  const reused = [...reusedWindows];
  const unverified = [...unverifiedWindows];
  const windows = requestedWindows || lastResult?.windows || [];
  let status = "sent";
  if (unverified.length > 0 && (sent.length > 0 || reused.length > 0)) status = "partial";
  else if (unverified.length > 0) status = "unverified";
  else if (sent.length === 0 && reused.length > 0) status = "satisfied";
  return {
    ...(lastResult || {}),
    status,
    windows,
    sentWindows: sent,
    reusedWindows: reused,
    unverifiedWindows: unverified,
  };
}

function validateTimestamp(value, field, statePath) {
  if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    throw new Error(`Invalid ${field} timestamp in state file: ${statePath}`);
  }
}

export async function executeTick({
  paths,
  forceWindows = null,
  clock = Date.now,
  runner = runCodex,
  runnerOptions,
  verifier = null,
  verifierOptions,
  verificationDelayMs = 60_000,
  verificationWaiter = waitFor,
  onProgress = null,
  onlyDueWindows = false,
  ignoreRequestLimit = false,
  attemptNumber = null,
  maxAttemptsOverride = null,
} = {}) {
  const release = await acquireLock(paths.lock);
  if (!release) return { status: "locked", windows: [] };

  try {
    const config = await loadConfig(paths.config);
    const state = await loadState(paths.state);
    const nowMs = clock();
    const requestedWindows = forceWindows || dueWindows(state, config, nowMs);
    const windows = forceWindows && onlyDueWindows
      ? dueWindows(state, { enabledWindows: forceWindows }, nowMs)
      : requestedWindows;
    const skippedWindows = requestedWindows.filter((name) => !windows.includes(name));

    if (windows.length === 0) return { status: "not-due", windows: [], skippedWindows };
    if (state.pendingVerification) {
      if (state.retryAt && Date.parse(state.retryAt) > nowMs) {
        return {
          status: "retry-wait",
          windows: state.pendingVerification.windows,
          retryAt: state.retryAt,
        };
      }
      onProgress?.({ phase: "checking-previous" });
      return verifyPendingWindow({
        state,
        paths,
        config,
        clock,
        verifier,
        verifierOptions,
      });
    }
    if (!forceWindows && state.retryAt && Date.parse(state.retryAt) > nowMs) {
      return { status: "retry-wait", windows, retryAt: state.retryAt };
    }

    const cutoffMs = nowMs - 24 * 60 * 60 * 1_000;
    state.requestHistory = state.requestHistory.filter((request) => Date.parse(request.at) > cutoffMs);
    if (!ignoreRequestLimit && state.requestHistory.length >= config.maxRequestsPer24Hours) {
      const retryAt = new Date(Date.parse(state.requestHistory[0].at) + 24 * 60 * 60 * 1_000).toISOString();
      state.requestLimitRetryAt = retryAt;
      await writeJsonAtomic(paths.state, state);
      return { status: "daily-limit", windows, retryAt };
    }
    state.requestLimitRetryAt = null;

    onProgress?.({ phase: "checking" });
    const beforeRateLimits = await readVerificationSnapshot({
      verifier,
      config,
      verifierOptions,
      clock,
      missingMessage: "pre-send verification was not requested",
    });

    state.lastAttemptAt = new Date(nowMs).toISOString();
    state.retryAt = new Date(nowMs + config.retrySeconds * 1_000).toISOString();
    state.totalAttempts += 1;
    state.requestHistory.push({
      at: state.lastAttemptAt,
      ok: null,
      minimalReply: null,
      usage: null,
    });
    if (state.requestHistory.length >= config.maxRequestsPer24Hours) {
      state.requestLimitRetryAt = new Date(
        Date.parse(state.requestHistory[0].at) + 24 * 60 * 60 * 1_000,
      ).toISOString();
    }
    await writeJsonAtomic(paths.state, state);

    const attempt = attemptNumber ?? state.requestHistory.length;
    const maxAttempts = maxAttemptsOverride ?? config.maxRequestsPer24Hours;
    onProgress?.({ phase: "sending", attempt, maxAttempts });
    const result = await runner(config, runnerOptions);
    const completedMs = clock();
    const request = state.requestHistory.at(-1);
    request.ok = result.ok;
    request.minimalReply = result.minimalReply ?? null;
    request.usage = result.usage ?? null;

    if (!result.ok) {
      state.lastError = result.error || "Unknown Codex failure";
      state.retryAt = new Date(completedMs + config.retrySeconds * 1_000).toISOString();
      await writeJsonAtomic(paths.state, state);
      await appendLog(paths.log, {
        at: new Date(completedMs).toISOString(),
        event: "failure",
        windows,
        error: state.lastError,
      });
      return {
        status: "failed",
        windows,
        error: state.lastError,
        retryAt: state.retryAt,
        attempt,
        maxAttempts,
      };
    }

    const completedAt = new Date(completedMs).toISOString();
    onProgress?.({ phase: "verifying", delayMs: verificationDelayMs, attempt, maxAttempts });
    await verificationWaiter(verificationDelayMs);
    const observedRateLimits = await readVerificationSnapshot({
      verifier,
      config,
      verifierOptions,
      clock,
      missingMessage: "post-send verification was not requested",
    });
    const verification = buildWindowVerification({
      windowNames: windows,
      beforeWindows: beforeRateLimits.windows,
      afterWindows: observedRateLimits.windows,
      beforeCheckedAt: beforeRateLimits.fetchedAt,
      checkedAt: observedRateLimits.fetchedAt,
      error: beforeRateLimits.error || observedRateLimits.error,
    });
    state.rateLimits = {
      lastCheckedAt: observedRateLimits.fetchedAt,
      error: observedRateLimits.error,
      windows: observedRateLimits.windows,
    };

    const failedWindows = windows.filter((name) => verification.windows[name].status === "still-floating");
    const unavailableWindows = windows.filter((name) => verification.windows[name].status === "unavailable");
    if (failedWindows.length > 0 || unavailableWindows.length > 0) {
      const detail = failedWindows.length > 0
        ? `${failedWindows.join(", ")} window timer is still floating`
        : `${unavailableWindows.join(", ")} window verification is unavailable`;
      state.lastError = detail;
      state.retryAt = new Date(clock() + config.retrySeconds * 1_000).toISOString();
      request.windowVerified = false;
      const anchoredWindows = windows.filter((name) => verification.windows[name].status === "anchored");
      applyVerifiedWindows(state, anchoredWindows, verification, clock());
      state.pendingVerification = unavailableWindows.length > 0 && failedWindows.length === 0
        ? {
            windows: unavailableWindows,
            beforeCheckedAt: beforeRateLimits.fetchedAt,
            beforeWindows: beforeRateLimits.windows,
            completedAt,
          }
        : null;
      await writeJsonAtomic(paths.state, state);
      await appendLog(paths.log, {
        at: new Date(clock()).toISOString(),
        event: failedWindows.length > 0 ? "verification-failure" : "verification-pending",
        windows,
        requestSucceeded: true,
        error: detail,
        verification,
      });
      return {
        status: failedWindows.length > 0 ? "failed" : "verification-pending",
        windows,
        error: detail,
        retryAt: state.retryAt,
        verification,
        rateLimits: observedRateLimits,
        attempt,
        maxAttempts,
      };
    }

    const verifiedAt = new Date(clock()).toISOString();
    applyVerifiedWindows(state, windows, verification, clock());
    state.lastSuccessAt = verifiedAt;
    state.retryAt = null;
    state.lastError = null;
    state.nextWakeAt = null;
    state.nextWakeReason = null;
    state.totalSuccesses += 1;
    state.pendingVerification = null;
    request.windowVerified = true;
    await writeJsonAtomic(paths.state, state);

    await appendLog(paths.log, {
      at: completedAt,
      event: "success",
      windows,
      requestSucceeded: true,
      minimalReply: result.minimalReply ?? null,
      usage: result.usage ?? null,
      verification,
    });

    return {
      status: "sent",
      windows,
      skippedWindows,
      at: completedAt,
      verification,
      rateLimits: observedRateLimits,
      attempt,
      maxAttempts,
    };
  } finally {
    await release();
  }
}

export function buildWindowVerification({
  windowNames,
  beforeWindows = [],
  afterWindows = [],
  beforeCheckedAt = null,
  checkedAt = null,
  error = null,
}) {
  const windows = {};
  const observationMs = Date.parse(checkedAt) - Date.parse(beforeCheckedAt);
  const observationSeconds = Number.isFinite(observationMs)
    ? Math.max(0, Math.round(observationMs / 1_000))
    : null;
  for (const name of windowNames) {
    const expectedMinutes = WINDOW_DEFINITIONS[name].durationMs / 60_000;
    const beforeWindow = findWindow(beforeWindows, expectedMinutes);
    const afterWindow = findWindow(afterWindows, expectedMinutes);
    const beforeResetsAt = beforeWindow?.resetsAt ?? null;
    const afterResetsAt = afterWindow?.resetsAt ?? null;
    const beforeMs = beforeResetsAt ? Date.parse(beforeResetsAt) : NaN;
    const afterMs = afterResetsAt ? Date.parse(afterResetsAt) : NaN;
    const comparable = Number.isFinite(beforeMs)
      && Number.isFinite(afterMs)
      && Number.isFinite(observationSeconds)
      && observationSeconds > 0;
    const changeSeconds = comparable ? Math.round((afterMs - beforeMs) / 1_000) : null;
    const usedIncreased = comparable
      && Number.isFinite(beforeWindow?.usedPercent)
      && Number.isFinite(afterWindow?.usedPercent)
      && afterWindow.usedPercent > beforeWindow.usedPercent;
    const driftToleranceSeconds = comparable ? Math.max(5, Math.round(observationSeconds * 0.2)) : null;
    const stillFloating = comparable
      && !usedIncreased
      && Math.abs(changeSeconds - observationSeconds) <= driftToleranceSeconds;
    windows[name] = {
      status: comparable ? (stillFloating ? "still-floating" : "anchored") : "unavailable",
      updated: comparable ? !stillFloating : null,
      beforeResetsAt,
      afterResetsAt,
      changeSeconds,
      observationSeconds,
    };
  }
  return { checkedAt, error, windows };
}

function findWindow(windows, durationMinutes) {
  const matching = windows.find((window) => window.durationMinutes === durationMinutes);
  return matching && Number.isFinite(Date.parse(matching.resetsAt)) ? matching : null;
}

async function readVerificationSnapshot({ verifier, config, verifierOptions, clock, missingMessage }) {
  if (!verifier) {
    return {
      fetchedAt: new Date(clock()).toISOString(),
      windows: [],
      error: missingMessage,
    };
  }
  try {
    const snapshot = await verifier(config, verifierOptions);
    return { ...snapshot, error: null };
  } catch (error) {
    return {
      fetchedAt: new Date(clock()).toISOString(),
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function verifyPendingWindow({ state, paths, config, clock, verifier, verifierOptions }) {
  const pending = state.pendingVerification;
  const observedRateLimits = await readVerificationSnapshot({
    verifier,
    config,
    verifierOptions,
    clock,
    missingMessage: "pending verification was not requested",
  });
  const verification = buildWindowVerification({
    windowNames: pending.windows,
    beforeWindows: pending.beforeWindows,
    afterWindows: observedRateLimits.windows,
    beforeCheckedAt: pending.beforeCheckedAt,
    checkedAt: observedRateLimits.fetchedAt,
    error: observedRateLimits.error,
  });
  state.rateLimits = {
    lastCheckedAt: observedRateLimits.fetchedAt,
    error: observedRateLimits.error,
    windows: observedRateLimits.windows,
  };
  const unavailableWindows = pending.windows.filter(
    (name) => verification.windows[name].status === "unavailable",
  );
  const failedWindows = pending.windows.filter(
    (name) => verification.windows[name].status === "still-floating",
  );

  if (unavailableWindows.length > 0) {
    const completedMs = Date.parse(pending.completedAt);
    for (const name of unavailableWindows) {
      state.windows[name] = {
        ...state.windows[name],
        nextDueAt: Number.isFinite(completedMs)
          ? new Date(completedMs + WINDOW_DEFINITIONS[name].durationMs).toISOString()
          : state.windows[name].nextDueAt,
      };
    }
    state.pendingVerification = null;
    state.lastError = `${unavailableWindows.join(", ")} window verification is unavailable`;
    state.retryAt = null;
    await writeJsonAtomic(paths.state, state);
    await appendLog(paths.log, {
      at: new Date(clock()).toISOString(),
      event: "verification-unavailable",
      windows: pending.windows,
      requestSucceeded: true,
      error: state.lastError,
      verification,
    });
    return {
      status: "unverified",
      windows: pending.windows,
      error: state.lastError,
      retryAt: null,
      verification,
      rateLimits: observedRateLimits,
      verificationOnly: true,
    };
  }

  if (failedWindows.length > 0) {
    state.pendingVerification = null;
    state.lastError = `${failedWindows.join(", ")} window timer is still floating`;
    state.retryAt = new Date(clock() + config.retrySeconds * 1_000).toISOString();
    await writeJsonAtomic(paths.state, state);
    await appendLog(paths.log, {
      at: new Date(clock()).toISOString(),
      event: "verification-failure",
      windows: pending.windows,
      requestSucceeded: true,
      error: state.lastError,
      verification,
    });
    return {
      status: "failed",
      windows: pending.windows,
      error: state.lastError,
      retryAt: state.retryAt,
      verification,
      rateLimits: observedRateLimits,
      verificationOnly: true,
    };
  }

  const verifiedAtMs = clock();
  applyVerifiedWindows(state, pending.windows, verification, verifiedAtMs);
  state.pendingVerification = null;
  state.lastSuccessAt = new Date(verifiedAtMs).toISOString();
  state.retryAt = null;
  state.lastError = null;
  state.nextWakeAt = null;
  state.nextWakeReason = null;
  state.totalSuccesses += 1;
  const request = state.requestHistory.at(-1);
  if (request) request.windowVerified = true;
  await writeJsonAtomic(paths.state, state);
  await appendLog(paths.log, {
    at: state.lastSuccessAt,
    event: "success",
    windows: pending.windows,
    requestSucceeded: true,
    verification,
  });
  return {
    status: "sent",
    windows: pending.windows,
    at: state.lastSuccessAt,
    verification,
    rateLimits: observedRateLimits,
    verificationOnly: true,
  };
}

function applyVerifiedWindows(state, windowNames, verification, verifiedAtMs) {
  const verifiedAt = new Date(verifiedAtMs).toISOString();
  for (const name of windowNames) {
    state.windows[name] = {
      lastSuccessAt: verifiedAt,
      nextDueAt: verification.windows[name].afterResetsAt
        || new Date(verifiedAtMs + WINDOW_DEFINITIONS[name].durationMs).toISOString(),
    };
  }
}

async function waitFor(delayMs) {
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
