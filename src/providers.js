import { runClaude } from "./claude.js";
import { readClaudeRateLimits } from "./claude-usage.js";
import { runCodex } from "./codex.js";
import { buildClaudeRenewalPrompt, buildRenewalPrompt, CLAUDE_PROMPT_TIERS, PROMPT_TIERS } from "./prompt.js";
import { readAccountRateLimits } from "./rate-limits.js";
import { buildFiveHourVerification, findFiveHourWindow } from "./scheduler.js";

export const PROVIDER_IDS = Object.freeze(["codex", "claude"]);

export const PROVIDERS = Object.freeze({
  codex: Object.freeze({
    id: "codex",
    label: "Codex",
    executableKey: "codexPath",
    runner: runCodex,
    verifier: readAccountRateLimits,
    tiers: PROMPT_TIERS,
    buildPrompt: buildRenewalPrompt,
    verify: buildFiveHourVerification,
  }),
  claude: Object.freeze({
    id: "claude",
    label: "Claude Code",
    executableKey: "claudePath",
    runner: runClaude,
    verifier: readClaudeRateLimits,
    tiers: CLAUDE_PROMPT_TIERS,
    buildPrompt: buildClaudeRenewalPrompt,
    verify: buildClaudeVerification,
  }),
});

export function getProvider(id) {
  const provider = PROVIDERS[id];
  if (!provider) throw new Error(`unknown provider: ${id}`);
  return provider;
}

export function parseProviderSelection(value) {
  if (value === "all") return [...PROVIDER_IDS];
  if (PROVIDER_IDS.includes(value)) return [value];
  throw new Error(`--provider must be one of: ${PROVIDER_IDS.join(", ")}, all`);
}

/**
 * Claude reports the five-hour window only while one is running, and its reset
 * is anchored to the window start rather than sliding with wall time. Presence
 * of a future reset after the prompt is therefore the renewal evidence, and a
 * missing window stays `unavailable` instead of being called a success.
 */
export function buildClaudeVerification({
  beforeWindows = [],
  afterWindows = [],
  beforeCheckedAt = null,
  checkedAt = null,
  error = null,
} = {}) {
  const beforeWindow = findFiveHourWindow(beforeWindows);
  const afterWindow = findFiveHourWindow(afterWindows);
  const beforeResetsAt = beforeWindow?.resetsAt ?? null;
  const afterResetsAt = afterWindow?.resetsAt ?? null;
  const checkedMs = Date.parse(checkedAt);
  const afterMs = Date.parse(afterResetsAt);
  const beforeMs = Date.parse(beforeResetsAt);
  const observationMs = checkedMs - Date.parse(beforeCheckedAt);
  const observationSeconds = Number.isFinite(observationMs) && observationMs > 0
    ? Math.round(observationMs / 1_000)
    : null;
  const changeSeconds = Number.isFinite(beforeMs) && Number.isFinite(afterMs)
    ? Math.round((afterMs - beforeMs) / 1_000)
    : null;

  const anchored = Number.isFinite(afterMs)
    && (!Number.isFinite(checkedMs) || afterMs > checkedMs);

  return {
    status: anchored ? "renewed" : "unavailable",
    beforeResetsAt,
    afterResetsAt,
    changeSeconds,
    observationSeconds,
    error,
  };
}
