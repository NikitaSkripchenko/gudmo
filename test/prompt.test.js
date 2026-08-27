import assert from "node:assert/strict";
import test from "node:test";
import { buildRenewalPrompt, PROMPT_TIERS } from "../src/prompt.js";

test("renewal tiers escalate generated work and reasoning", () => {
  assert.deepEqual(PROMPT_TIERS, [
    { outputWords: 0, reasoningEffort: "low" },
    { outputWords: 64, reasoningEffort: "medium" },
    { outputWords: 128, reasoningEffort: "medium" },
    { outputWords: 256, reasoningEffort: "high" },
    { outputWords: 512, reasoningEffort: "high" },
  ]);
});

test("tier one is a unique cheap exact-OK request", () => {
  const prompt = buildRenewalPrompt({ tier: 0, nonce: "unique-nonce" });
  assert.equal(prompt.message.split("unique-nonce").length - 1, 1);
  assert.match(prompt.message, /Reply exactly OK/);
  assert.equal(prompt.outputWords, 0);
  assert.equal(prompt.reasoningEffort, "low");
});

test("the final tier requests the live-verified bounded workload", () => {
  const prompt = buildRenewalPrompt({ tier: 4, nonce: "unique-nonce" });
  assert.equal(prompt.message.split("unique-nonce").length - 1, 1);
  assert.match(prompt.message, /exactly 512 words/);
  assert.match(prompt.message, /final word DONE/);
  assert.equal(prompt.outputWords, 512);
  assert.equal(prompt.reasoningEffort, "high");
});

test("unknown tiers and empty nonces are rejected", () => {
  assert.throws(() => buildRenewalPrompt({ tier: 5, nonce: "x" }), /tier/);
  assert.throws(() => buildRenewalPrompt({ tier: 0, nonce: "" }), /nonce/);
});
