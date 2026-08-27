import assert from "node:assert/strict";
import test from "node:test";
import { buildRenewalPrompt, PROMPT_WORD_COUNTS } from "../src/prompt.js";

test("renewal prompts have five increasing tiers", () => {
  assert.deepEqual(PROMPT_WORD_COUNTS, [64, 128, 256, 512, 1024]);
  const prompts = PROMPT_WORD_COUNTS.map((_, tier) => (
    buildRenewalPrompt({ tier, nonce: "nonce-a" })
  ));
  const lengths = prompts.map(({ message }) => message.length);

  assert.deepEqual(lengths, [...lengths].sort((left, right) => left - right));
  assert.equal(new Set(lengths).size, 5);
  assert.deepEqual(prompts.map(({ wordCount }) => wordCount), PROMPT_WORD_COUNTS);
});

test("a renewal prompt includes its nonce once and demands an exact OK reply", () => {
  const prompt = buildRenewalPrompt({ tier: 0, nonce: "unique-nonce" });
  const payload = prompt.message.split("Payload: ")[1];

  assert.equal(prompt.message.split("unique-nonce").length - 1, 1);
  assert.match(prompt.message, /Reply exactly OK/);
  assert.equal(payload.trim().split(/\s+/).length, 64);
  assert.equal(payload.trim().split(/\s+/).at(-1), "pine");
});

test("unknown tiers and empty nonces are rejected", () => {
  assert.throws(() => buildRenewalPrompt({ tier: 5, nonce: "x" }), /tier/);
  assert.throws(() => buildRenewalPrompt({ tier: 0, nonce: "" }), /nonce/);
});
