export const APP_NAME = "gudmo";
export const VERSION = "0.4.2";
export const STATE_VERSION = 1;
export const LAUNCHD_LABEL = "dev.gudmo.renew";

export const WINDOW_DEFINITIONS = Object.freeze({
  "5h": Object.freeze({ label: "5-hour", durationMs: 5 * 60 * 60 * 1_000 }),
  "7d": Object.freeze({ label: "7-day", durationMs: 7 * 24 * 60 * 60 * 1_000 }),
});

export const DEFAULT_CONFIG = Object.freeze({
  message: "Reply only: OK",
  maxIntervalSeconds: 5 * 60 * 60,
  maxRequestsPer24Hours: 5,
  resetGraceSeconds: 1,
  retrySeconds: 60,
  timeoutSeconds: 120,
  reasoningEffort: "low",
  model: null,
  codexPath: "codex",
  enabledWindows: Object.freeze(["5h", "7d"]),
});
