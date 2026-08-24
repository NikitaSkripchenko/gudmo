import { DEFAULT_CONFIG, WINDOW_DEFINITIONS } from "./constants.js";
import { readJson, writeJsonAtomic } from "./storage.js";

const ALLOWED_REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export async function ensureConfig(configPath) {
  const existing = await readJson(configPath, null);
  if (existing === null) {
    await writeJsonAtomic(configPath, DEFAULT_CONFIG);
  } else if (existing.message === "gudmo") {
    await writeJsonAtomic(configPath, { ...existing, message: DEFAULT_CONFIG.message });
  }
  return loadConfig(configPath);
}

export async function loadConfig(configPath) {
  const input = await readJson(configPath, {});
  const config = { ...DEFAULT_CONFIG, ...input };

  if (typeof config.message !== "string" || config.message.length === 0 || config.message.length > 100) {
    throw new Error("config.message must be a non-empty string of at most 100 characters");
  }
  validateSeconds("maxIntervalSeconds", config.maxIntervalSeconds, 60, 5 * 60 * 60);
  if (!Number.isInteger(config.maxRequestsPer24Hours)
    || config.maxRequestsPer24Hours < 1
    || config.maxRequestsPer24Hours > 100) {
    throw new Error("config.maxRequestsPer24Hours must be an integer from 1 to 100");
  }
  validateSeconds("resetGraceSeconds", config.resetGraceSeconds, 0, 60);
  validateSeconds("retrySeconds", config.retrySeconds, 5, 86_400);
  validateSeconds("timeoutSeconds", config.timeoutSeconds, 10, 600);
  if (config.pollSeconds !== undefined) validateSeconds("pollSeconds", config.pollSeconds, 5, 3_600);
  if (config.model !== null && (typeof config.model !== "string" || !config.model.trim())) {
    throw new Error("config.model must be null or a non-empty string");
  }
  if (typeof config.codexPath !== "string" || !config.codexPath.trim()) {
    throw new Error("config.codexPath must be a non-empty string");
  }
  if (!ALLOWED_REASONING.has(config.reasoningEffort)) {
    throw new Error(`config.reasoningEffort must be one of: ${[...ALLOWED_REASONING].join(", ")}`);
  }
  if (!Array.isArray(config.enabledWindows) || config.enabledWindows.length === 0) {
    throw new Error("config.enabledWindows must contain 5h, 7d, or both");
  }
  const enabledWindows = [...new Set(config.enabledWindows)];
  if (enabledWindows.some((name) => !WINDOW_DEFINITIONS[name])) {
    throw new Error("config.enabledWindows may only contain 5h and 7d");
  }

  return { ...config, enabledWindows };
}

function validateSeconds(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`config.${name} must be an integer from ${minimum} to ${maximum}`);
  }
}
