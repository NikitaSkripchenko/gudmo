import assert from "node:assert/strict";
import test from "node:test";
import { buildRenewalPrompt, PROMPT_TIERS } from "../src/prompt.js";

test("the first renewal attempt uses the live-verified workload", () => {
  assert.deepEqual(PROMPT_TIERS, [
    { outputWords: 256, reasoningEffort: "high" },
    { outputWords: 512, reasoningEffort: "high" },
  ]);
});

test("tier one is the workload verified on the problematic live account", () => {
  const prompt = buildRenewalPrompt({ tier: 0, nonce: "unique-nonce" });
  assert.equal(prompt.message.split("unique-nonce").length - 1, 1);
  assert.match(prompt.message, /exactly 256 words/);
  assert.match(prompt.message, /final word DONE/);
  assert.equal(prompt.outputWords, 256);
  assert.equal(prompt.reasoningEffort, "high");
});

test("later tiers increase the bounded workload", () => {
  const prompt = buildRenewalPrompt({ tier: 1, nonce: "unique-nonce" });
  assert.equal(prompt.message.split("unique-nonce").length - 1, 1);
  assert.match(prompt.message, /exactly 512 words/);
  assert.match(prompt.message, /final word DONE/);
  assert.equal(prompt.outputWords, 512);
  assert.equal(prompt.reasoningEffort, "high");
});

test("unknown tiers and empty nonces are rejected", () => {
  assert.throws(() => buildRenewalPrompt({ tier: 2, nonce: "x" }), /tier/);
  assert.throws(() => buildRenewalPrompt({ tier: 0, nonce: "" }), /nonce/);
});
