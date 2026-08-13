import fs from "node:fs/promises";
import { discoverAccounts, prepareAccount } from "./accounts.js";
import { ensureConfig, loadConfig } from "./config.js";
import { WINDOW_DEFINITIONS } from "./constants.js";
import { runSchedulerCycle } from "./cycle.js";
import { planNextSend, runAccountsDaemon } from "./daemon.js";
import { runDoctor } from "./doctor.js";
import {
  getLaunchAgentStatus,
  installLaunchAgent,
  uninstallLaunchAgent,
} from "./launchd.js";
import { getPaths } from "./paths.js";
import { readAccountRateLimits } from "./rate-limits.js";
import { dueWindows, executeTick, loadState } from "./scheduler.js";

const HELP = `gudmo - schedule tiny Codex prompts for usage-window anchoring

Usage:
  gudmo init                 Create the default configuration
  gudmo doctor               Check platform, Codex CLI, and ChatGPT login
  gudmo run [--window NAME]  Send now; NAME is all, 5h, or 7d
  gudmo tick                 Send only when a configured window is due
  gudmo daemon               Run the reset-aware persistent scheduler
  gudmo status [--refresh]   Show or refresh reset times and scheduler state
  gudmo install [--no-start] Install the macOS launch agent
  gudmo uninstall            Stop and remove the macOS launch agent
  gudmo logs [--lines N]     Show recent structured activity
  gudmo help                 Show this help

The default prompt is "gudmo". codex-auth registries are detected automatically;
every account runs in an isolated CODEX_HOME without switching the active account.
Installing starts a caffeinated scheduler unless --no-start is passed.
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
    out("gudmo 0.4.2");
    return 0;
  }
  if (command === "init") {
    rejectUnknown(args, []);
    await ensureConfig(paths.config);
    out(`Configuration ready: ${paths.config}`);
    return 0;
  }

  await ensureConfig(paths.config);

  if (command === "_cycle") {
    rejectUnknown(args, []);
    const result = await runSchedulerCycle({ paths, env });
    out(String(result.delaySeconds));
    return 0;
  }

  if (command === "doctor") {
    rejectUnknown(args, []);
    const accounts = await discoverAccounts({ paths, env });
    const result = await runDoctor(await loadConfig(paths.config), { accounts });
    for (const check of result.checks) out(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    return result.ok ? 0 : 1;
  }

  if (command === "tick") {
    const quiet = args.includes("--quiet");
    rejectUnknown(args.filter((arg) => arg !== "--quiet"), []);
    const accounts = await prepareAccounts(await discoverAccounts({ paths, env }));
    return runForAccounts(accounts, (account) => executeTick({
      paths: account.paths,
      runnerOptions: { env: account.codexEnv, account },
      verifier: readAccountRateLimits,
      verifierOptions: { env: account.codexEnv, account },
    }), out, err, quiet);
  }

  if (command === "daemon") {
    const quiet = args.includes("--quiet");
    rejectUnknown(args.filter((arg) => arg !== "--quiet"), []);
    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      if (!quiet) out("Reset-aware scheduler started; caffeinate is managed by launchd.");
      await runAccountsDaemon({ paths, env, signal: controller.signal });
      return 0;
    } finally {
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
    }
  }

  if (command === "run") {
    const requested = readOption(args, "--window") || "all";
    rejectUnknown(removeOption(args, "--window"), []);
    const config = await loadConfig(paths.config);
    const windows = requested === "all" ? config.enabledWindows : [requested];
    if (windows.some((name) => !WINDOW_DEFINITIONS[name])) {
      throw new Error("--window must be all, 5h, or 7d");
    }
    const accounts = await prepareAccounts(await discoverAccounts({ paths, env }));
    return runForAccounts(accounts, (account) => executeTick({
      paths: account.paths,
      forceWindows: windows,
      runnerOptions: { env: account.codexEnv, account },
      verifier: readAccountRateLimits,
      verifierOptions: { env: account.codexEnv, account },
    }), out, err);
  }

  if (command === "status") {
    const json = args.includes("--json");
    const refresh = args.includes("--refresh");
    rejectUnknown(args.filter((arg) => arg !== "--json" && arg !== "--refresh"), []);
    const accounts = await discoverAccounts({ paths, env });
    if (refresh) {
      await prepareAccounts(accounts);
      for (const account of accounts) {
        await planNextSend({
          paths: account.paths,
          readerOptions: { env: account.codexEnv, account },
        });
      }
    }
    const config = await loadConfig(paths.config);
    const scheduler = await getLaunchAgentStatus(paths);
    const accountStates = [];
    for (const account of accounts) {
      accountStates.push({ account, state: await loadState(account.paths.state) });
    }
    const status = buildStatus({ config, accountStates, scheduler, paths });
    if (json) out(JSON.stringify(status, null, 2));
    else printStatus(status, out);
    return 0;
  }

  if (command === "install") {
    const start = !args.includes("--no-start");
    rejectUnknown(args.filter((arg) => arg !== "--no-start"), []);
    const config = await loadConfig(paths.config);
    const accounts = await discoverAccounts({ paths, env });
    const diagnosis = await runDoctor(config, { accounts });
    if (!diagnosis.ok) {
      for (const check of diagnosis.checks.filter((item) => !item.ok)) err(`FAIL ${check.name}: ${check.detail}`);
      throw new Error("doctor checks failed; fix them before installing");
    }
    const result = await installLaunchAgent({ paths, config, env, start });
    out(`${result.started ? "Installed and started" : "Generated"}: ${result.path}`);
    return 0;
  }

  if (command === "uninstall") {
    rejectUnknown(args, []);
    const result = await uninstallLaunchAgent({ paths, env });
    out(result.removed ? `Removed: ${result.path}` : `Not installed: ${result.path}`);
    return 0;
  }

  if (command === "logs") {
    const requested = readOption(args, "--lines") || "20";
    rejectUnknown(removeOption(args, "--lines"), []);
    const lines = Number.parseInt(requested, 10);
    if (!Number.isInteger(lines) || lines < 1 || lines > 1_000) {
      throw new Error("--lines must be an integer from 1 to 1000");
    }
    const accounts = await discoverAccounts({ paths, env });
    const entries = [];
    for (const account of accounts) {
      const content = await fs.readFile(account.paths.log, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return "";
        throw error;
      });
      for (const line of content.trimEnd().split("\n").filter(Boolean)) {
        try {
          entries.push({ ...JSON.parse(line), account: account.label });
        } catch {
          entries.push({ at: null, account: account.label, event: "unparsed", detail: line });
        }
      }
      entries.sort((left, right) => String(left.at).localeCompare(String(right.at)));
      if (entries.length > lines) entries.splice(0, entries.length - lines);
    }
    out(entries.map((entry) => JSON.stringify(entry)).join("\n") || "No activity yet.");
    return 0;
  }

  throw new Error(`unknown command: ${command}\nRun 'gudmo help' for usage.`);
}

export function buildStatus({ config, accountStates, scheduler, paths, nowMs = Date.now() }) {
  return {
    schedulerConfigured: scheduler.configured,
    schedulerRunning: scheduler.loaded,
    message: config.message,
    enabledWindows: config.enabledWindows,
    accountMode: accountStates.some(({ account }) => account.isolated) ? "codex-auth" : "active",
    accounts: accountStates.map(({ account, state }) => ({
      key: account.key,
      label: account.label,
      email: account.email,
      isolated: account.isolated,
      manualTickDueNow: dueWindows(state, config, nowMs),
      windows: state.windows,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      retryAt: state.retryAt,
      lastError: state.lastError,
      nextWakeAt: state.nextWakeAt ?? null,
      nextWakeReason: state.nextWakeReason ?? null,
      rateLimits: state.rateLimits ?? { lastCheckedAt: null, error: null, windows: [] },
      totalAttempts: state.totalAttempts,
      totalSuccesses: state.totalSuccesses,
    })),
    paths: { config: paths.config, root: paths.root, launchAgent: paths.launchAgent },
  };
}

async function prepareAccounts(accounts) {
  const prepared = [];
  for (const account of accounts) prepared.push(await prepareAccount(account));
  return prepared;
}

async function runForAccounts(accounts, operation, out, err, quiet = false) {
  let exitCode = 0;
  for (const account of accounts) {
    const result = await operation(account);
    const code = printTickResult(result, out, err, quiet, account.label);
    if (code !== 0) exitCode = code;
  }
  return exitCode;
}

function printTickResult(result, out, err, quiet = false, account = null) {
  const names = result.windows.join(" + ");
  const prefix = account ? `${account}: ` : "";
  if (!quiet && result.status === "sent") out(`${prefix}sent prompt for ${names} at ${result.at}`);
  else if (!quiet && result.status === "not-due") out(`${prefix}nothing due.`);
  else if (!quiet && result.status === "retry-wait") out(`${prefix}waiting to retry ${names} at ${result.retryAt}`);
  else if (!quiet && result.status === "locked") out(`${prefix}another gudmo tick is already running.`);
  else if (result.status === "failed") err(`${prefix}send failed for ${names}: ${result.error}`);
  return result.status === "failed" ? 1 : 0;
}

function printStatus(status, out) {
  const scheduler = status.schedulerRunning
    ? "running"
    : (status.schedulerConfigured ? "configured but not loaded" : "not installed");
  out(`Scheduler: ${scheduler}`);
  out(`Prompt: ${JSON.stringify(status.message)}`);
  out(`Accounts: ${status.accounts.length} (${status.accountMode})`);
  for (const account of status.accounts) {
    out(`\n${account.label}${account.email && account.email !== account.label ? ` (${account.email})` : ""}`);
    out(`  Manual tick due: ${account.manualTickDueNow.length ? account.manualTickDueNow.join(", ") : "none"}`);
    for (const name of status.enabledWindows) out(`  ${name}: ${account.windows[name].nextDueAt || "due now"}`);
    out(`  Last success: ${account.lastSuccessAt || "never"}`);
    out(`  Next send: ${account.nextWakeAt || "not planned"}${account.nextWakeReason ? ` (${account.nextWakeReason})` : ""}`);
    if (account.rateLimits.lastCheckedAt) out(`  Server limits checked: ${account.rateLimits.lastCheckedAt}`);
    for (const window of account.rateLimits.windows) {
      const duration = window.durationMinutes ? `${window.durationMinutes}m` : window.kind;
      out(`  Server ${window.limitId}/${duration}: ${window.resetsAt} (${window.usedPercent ?? "?"}% used)`);
    }
    if (account.rateLimits.error) out(`  Server limit read error: ${account.rateLimits.error}`);
    if (account.lastError) out(`  Last error: ${account.lastError}`);
  }
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
