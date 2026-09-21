import { runClaude } from "./claude.js";
import { readClaudeRateLimits } from "./claude-usage.js";
import { runCodex } from "./codex.js";
import { buildRenewalPrompt, PROMPT_TIERS } from "./prompt.js";
import { readAccountRateLimits } from "./rate-limits.js";
import { buildFiveHourVerification } from "./scheduler.js";

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
    tiers: PROMPT_TIERS,
    buildPrompt: buildRenewalPrompt,
    verify: buildFiveHourVerification,
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
