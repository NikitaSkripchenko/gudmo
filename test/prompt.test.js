import assert from "node:assert/strict";
import test from "node:test";
import { buildRenewalPrompt, PROMPT_TIERS } from "../src/prompt.js";

test("the first renewal attempt uses the live-verified workload", () => {
  assert.deepEqual(PROMPT_TIERS, [
    { outputWords: 1, reasoningEffort: "minimal" },
  ]);
});

test("renewal uses the proven Claude prompt for every provider", () => {
  const prompt = buildRenewalPrompt({ tier: 0, nonce: "unique-nonce" });
  assert.equal(
    prompt.message,
    "Renewal nonce: unique-nonce. Do not use any tools and do not explain anything. Reply with exactly one word: DONE.",
  );
  assert.equal(prompt.outputWords, 1);
  assert.equal(prompt.reasoningEffort, "minimal");
});

test("unknown tiers and empty nonces are rejected", () => {
  assert.throws(() => buildRenewalPrompt({ tier: 1, nonce: "x" }), /tier/);
  assert.throws(() => buildRenewalPrompt({ tier: 0, nonce: "" }), /nonce/);
});
