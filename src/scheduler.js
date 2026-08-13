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
  return state;
}

export function dueWindows(state, config, nowMs) {
  return config.enabledWindows.filter((name) => {
    const nextDueAt = state.windows[name].nextDueAt;
    return nextDueAt === null || Date.parse(nextDueAt) <= nowMs;
  });
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
} = {}) {
  const release = await acquireLock(paths.lock);
  if (!release) return { status: "locked", windows: [] };

  try {
    const config = await loadConfig(paths.config);
    const state = await loadState(paths.state);
    const beforeRateLimits = state.rateLimits?.windows || [];
    const nowMs = clock();
    const windows = forceWindows || dueWindows(state, config, nowMs);

    if (windows.length === 0) return { status: "not-due", windows: [] };
    if (!forceWindows && state.retryAt && Date.parse(state.retryAt) > nowMs) {
      return { status: "retry-wait", windows, retryAt: state.retryAt };
    }

    state.lastAttemptAt = new Date(nowMs).toISOString();
    state.retryAt = new Date(nowMs + config.retrySeconds * 1_000).toISOString();
    state.totalAttempts += 1;
    await writeJsonAtomic(paths.state, state);

    const result = await runner(config, runnerOptions);
    const completedMs = clock();

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
      return { status: "failed", windows, error: state.lastError, retryAt: state.retryAt };
    }

    const completedAt = new Date(completedMs).toISOString();
    for (const name of windows) {
      state.windows[name] = {
        lastSuccessAt: completedAt,
        nextDueAt: new Date(completedMs + WINDOW_DEFINITIONS[name].durationMs).toISOString(),
      };
    }
    state.lastSuccessAt = completedAt;
    state.retryAt = null;
    state.lastError = null;
    state.nextWakeAt = null;
    state.nextWakeReason = null;
    state.totalSuccesses += 1;
    await writeJsonAtomic(paths.state, state);

    let verification;
    let observedRateLimits = null;
    if (verifier) {
      try {
        observedRateLimits = await verifier(config, verifierOptions);
        state.rateLimits = {
          lastCheckedAt: observedRateLimits.fetchedAt,
          error: null,
          windows: observedRateLimits.windows,
        };
        verification = buildWindowVerification({
          windowNames: windows,
          beforeWindows: beforeRateLimits,
          afterWindows: observedRateLimits.windows,
          checkedAt: observedRateLimits.fetchedAt,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const checkedAt = new Date(clock()).toISOString();
        state.rateLimits = {
          lastCheckedAt: checkedAt,
          error: message,
          windows: beforeRateLimits,
        };
        verification = buildWindowVerification({
          windowNames: windows,
          beforeWindows: beforeRateLimits,
          afterWindows: [],
          checkedAt,
          error: message,
        });
      }
      await writeJsonAtomic(paths.state, state);
    } else {
      verification = buildWindowVerification({
        windowNames: windows,
        beforeWindows: beforeRateLimits,
        afterWindows: [],
        checkedAt: null,
        error: "post-send verification was not requested",
      });
    }

    await appendLog(paths.log, {
      at: completedAt,
      event: "success",
      windows,
      requestSucceeded: true,
      verification,
    });

    return { status: "sent", windows, at: completedAt, verification, rateLimits: observedRateLimits };
  } finally {
    await release();
  }
}

export function buildWindowVerification({
  windowNames,
  beforeWindows = [],
  afterWindows = [],
  checkedAt = null,
  error = null,
}) {
  const windows = {};
  for (const name of windowNames) {
    const expectedMinutes = WINDOW_DEFINITIONS[name].durationMs / 60_000;
    const beforeResetsAt = findReset(beforeWindows, expectedMinutes);
    const afterResetsAt = findReset(afterWindows, expectedMinutes);
    const beforeMs = beforeResetsAt ? Date.parse(beforeResetsAt) : NaN;
    const afterMs = afterResetsAt ? Date.parse(afterResetsAt) : NaN;
    const comparable = Number.isFinite(beforeMs) && Number.isFinite(afterMs);
    const advanced = comparable && afterMs > beforeMs;
    windows[name] = {
      status: comparable ? (advanced ? "advanced" : "unchanged") : "unavailable",
      updated: comparable ? advanced : null,
      beforeResetsAt,
      afterResetsAt,
      changeSeconds: comparable ? Math.round((afterMs - beforeMs) / 1_000) : null,
    };
  }
  return { checkedAt, error, windows };
}

function findReset(windows, durationMinutes) {
  const matching = windows.find((window) => window.durationMinutes === durationMinutes);
  return matching && Number.isFinite(Date.parse(matching.resetsAt)) ? matching.resetsAt : null;
}
