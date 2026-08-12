import { spawn } from "node:child_process";
import os from "node:os";

const MAX_CAPTURE_BYTES = 16 * 1_024;

export function buildCodexArgs(config, workingDirectory = os.tmpdir(), options = {}) {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "-C",
    workingDirectory,
    "-c",
    `model_reasoning_effort=\"${config.reasoningEffort}\"`,
  ];

  if (options.account?.isolated || options.forceFileCredentials) {
    args.push("-c", 'cli_auth_credentials_store="file"');
  }

  if (config.model) args.push("--model", config.model);
  args.push(config.message);
  return args;
}

export async function runCodex(config, options = {}) {
  const command = options.command || config.codexPath;
  const args = buildCodexArgs(config, options.workingDirectory, options);
  const startedAt = new Date().toISOString();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      env: { ...(options.env || process.env), NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, config.timeoutSeconds * 1_000);
    timeout.unref();

    child.stdout.on("data", (chunk) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ ok: false, code: null, signal: null, error: error.message, stdout, stderr, startedAt });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        code,
        signal,
        error: code === 0
          ? null
          : (timedOut ? `Codex timed out after ${config.timeoutSeconds} seconds` : summarizeFailure(stderr, code, signal)),
        stdout,
        stderr,
        startedAt,
      });
    });
  });
}

function appendBounded(current, chunk) {
  return `${current}${chunk.toString("utf8")}`.slice(-MAX_CAPTURE_BYTES);
}

function summarizeFailure(stderr, code, signal) {
  const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
  if (detail) return detail;
  if (signal) return `Codex was terminated by signal ${signal}`;
  return `Codex exited with code ${code}`;
}
