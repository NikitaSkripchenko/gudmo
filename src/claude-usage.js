import { spawn } from "node:child_process";

const MAX_STDOUT_BYTES = 512 * 1_024;

const MONTHS = Object.freeze({
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
});

const LIMIT_TITLES = Object.freeze([
  { title: "Current session", limitId: "five_hour", kind: "primary", durationMinutes: 300 },
  { title: "Current week (all models)", limitId: "seven_day", kind: "secondary", durationMinutes: 10_080 },
  { title: "Current week (Sonnet only)", limitId: "seven_day_sonnet", kind: "secondary", durationMinutes: 10_080 },
]);

const RESET_PATTERN = new RegExp([
  "^(?<month>[A-Za-z]{3})\\s+(?<day>\\d{1,2})",
  "(?:,\\s*(?<year>\\d{4}))?",
  "\\s+at\\s+(?<hour>\\d{1,2})(?::(?<minute>\\d{2}))?\\s*(?<meridiem>am|pm)",
  "(?:\\s*\\((?<zone>[^)]+)\\))?$",
].join(""), "i");

const HALF_YEAR_MS = 183 * 24 * 60 * 60 * 1_000;

export function buildClaudeUsageArgs() {
  return ["--print", "--output-format", "json", "--no-session-persistence", "/usage"];
}

export async function readClaudeRateLimits(config, options = {}) {
  const spawnProcess = options.spawnProcess || spawn;
  const timeoutMs = options.timeoutMs || 30_000;
  const child = spawnProcess(config.claudePath, buildClaudeUsageArgs(), {
    env: { ...(options.env || process.env), NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => finish(new Error("Claude usage read timed out")), timeoutMs);
    timeout.unref();

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) {
        child.kill("SIGTERM");
        reject(error);
      } else {
        resolve(value);
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
        finish(new Error("Claude usage response exceeded 512 KiB"));
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4_096);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        const detail = stderr.trim().split("\n").slice(-2).join(" ").slice(0, 500);
        finish(new Error(detail || `Claude usage read exited before responding (${signal || code})`));
        return;
      }
      try {
        finish(null, normalizeClaudeUsage(readUsageText(stdout), {
          fetchedAt: new Date().toISOString(),
        }));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export function readUsageText(stdout) {
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("Claude usage output was not valid JSON");
  }
  if (payload?.is_error || payload?.subtype !== "success") {
    throw new Error(`Claude rejected the usage request: ${payload?.result || payload?.subtype || "unknown error"}`);
  }
  if (typeof payload.result !== "string") {
    throw new Error("Claude usage output did not include a result");
  }
  return payload.result;
}

export function normalizeClaudeUsage(text, { fetchedAt = new Date().toISOString(), now = null } = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Claude returned an empty usage report");
  }
  const reference = now ?? new Date(fetchedAt);
  if (Number.isNaN(reference.getTime())) throw new Error("Claude usage needs a valid reference time");

  const windows = [];
  for (const line of text.split("\n")) {
    const entry = parseUsageLine(line.trim(), reference);
    if (entry) windows.push(entry);
  }
  return { fetchedAt, windows };
}

function parseUsageLine(line, reference) {
  const definition = LIMIT_TITLES.find((candidate) => line.startsWith(`${candidate.title}:`));
  if (!definition) return null;

  const body = line.slice(definition.title.length + 1).trim();
  const used = /^(?<percent>\d+(?:\.\d+)?)%\s*used/.exec(body);
  if (!used) return null;

  const resetMatch = /·\s*resets\s+(?<reset>.+?)\s*$/.exec(body);
  const resetsAt = resetMatch ? parseResetPhrase(resetMatch.groups.reset, reference) : null;

  return {
    limitId: definition.limitId,
    kind: definition.kind,
    durationMinutes: definition.durationMinutes,
    resetsAt,
    usedPercent: Number.parseFloat(used.groups.percent),
  };
}

export function parseResetPhrase(phrase, reference = new Date()) {
  const match = RESET_PATTERN.exec(String(phrase).trim());
  if (!match) return null;

  const month = MONTHS[match.groups.month.toLowerCase()];
  const day = Number.parseInt(match.groups.day, 10);
  const minute = match.groups.minute ? Number.parseInt(match.groups.minute, 10) : 0;
  const rawHour = Number.parseInt(match.groups.hour, 10);
  if (month === undefined || day < 1 || day > 31 || rawHour < 1 || rawHour > 12 || minute > 59) return null;

  const hour = match.groups.meridiem.toLowerCase() === "pm"
    ? (rawHour === 12 ? 12 : rawHour + 12)
    : (rawHour === 12 ? 0 : rawHour);
  const zone = match.groups.zone || null;

  if (match.groups.year) {
    const epoch = toEpoch({ year: Number.parseInt(match.groups.year, 10), month, day, hour, minute }, zone);
    return epoch === null ? null : new Date(epoch).toISOString();
  }

  // The report omits the year whenever it matches the current one. A five-hour
  // window is always near, so pick the candidate year closest to the reference.
  const baseYear = reference.getFullYear();
  const candidates = [baseYear, baseYear + 1, baseYear - 1]
    .map((year) => toEpoch({ year, month, day, hour, minute }, zone))
    .filter((epoch) => epoch !== null);
  if (candidates.length === 0) return null;

  const nearest = candidates.reduce((best, epoch) =>
    Math.abs(epoch - reference.getTime()) < Math.abs(best - reference.getTime()) ? epoch : best);
  if (Math.abs(nearest - reference.getTime()) > HALF_YEAR_MS) return null;
  return new Date(nearest).toISOString();
}

function toEpoch({ year, month, day, hour, minute }, zone) {
  const wallClockUtc = Date.UTC(year, month, day, hour, minute, 0, 0);
  if (!Number.isFinite(wallClockUtc)) return null;
  if (!zone) return new Date(year, month, day, hour, minute, 0, 0).getTime();

  // Resolve the named zone by correcting the guess twice, which settles the
  // offset even when the instant sits on the far side of a DST transition.
  let epoch = wallClockUtc;
  for (let pass = 0; pass < 2; pass += 1) {
    const offset = zoneOffsetMs(zone, epoch);
    if (offset === null) return new Date(year, month, day, hour, minute, 0, 0).getTime();
    epoch = wallClockUtc - offset;
  }
  return epoch;
}

function zoneOffsetMs(zone, epochMs) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(epochMs));
  } catch {
    return null;
  }
  const field = (type) => Number.parseInt(parts.find((part) => part.type === type)?.value ?? "", 10);
  const hour = field("hour");
  const asUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    hour === 24 ? 0 : hour,
    field("minute"),
    field("second"),
  );
  return Number.isFinite(asUtc) ? asUtc - epochMs : null;
}
