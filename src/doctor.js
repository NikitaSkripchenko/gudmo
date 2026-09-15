import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runDoctor(config, {
  platform = process.platform,
  accounts = null,
  providers = ["codex"],
  runner = run,
} = {}) {
  const selected = new Set(providers);
  const checks = [
    {
      name: "platform",
      ok: platform === "darwin",
      detail: platform === "darwin" ? "macOS is supported" : `${platform} is unsupported; Gudmo requires macOS`,
    },
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 20,
      detail: `Node ${process.versions.node}`,
    },
  ];

  if (selected.has("claude")) {
    const claudeVersion = await runner(config.claudePath, ["--version"]);
    checks.push({ name: "claude", ok: claudeVersion.ok, detail: claudeVersion.output || claudeVersion.error });

    const usage = claudeVersion.ok
      ? await runner(
        config.claudePath,
        ["--print", "--output-format", "json", "--no-session-persistence", "/usage"],
        { timeoutMs: 30_000 },
      )
      : { ok: false, output: "", error: "Claude Code CLI is unavailable" };
    const subscription = usage.ok && /using your subscription/i.test(usage.output);
    checks.push({
      name: "claude-authentication",
      ok: subscription,
      detail: usage.ok
        ? (subscription
          ? "Connected with a Claude subscription"
          : "Claude Code is not reporting subscription usage; a Claude subscription login is required")
        : usage.error,
    });
  }

  if (!selected.has("codex")) return { ok: checks.every((check) => check.ok), checks };

  const version = await runner(config.codexPath, ["--version"]);
  checks.push({ name: "codex", ok: version.ok, detail: version.output || version.error });

  const isolatedAccounts = accounts?.filter((account) => account.isolated) || [];
  if (isolatedAccounts.length > 0) {
    const snapshotChecks = await Promise.all(isolatedAccounts.map(async (account) => {
      try {
        JSON.parse(await fs.readFile(account.sourceAuthPath, "utf8"));
        return { ok: true, label: account.label };
      } catch (error) {
        return { ok: false, label: account.label, error: error.message };
      }
    }));
    const failures = snapshotChecks.filter((check) => !check.ok);
    checks.push({
      name: "authentication",
      ok: failures.length === 0,
      detail: failures.length === 0
        ? `${snapshotChecks.length} codex-auth account snapshot(s) ready for isolated use`
        : `Invalid snapshots: ${failures.map((failure) => failure.label).join(", ")}`,
    });
  } else {
    const auth = version.ok
      ? await runner(config.codexPath, ["login", "status"])
      : { ok: false, output: "", error: "Codex CLI is unavailable" };
    const chatGptAuth = auth.ok && /logged in using chatgpt/i.test(auth.output);
    checks.push({
      name: "authentication",
      ok: chatGptAuth,
      detail: auth.ok
        ? (chatGptAuth ? "Connected with ChatGPT subscription access" : `${auth.output || "Unknown login method"}; ChatGPT login is required`)
        : auth.error,
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function run(command, args, { timeoutMs = 10_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { ok: true, output: `${stdout}${stderr}`.trim(), error: null };
  } catch (error) {
    return {
      ok: false,
      output: `${error?.stdout || ""}${error?.stderr || ""}`.trim(),
      error: error?.code === "ENOENT" ? `${command} was not found` : (error?.message || String(error)),
    };
  }
}
