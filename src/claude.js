import { spawn } from "node:child_process";

const MAX_STDOUT_BYTES = 1 * 1_024 * 1_024;
const MAX_STDERR_BYTES = 16 * 1_024;

export function buildClaudeArgs(config) {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "manual",
  ];
  if (config.claudeModel) args.push("--model", config.claudeModel);
  args.push(config.message);
  return args;
}

export async function runClaude(config, options = {}) {
  const command = options.command || config.claudePath;
  const args = buildClaudeArgs(config);
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
      // Claude prints one JSON document, so keep the head: dropping the tail
      // fails to parse loudly instead of silently corrupting the object.
      stdout = appendHead(stdout, chunk, MAX_STDOUT_BYTES);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendTail(stderr, chunk, MAX_STDERR_BYTES);
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
      let telemetry = null;
      let telemetryError = null;
      if (code === 0) {
        try {
          telemetry = parseClaudeResult(stdout);
        } catch (error) {
          telemetryError = error instanceof Error ? error.message : String(error);
        }
      }
      resolve({
        ok: code === 0 && telemetryError === null,
        code,
        signal,
        error: code === 0
          ? telemetryError
          : (timedOut ? `Claude timed out after ${config.timeoutSeconds} seconds` : summarizeFailure(stderr, code, signal, stdout)),
        stdout,
        stderr,
        startedAt,
        ...(telemetry || {}),
      });
    });
  });
}

export function parseClaudeResult(output) {
  let payload;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("Claude JSON output was not valid JSON");
  }
  if (payload?.is_error || payload?.subtype !== "success") {
    throw new Error(`Claude did not complete the turn: ${payload?.result || payload?.subtype || "unknown error"}`);
  }

  const usage = payload.usage || {};
  const inputTokens = usage.input_tokens;
  const cachedInputTokens = usage.cache_read_input_tokens;
  const outputTokens = usage.output_tokens;
  if (![inputTokens, cachedInputTokens, outputTokens].every(isTokenCount)) {
    throw new Error("Claude JSON output did not include valid token usage");
  }

  const reply = typeof payload.result === "string" ? payload.result : null;
  return {
    reply,
    minimalReply: reply !== null && reply.trim().toUpperCase().endsWith("DONE"),
    usage: {
      inputTokens,
      cachedInputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}

function isTokenCount(value) {
  return Number.isInteger(value) && value >= 0;
}

function appendHead(current, chunk, limit) {
  if (current.length >= limit) return current;
  return `${current}${chunk.toString("utf8")}`.slice(0, limit);
}

function appendTail(current, chunk, limit) {
  return `${current}${chunk.toString("utf8")}`.slice(-limit);
}

function summarizeFailure(stderr, code, signal, stdout) {
  const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500);
  if (detail) return detail;
  if (signal) return `Claude was terminated by signal ${signal}`;
  // In JSON mode Claude can report API/auth failures only on stdout, even
  // with subtype "success". Do not expose the rest of the telemetry document.
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    // Empty, malformed, or truncated output has no reliable structured detail.
    return `Claude exited with code ${code}`;
  }
  const failedSubtype = typeof payload?.subtype === "string" && payload.subtype.startsWith("error_");
  if (payload?.is_error || failedSubtype) {
    const errors = Array.isArray(payload.errors)
      ? payload.errors.filter((error) => typeof error === "string").join(" ").trim()
      : "";
    const result = typeof payload.result === "string" ? payload.result.trim() : "";
    const message = result || errors || (failedSubtype ? payload.subtype : "");
    if (message) return message.split("\n").slice(-3).join(" ").slice(0, 500);
  }
  return `Claude exited with code ${code}`;
}
