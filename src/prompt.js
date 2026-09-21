export const PROMPT_TIERS = Object.freeze([
  Object.freeze({ outputWords: 1, reasoningEffort: "minimal" }),
]);

export function buildRenewalPrompt({ tier, nonce, tiers = PROMPT_TIERS }) {
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
