import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runDoctor(config, { platform = process.platform, accounts = null } = {}) {
  const checks = [
    {
      name: "platform",
      ok: platform === "darwin",
      detail: platform === "darwin" ? "macOS launchd is supported" : `${platform} can run manually; background install is unsupported`,
    },
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 20,
      detail: `Node ${process.versions.node}`,
    },
  ];

  const caffeinateAvailable = platform !== "darwin"
    ? false
    : await fs.access("/usr/bin/caffeinate").then(() => true).catch(() => false);
  checks.push({
    name: "caffeinate",
    ok: caffeinateAvailable,
    detail: caffeinateAvailable
      ? "/usr/bin/caffeinate is available"
      : "caffeinate is required for the AC-power-aware macOS scheduler",
  });

  const version = await run(config.codexPath, ["--version"]);
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
      ? await run(config.codexPath, ["login", "status"])
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

async function run(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf8",
      timeout: 10_000,
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
