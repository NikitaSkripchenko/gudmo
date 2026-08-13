import { discoverAccounts, prepareAccount } from "./accounts.js";
import { loadConfig } from "./config.js";
import { planNextSend } from "./daemon.js";
import { readAccountRateLimits } from "./rate-limits.js";
import { executeTick, loadState } from "./scheduler.js";
import { runCodex } from "./codex.js";

const LOCK_RETRY_MS = 30 * 1_000;

export async function runSchedulerCycle({
  paths,
  env = process.env,
  accountLoader = discoverAccounts,
  accountPreparer = prepareAccount,
  reader = readAccountRateLimits,
  runner = runCodex,
  clock = Date.now,
} = {}) {
  const config = await loadConfig(paths.config);
  const discovered = await accountLoader({ paths, env });
  let earliestMs = clock() + config.maxIntervalSeconds * 1_000;
  let dueAccounts = 0;

  for (const discoveredAccount of discovered) {
    const account = await accountPreparer(discoveredAccount);
    let state = await loadState(account.paths.state);
    let verifiedRateLimits = null;
    const plannedMs = state.nextWakeAt ? Date.parse(state.nextWakeAt) : null;

    if (Number.isFinite(plannedMs) && plannedMs <= clock()) {
      const result = await executeTick({
        paths: account.paths,
        forceWindows: config.enabledWindows,
        clock,
        runner,
        runnerOptions: { env: account.codexEnv, account },
        verifier: reader,
        verifierOptions: { env: account.codexEnv, account },
      });
      if (result.status === "locked") {
        earliestMs = Math.min(earliestMs, clock() + LOCK_RETRY_MS);
        continue;
      }
      dueAccounts += 1;
      verifiedRateLimits = result.rateLimits || null;
      state = await loadState(account.paths.state);
    }

    const nextMs = state.nextWakeAt ? Date.parse(state.nextWakeAt) : null;
    if (!Number.isFinite(nextMs) || nextMs <= clock()) {
      const plan = await planNextSend({
        paths: account.paths,
        reader,
        readerOptions: { env: account.codexEnv, account },
        rateLimits: verifiedRateLimits,
        clock,
      });
      if (plan.status === "locked") {
        earliestMs = Math.min(earliestMs, clock() + LOCK_RETRY_MS);
      } else {
        earliestMs = Math.min(earliestMs, Date.parse(plan.at));
      }
    } else {
      earliestMs = Math.min(earliestMs, nextMs);
    }
  }

  const delaySeconds = Math.max(1, Math.ceil((earliestMs - clock()) / 1_000));
  return {
    accounts: discovered.length,
    dueAccounts,
    delaySeconds,
    nextWakeAt: new Date(clock() + delaySeconds * 1_000).toISOString(),
  };
}
