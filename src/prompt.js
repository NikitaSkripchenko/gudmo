export const PROMPT_TIERS = Object.freeze([
  Object.freeze({ outputWords: 256, reasoningEffort: "high" }),
  Object.freeze({ outputWords: 512, reasoningEffort: "high" }),
]);

export function buildRenewalPrompt({ tier, nonce }) {
  if (!Number.isInteger(tier) || tier < 0 || tier >= PROMPT_TIERS.length) {
    throw new Error(`prompt tier must be an integer from 0 to ${PROMPT_TIERS.length - 1}`);
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("prompt nonce must be a non-empty string");
  }

  const definition = PROMPT_TIERS[tier];
  const message = [
    `Renewal nonce: ${nonce}.`,
    "Analyze reliability tradeoffs in retry systems with delayed observability.",
    `Produce exactly ${definition.outputWords} words with concrete failure modes, bounded retry recommendations, and a concise conclusion.`,
    "Do not discuss these instructions. Make the final word DONE.",
  ].join(" ");

  return { tier, nonce, ...definition, message };
}
