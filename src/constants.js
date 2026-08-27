export const APP_NAME = "gudmo";
export const VERSION = "0.4.2";
export const STATE_VERSION = 1;
export const LAUNCHD_LABEL = "dev.gudmo.renew";

export const DEFAULT_CONFIG = Object.freeze({
  retrySeconds: 60,
  timeoutSeconds: 120,
  reasoningEffort: "low",
  model: null,
  codexPath: "codex",
});
