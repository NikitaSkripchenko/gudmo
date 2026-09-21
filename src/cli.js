import { discoverAccounts, prepareAccount } from "./accounts.js";
import { ensureConfig, loadConfig } from "./config.js";
import { VERSION } from "./constants.js";
import { runDoctor } from "./doctor.js";
import { formatTokenEval, readCodexVersion, runTokenEval } from "./eval.js";
import { getPaths } from "./paths.js";
import { getProvider, parseProviderSelection } from "./providers.js";
import { renewFiveHourWindow } from "./scheduler.js";
import { writeJsonAtomic } from "./storage.js";

const HELP = `gudmo - ensure the Codex five-hour usage window is active

Usage:
  gudmo run [--provider codex|claude|all]
                             Check every account; renew inactive 5h timers
  gudmo eval [--runs N] [--tier 1..N|all] [--provider codex|claude]
                             Measure production prompt token usage
  gudmo doctor [--provider codex|claude|all]
                             Check platform, provider CLIs, and login
  gudmo help                 Show this help
  gudmo version              Show the installed version

Every run checks all discovered accounts using isolated credentials.
Active timers are skipped; inactive timers must be verified renewed.
--provider defaults to all; each provider is renewed independently.
`;

export async function main(argv, { env = process.env, out = console.log, err = console.error } = {}) {
  const command = argv[0] || "help";
  const args = argv.slice(1);
  const paths = getPaths(env);

  if (command === "help" || command === "--help" || command === "-h") {
    out(HELP.trimEnd());
    return 0;
  }
  if (command === "--version" || command === "version") {
    out(`gudmo ${VERSION}`);
    return 0;
  }

  await ensureConfig(paths.config);

  if (command === "doctor") {
    const providers = readProviderOption(args, "all");
    rejectUnknown(removeOption(args, "--provider"), []);
    const accounts = await discoverAccounts({ paths, env, providers });
    const result = await runDoctor(await loadConfig(paths.config), { accounts, providers });
    for (const check of result.checks) out(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    return result.ok ? 0 : 1;
  }

  if (command === "eval") {
    const json = args.includes("--json");
    const [providerId] = readProviderOption(args, "codex");
    const provider = getProvider(providerId);
    const requestedRuns = readOption(args, "--runs") || "20";
    const requestedTier = readOption(args, "--tier") || "1";
    const remaining = removeOption(
      removeOption(
        removeOption(args.filter((arg) => arg !== "--json"), "--runs"),
        "--tier",
      ),
      "--provider",
    );
    rejectUnknown(remaining, []);
    const runs = Number.parseInt(requestedRuns, 10);
    if (!Number.isInteger(runs) || String(runs) !== requestedRuns || runs < 1 || runs > 100) {
      throw new Error("--runs must be an integer from 1 to 100");
    }
    const tiers = parseEvalTiers(requestedTier, provider);
    const config = await loadConfig(paths.config);
    const report = await runTokenEval({
      config,
      runs,
      tiers,
      provider,
      codexVersion: await readCodexVersion(config, { env, provider }),
      runnerOptions: { env },
    });
    await writeJsonAtomic(paths.evalReport, report);
    out(json ? JSON.stringify(report, null, 2) : formatTokenEval(report));
    return report.result === "PASS" ? 0 : 1;
  }

  if (command === "run") {
    const providers = readProviderOption(args, "all");
    rejectUnknown(removeOption(args, "--provider"), []);
    const accounts = await discoverAccounts({ paths, env, providers });
    return runForAccountsParallel(accounts, async (discoveredAccount) => {
      const account = await prepareAccount(discoveredAccount);
      const provider = getProvider(account.provider);
      return renewFiveHourWindow({
        paths: account.paths,
        runner: provider.runner,
        runnerOptions: { env: account.providerEnv, account },
        verifier: provider.verifier,
        verifierOptions: { env: account.providerEnv, account },
        tiers: provider.tiers,
        buildPrompt: provider.buildPrompt,
        verify: provider.verify,
        onProgress: (event) => printRunProgress(event, account.label, out),
      });
    }, out, err);
  }

  throw new Error(`unknown command: ${command}\nRun 'gudmo help' for usage.`);
}

export async function runForAccountsParallel(accounts, operation, out, err) {
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      return { account, result: await operation(account), error: null };
    } catch (error) {
      return { account, result: null, error: error instanceof Error ? error.message : String(error) };
    }
  }));

  let exitCode = 0;
  for (const item of results) {
    if (item.error) {
      err(`${item.account.label}: 5h renewal failed: ${item.error}`);
      exitCode = 1;
      continue;
    }
    if (printRenewalResult(item.result, item.account.label, out, err) !== 0) exitCode = 1;
  }
  return exitCode;
}

export function printRunProgress(event, account, write) {
  const prefix = `${account}: `;
  if (event.phase === "lock-wait") {
    write(`${prefix}waiting for an existing renewal (up to ${formatDuration(event.maxWaitMs)})...`);
  } else if (event.phase === "checking") {
    write(`${prefix}checking current 5h window...`);
  } else if (event.phase === "sending") {
    const outputUnit = event.outputWords === 1 ? "word" : "words";
    write(`${prefix}sending tier ${event.tier + 1} prompt (target ${event.outputWords} output ${outputUnit}, attempt ${event.attempt}/${event.maxAttempts})...`);
  } else if (event.phase === "verifying") {
    write(`${prefix}prompt completed; verifying 5h timer for ${formatDuration(event.delayMs)}...`);
  } else if (event.phase === "propagation-wait") {
    write(`${prefix}timer update still propagating; metadata poll ${event.poll}/${event.maxPolls} in ${formatDuration(event.delayMs)}...`);
  } else if (event.phase === "retrying") {
    write(`${prefix}timer not renewed; retrying in ${formatDuration(event.delayMs)} (attempt ${event.nextAttempt}/${event.maxAttempts})...`);
  } else if (event.phase === "metadata-retry") {
    write(`${prefix}5h metadata unavailable; checking again in ${formatDuration(event.delayMs)}...`);
  }
}

function printRenewalResult(result, account, out, err) {
  const elapsed = ` (${formatDuration(result.elapsedMs)})`;
  if (result.status === "active") {
    out(`${account}: 5h timer is already active; no prompt sent${elapsed}`);
    return 0;
  }
  if (result.status === "renewed" && result.reused) {
    out(`${account}: 5h timer was renewed by the concurrent run${elapsed}`);
    return 0;
  }
  if (result.status === "renewed") {
    out(`${account}: renewed 5h timer with tier ${result.tier + 1} in ${formatAttempts(result.attempts)}${elapsed}`);
    return 0;
  }
  const attempts = formatAttempts(result.attempts || 0);
  const label = result.status === "unverified" ? "unverified" : "failed";
  err(`${account}: 5h renewal ${label} after ${attempts}: ${result.error}${elapsed}`);
  return 1;
}

function formatAttempts(attempts) {
  return `${attempts} ${attempts === 1 ? "attempt" : "attempts"}`;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} requires a value`);
  return args[index + 1];
}

function removeOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return [...args];
  return args.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1);
}

function rejectUnknown(args, allowed) {
  const unknown = args.filter((arg) => !allowed.includes(arg));
  if (unknown.length) throw new Error(`unknown option: ${unknown[0]}`);
}

function parseEvalTiers(value, provider) {
  if (value === "all") return provider.tiers.map((_, tier) => tier);
  const tier = Number.parseInt(value, 10);
  if (!Number.isInteger(tier)
    || String(tier) !== value
    || tier < 1
    || tier > provider.tiers.length) {
    throw new Error(`--tier must be an integer from 1 to ${provider.tiers.length} or all`);
  }
  return [tier - 1];
}

function readProviderOption(args, fallback) {
  const requested = readOption(args, "--provider") || fallback;
  return parseProviderSelection(requested);
}
