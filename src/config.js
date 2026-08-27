import { DEFAULT_CONFIG } from "./constants.js";
import { readJson, writeJsonAtomic } from "./storage.js";

const ALLOWED_REASONING = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const CONFIG_KEYS = Object.freeze(Object.keys(DEFAULT_CONFIG));

export async function ensureConfig(configPath) {
  const input = await readJson(configPath, {});
  const config = validateConfig(input);
  const stored = Object.fromEntries(CONFIG_KEYS.map((key) => [key, config[key]]));
  if (JSON.stringify(input) !== JSON.stringify(stored)) await writeJsonAtomic(configPath, stored);
  return stored;
}

export async function loadConfig(configPath) {
  return validateConfig(await readJson(configPath, {}));
}

function validateConfig(input) {
  const config = { ...DEFAULT_CONFIG, ...pickSupported(input) };
  validateSeconds("retrySeconds", config.retrySeconds, 5, 3_600);
  validateSeconds("timeoutSeconds", config.timeoutSeconds, 10, 600);
  if (config.model !== null && (typeof config.model !== "string" || !config.model.trim())) {
    throw new Error("config.model must be null or a non-empty string");
  }
  if (typeof config.codexPath !== "string" || !config.codexPath.trim()) {
    throw new Error("config.codexPath must be a non-empty string");
  }
  if (!ALLOWED_REASONING.has(config.reasoningEffort)) {
    throw new Error(`config.reasoningEffort must be one of: ${[...ALLOWED_REASONING].join(", ")}`);
  }
  return config;
}

function pickSupported(input) {
  return Object.fromEntries(CONFIG_KEYS.filter((key) => key in input).map((key) => [key, input[key]]));
}

function validateSeconds(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`config.${name} must be an integer from ${minimum} to ${maximum}`);
  }
}
