import crypto from "node:crypto";
import { STATE_VERSION } from "./constants.js";
import { loadConfig } from "./config.js";
import { runCodex } from "./codex.js";
import { buildRenewalPrompt, PROMPT_TIERS } from "./prompt.js";
import { readAccountRateLimits } from "./rate-limits.js";
import { acquireLock, readJson, writeJsonAtomic } from "./storage.js";

export function createEmptyState() {
  return {
    version: STATE_VERSION,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastResult: null,
    totalAttempts: 0,
    totalSuccesses: 0,
  };
}

export async function loadState(statePath) {
  const input = await readJson(statePath, createEmptyState());
  const state = input.version === 1
    ? {
        ...createEmptyState(),
        lastAttemptAt: input.lastAttemptAt ?? null,
        lastSuccessAt: input.lastSuccessAt ?? null,
        lastError: input.lastError ?? null,
        totalAttempts: Number.isInteger(input.totalAttempts) ? input.totalAttempts : 0,
        totalSuccesses: Number.isInteger(input.totalSuccesses) ? input.totalSuccesses : 0,
      }
    : input;
  if (state.version !== STATE_VERSION) throw new Error(`Unsupported state file: ${statePath}`);
  validateTimestamp(state.lastAttemptAt, "lastAttemptAt", statePath);
  validateTimestamp(state.lastSuccessAt, "lastSuccessAt", statePath);
  validateTimestamp(state.lastResult?.completedAt ?? null, "lastResult.completedAt", statePath);
  return { ...createEmptyState(), ...state };
}

export function buildFiveHourVerification({
  beforeWindows = [],
  afterWindows = [],
  beforeCheckedAt = null,
  checkedAt = null,
  error = null,
} = {}) {
  const beforeWindow = findFiveHourWindow(beforeWindows);
  const afterWindow = findFiveHourWindow(afterWindows);
  const beforeResetsAt = beforeWindow?.resetsAt ?? null;
  const afterResetsAt = afterWindow?.resetsAt ?? null;
  const beforeMs = Date.parse(beforeResetsAt);
  const afterMs = Date.parse(afterResetsAt);
  const observationMs = Date.parse(checkedAt) - Date.parse(beforeCheckedAt);
  const observationSeconds = Number.isFinite(observationMs) && observationMs > 0
    ? Math.round(observationMs / 1_000)
    : null;
  const comparable = Number.isFinite(beforeMs)
    && Number.isFinite(afterMs)
    && Number.isFinite(observationSeconds);
  const changeSeconds = comparable ? Math.round((afterMs - beforeMs) / 1_000) : null;
  const usageIncreased = comparable
    && Number.isFinite(beforeWindow?.usedPercent)
    && Number.isFinite(afterWindow?.usedPercent)
    && afterWindow.usedPercent > beforeWindow.usedPercent;
  const toleranceSeconds = comparable ? Math.max(5, Math.round(observationSeconds * 0.2)) : null;
  const stillFloating = comparable
    && !usageIncreased
    && Math.abs(changeSeconds - observationSeconds) <= toleranceSeconds;

  return {
    status: comparable ? (stillFloating ? "still-floating" : "renewed") : "unavailable",
    beforeResetsAt,
    afterResetsAt,
    changeSeconds,
    observationSeconds,
    error,
  };
}

export async function renewFiveHourWindow({
  paths,
  runner = runCodex,
  verifier = readAccountRateLimits,
  runnerOptions,
  verifierOptions,
  clock = Date.now,
  nonceFactory = crypto.randomUUID,
  verificationDelayMs = 60_000,
  verificationWaiter = waitFor,
  retryWaiter = waitFor,
  lockRetryMs = 1_000,
  maxLockWaitMs = 120_000,
  onProgress = null,
} = {}) {
  const startedAtMs = clock();
  let lockWaitedMs = 0;
  let lastResult = null;

  for (let tier = 0; tier < PROMPT_TIERS.length; tier += 1) {
    let release = await acquireLock(paths.lock);
    while (!release) {
      if (lockWaitedMs >= maxLockWaitMs) {
        return withElapsed({
          status: "locked",
          attempts: lastResult?.attempts ?? 0,
          tier: lastResult?.tier ?? tier,
          error: "another renewal is still running",
          verification: lastResult?.verification ?? null,
        }, startedAtMs, clock);
      }
      if (lockWaitedMs === 0) onProgress?.({ phase: "lock-wait", maxWaitMs: maxLockWaitMs });
      const delayMs = Math.min(lockRetryMs, maxLockWaitMs - lockWaitedMs);
      await retryWaiter(delayMs);
      lockWaitedMs += delayMs;
      const concurrent = await loadState(paths.state);
      if (Date.parse(concurrent.lastSuccessAt) >= startedAtMs) {
        return withElapsed({
          status: "renewed",
          attempts: 0,
          tier: concurrent.lastResult?.tier ?? tier,
          reused: true,
          verification: concurrent.lastResult?.verification ?? null,
        }, startedAtMs, clock);
      }
      release = await acquireLock(paths.lock);
    }

    try {
      const config = await loadConfig(paths.config);
      const attempt = tier + 1;
      const prompt = buildRenewalPrompt({ tier, nonce: nonceFactory() });
      onProgress?.({ phase: "checking", attempt, tier });
      const before = await readSnapshot(verifier, config, verifierOptions, clock);
      const state = await loadState(paths.state);
      state.lastAttemptAt = new Date(clock()).toISOString();
      state.totalAttempts += 1;
      await writeJsonAtomic(paths.state, state);

      onProgress?.({
        phase: "sending",
        attempt,
        maxAttempts: PROMPT_TIERS.length,
        tier,
        outputWords: prompt.outputWords,
      });
      const codexResult = await runner({
        ...config,
        message: prompt.message,
        reasoningEffort: prompt.reasoningEffort,
      }, runnerOptions);
      if (!codexResult.ok) {
        lastResult = {
          status: "failed",
          attempts: attempt,
          tier,
          error: codexResult.error || "Codex request failed",
          verification: null,
        };
        await persistResult(paths.state, state, lastResult, clock());
      } else {
        onProgress?.({ phase: "verifying", attempt, tier, delayMs: verificationDelayMs });
        await verificationWaiter(verificationDelayMs);
        let after = await readSnapshot(verifier, config, verifierOptions, clock);
        let verification = buildFiveHourVerification({
          beforeWindows: before.windows,
          afterWindows: after.windows,
          beforeCheckedAt: before.fetchedAt,
          checkedAt: after.fetchedAt,
          error: before.error || after.error,
        });

        if (verification.status === "unavailable") {
          onProgress?.({ phase: "metadata-retry", attempt, tier, delayMs: config.retrySeconds * 1_000 });
          await retryWaiter(config.retrySeconds * 1_000);
          after = await readSnapshot(verifier, config, verifierOptions, clock);
          verification = buildFiveHourVerification({
            beforeWindows: before.windows,
            afterWindows: after.windows,
            beforeCheckedAt: before.fetchedAt,
            checkedAt: after.fetchedAt,
            error: before.error || after.error,
          });
        }

        lastResult = {
          status: verification.status === "renewed"
            ? "renewed"
            : (verification.status === "unavailable" ? "unverified" : "failed"),
          attempts: attempt,
          tier,
          outputWords: prompt.outputWords,
          reasoningEffort: prompt.reasoningEffort,
          error: verification.status === "still-floating"
            ? "5h window timer is still floating"
            : (verification.status === "unavailable" ? "5h window verification is unavailable" : null),
          verification,
        };
        await persistResult(paths.state, state, lastResult, clock(), codexResult);
        if (lastResult.status === "renewed") return withElapsed(lastResult, startedAtMs, clock);
        if (lastResult.status === "unverified") return withElapsed(lastResult, startedAtMs, clock);
      }
    } finally {
      await release();
    }

    if (tier < PROMPT_TIERS.length - 1) {
      const config = await loadConfig(paths.config);
      onProgress?.({ phase: "retrying", nextAttempt: tier + 2, maxAttempts: PROMPT_TIERS.length, delayMs: config.retrySeconds * 1_000 });
      await retryWaiter(config.retrySeconds * 1_000);
    }
  }

  return withElapsed(lastResult, startedAtMs, clock);
}

async function persistResult(statePath, state, result, completedMs, codexResult = null) {
  const completedAt = new Date(completedMs).toISOString();
  state.lastResult = {
    ...result,
    completedAt,
    usage: codexResult?.usage ?? null,
    minimalReply: codexResult?.minimalReply ?? null,
  };
  state.lastError = result.error;
  if (result.status === "renewed") {
    state.lastSuccessAt = completedAt;
    state.lastError = null;
    state.totalSuccesses += 1;
  }
  await writeJsonAtomic(statePath, state);
}

async function readSnapshot(verifier, config, verifierOptions, clock) {
  try {
    return { ...(await verifier(config, verifierOptions)), error: null };
  } catch (error) {
    return {
      fetchedAt: new Date(clock()).toISOString(),
      windows: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function findFiveHourWindow(windows) {
  const match = windows.find((window) => window.durationMinutes === 300);
  return match && Number.isFinite(Date.parse(match.resetsAt)) ? match : null;
}

function validateTimestamp(value, field, statePath) {
  if (value !== null && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) {
    throw new Error(`Invalid ${field} timestamp in state file: ${statePath}`);
  }
}

function withElapsed(result, startedAtMs, clock) {
  return { ...result, elapsedMs: Math.max(0, clock() - startedAtMs) };
}

async function waitFor(delayMs) {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
}
