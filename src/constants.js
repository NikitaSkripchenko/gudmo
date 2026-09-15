export const VERSION = "0.5.0";
export const STATE_VERSION = 2;

export const DEFAULT_CONFIG = Object.freeze({
  retrySeconds: 60,
  timeoutSeconds: 120,
  reasoningEffort: "low",
  model: null,
  claudeModel: null,
  codexPath: "codex",
  claudePath: "claude",
});
