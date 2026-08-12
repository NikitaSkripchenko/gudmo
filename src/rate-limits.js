import { spawn } from "node:child_process";

const INITIALIZE_ID = 1;
const RATE_LIMITS_ID = 2;
const MAX_STDOUT_BUFFER_BYTES = 64 * 1_024;

export async function readAccountRateLimits(config, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const timeoutMs = options.timeoutMs || 15_000;
  const args = ["app-server", "--listen", "stdio://"];
  if (options.account?.isolated || options.forceFileCredentials) {
    args.unshift("-c", 'cli_auth_credentials_store="file"');
  }
  const child = spawnProcess(config.codexPath, args, {
    env: { ...(options.env || process.env), NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error("Codex rate-limit read timed out")), timeoutMs);
    timeout.unref();

    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      if (error) reject(error);
      else resolve(normalizeRateLimits(response));
    };

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAX_STDOUT_BUFFER_BYTES) {
        finish(new Error("Codex rate-limit response exceeded 64 KiB"));
        return;
      }
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== RATE_LIMITS_ID) continue;
        if (message.error) {
          finish(new Error(message.error.message || "Codex rejected the rate-limit request"));
          return;
        }
        finish(null, message.result);
        return;
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      const detail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 500);
      finish(new Error(detail || `Codex app-server exited before responding (${signal || code})`));
    });

    writeMessage(child, {
      id: INITIALIZE_ID,
      method: "initialize",
      params: {
        clientInfo: { name: "gudmo", version: "0.4.1" },
        capabilities: { experimentalApi: true },
      },
    });
    writeMessage(child, { method: "initialized", params: {} });
    writeMessage(child, { id: RATE_LIMITS_ID, method: "account/rateLimits/read", params: null });
  });
}

export function normalizeRateLimits(response, fetchedAt = new Date().toISOString()) {
  if (!response || typeof response !== "object") {
    throw new Error("Codex returned an invalid rate-limit response");
  }

  const buckets = response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === "object"
    ? Object.entries(response.rateLimitsByLimitId)
    : [[response.rateLimits?.limitId || "codex", response.rateLimits]];
  const windows = [];

  for (const [bucketId, snapshot] of buckets) {
    if (!snapshot || typeof snapshot !== "object") continue;
    for (const kind of ["primary", "secondary"]) {
      const window = snapshot[kind];
      if (!window || !Number.isFinite(window.resetsAt)) continue;
      windows.push({
        limitId: snapshot.limitId || bucketId,
        kind,
        durationMinutes: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
        resetsAt: new Date(window.resetsAt * 1_000).toISOString(),
        usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
      });
    }
  }

  return { fetchedAt, windows };
}

function writeMessage(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}
