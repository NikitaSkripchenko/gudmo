import assert from "node:assert/strict";
import test from "node:test";
import { buildClaudeRenewalPrompt, buildRenewalPrompt, CLAUDE_PROMPT_TIERS, PROMPT_TIERS } from "../src/prompt.js";

test("the codex tiers escalate workload under live-calibrated reasoning effort", () => {
  assert.deepEqual(PROMPT_TIERS, [
    { outputWords: 256, reasoningEffort: "low" },
    { outputWords: 512, reasoningEffort: "low" },
  ]);
});

test("claude needs exactly one minimal tier", () => {
  assert.deepEqual(CLAUDE_PROMPT_TIERS, [
    { outputWords: 1, reasoningEffort: null },
  ]);
});

test("codex prompts state a bounded task with a fresh nonce", () => {
  const prompt = buildRenewalPrompt({ tier: 0, nonce: "unique-nonce" });
  assert.match(prompt.message, /unique-nonce/);
  assert.match(prompt.message, /exactly 256 words/);
  assert.match(prompt.message, /DONE/);
  assert.equal(prompt.outputWords, 256);
  assert.equal(prompt.reasoningEffort, "low");

  const tier2 = buildRenewalPrompt({ tier: 1, nonce: "unique-nonce" });
  assert.match(tier2.message, /exactly 512 words/);
  assert.equal(tier2.outputWords, 512);
});

test("claude prompt is a single minimal turn", () => {
  const prompt = buildClaudeRenewalPrompt({ tier: 0, nonce: "unique-nonce" });
  assert.equal(
    prompt.message,
    "Renewal nonce: unique-nonce. Do not use any tools and do not explain anything. Reply with exactly one word: DONE.",
  );
  assert.equal(prompt.outputWords, 1);
  assert.equal(prompt.reasoningEffort, null);
});

test("unknown tiers and empty nonces are rejected", () => {
  assert.throws(() => buildRenewalPrompt({ tier: 2, nonce: "x" }), /tier/);
  assert.throws(() => buildRenewalPrompt({ tier: 0, nonce: "" }), /nonce/);
  assert.throws(() => buildClaudeRenewalPrompt({ tier: 1, nonce: "x" }), /tier/);
});
