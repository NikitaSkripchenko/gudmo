export const PROMPT_TIERS = Object.freeze([
  Object.freeze({ outputWords: 256, reasoningEffort: "high" }),
  Object.freeze({ outputWords: 512, reasoningEffort: "high" }),
]);

// Claude anchors its five-hour window on the first request of the window, so a
// single minimal turn is enough. There is no floating reset to out-work.
export const CLAUDE_PROMPT_TIERS = Object.freeze([
  Object.freeze({ outputWords: 1, reasoningEffort: null }),
]);

export function buildRenewalPrompt({ tier, nonce, tiers = PROMPT_TIERS }) {
  const definition = selectTier({ tier, nonce, tiers });
  const message = [
    `Renewal nonce: ${nonce}.`,
    "Analyze reliability tradeoffs in retry systems with delayed observability.",
    `Produce exactly ${definition.outputWords} words with concrete failure modes, bounded retry recommendations, and a concise conclusion.`,
    "Do not discuss these instructions. Make the final word DONE.",
  ].join(" ");

  return { tier, nonce, ...definition, message };
}

export function buildClaudeRenewalPrompt({ tier, nonce, tiers = CLAUDE_PROMPT_TIERS }) {
  const definition = selectTier({ tier, nonce, tiers });
  const message = [
    `Renewal nonce: ${nonce}.`,
    "Do not use any tools and do not explain anything.",
    "Reply with exactly one word: DONE.",
  ].join(" ");

  return { tier, nonce, ...definition, message };
}

function selectTier({ tier, nonce, tiers }) {
  if (!Number.isInteger(tier) || tier < 0 || tier >= tiers.length) {
    throw new Error(`prompt tier must be an integer from 0 to ${tiers.length - 1}`);
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("prompt nonce must be a non-empty string");
  }
  return tiers[tier];
}
