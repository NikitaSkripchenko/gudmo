export const PROMPT_WORD_COUNTS = Object.freeze([64, 128, 256, 512, 1024]);

const WORDS = Object.freeze([
  "amber", "birch", "cedar", "delta", "ember", "frost", "grove", "harbor",
  "island", "juniper", "kernel", "linen", "meadow", "north", "orbit", "pine",
]);

export function buildRenewalPrompt({ tier, nonce }) {
  if (!Number.isInteger(tier) || tier < 0 || tier >= PROMPT_WORD_COUNTS.length) {
    throw new Error(`prompt tier must be an integer from 0 to ${PROMPT_WORD_COUNTS.length - 1}`);
  }
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new Error("prompt nonce must be a non-empty string");
  }

  const wordCount = PROMPT_WORD_COUNTS[tier];
  const words = Array.from({ length: wordCount }, (_, index) => WORDS[index % WORDS.length]);
  words[Math.floor(words.length / 2)] = nonce;
  words[words.length - 1] = "pine";

  return {
    tier,
    nonce,
    wordCount,
    message: [
      "Silently inspect the payload below. Confirm that its unique nonce appears exactly once and that the final payload word is pine. Do not explain your work. Reply exactly OK if both checks pass.",
      `Payload: ${words.join(" ")}`,
    ].join("\n"),
  };
}
