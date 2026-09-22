import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenEval, percentile, runTokenEval } from "../src/eval.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

test("percentile uses the nearest-rank method", () => {
  assert.equal(percentile([100, 110, 120, 130, 140], 50), 120);
  assert.equal(percentile([100, 110, 120, 130, 140], 95), 140);
  assert.equal(percentile([], 95), null);
});

test("eval builds every call through the production prompt builder", async () => {
  const messages = [];
  const report = await runTokenEval({
    config: DEFAULT_CONFIG,
    runs: 2,
    tiers: [0, 1],
    nonceFactory: ({ tier, run }) => `nonce-${tier}-${run}`,
    codexVersion: "codex-cli test",
    clock: () => Date.parse("2026-08-27T12:00:00.000Z"),
    runner: async (config) => {
      messages.push(config.message);
      return config.message.includes("exactly 512 words")
        ? sample(1_000 + messages.length, false, 600)
        : sample(700 + messages.length, false, 300);
    },
  });

  assert.equal(messages.length, 4);
  assert.match(messages[0], /nonce-0-0/);
  assert.match(messages[0], /exactly 256 words/);
  assert.match(messages[2], /nonce-1-0/);
  assert.match(messages[2], /exactly 512 words/);
  assert.deepEqual(report.tiers.map(({ tier }) => tier), [1, 2]);
  assert.deepEqual(report.tiers.map(({ outputWords }) => outputWords), [256, 512]);
  assert.equal(report.result, "PASS");
  assert.equal(report.metadata.codexVersion, "codex-cli test");
});

test("eval fails when telemetry or bounded output is missing", async () => {
  let calls = 0;
  const report = await runTokenEval({
    config: DEFAULT_CONFIG,
    runs: 2,
    tiers: [0],
    nonceFactory: ({ run }) => `nonce-${run}`,
    runner: async () => {
      calls += 1;
      return calls === 1
        ? sample(700, false, 300)
        : { ok: true, minimalReply: false, usage: null };
    },
  });

  assert.equal(report.result, "FAIL");
  assert.equal(report.tiers[0].measurableRuns, 1);
  assert.equal(report.tiers[0].validReplies, 1);
});

test("eval validates run counts and tier indexes", async () => {
  await assert.rejects(runTokenEval({ config: DEFAULT_CONFIG, runs: 0 }), /runs/);
  await assert.rejects(runTokenEval({ config: DEFAULT_CONFIG, runs: 1, tiers: [2] }), /tier/);
});

test("formatted eval reports per-tier token measurements", async () => {
  const report = await runTokenEval({
    config: DEFAULT_CONFIG,
    runs: 1,
    tiers: [0],
    nonceFactory: () => "nonce",
    codexVersion: "codex-cli test",
    runner: async () => sample(700, false, 300),
  });
  const formatted = formatTokenEval(report);
  assert.match(formatted, /Production Prompt Eval/);
  assert.match(formatted, /Tier 1: 256 output words \/ low reasoning/);
  assert.match(formatted, /P95 tokens: 700/);
  assert.match(formatted, /Result:\s+PASS/);
});

function sample(totalTokens, minimalReply, outputTokens = 1) {
  return {
    ok: true,
    startedAt: "2026-08-27T12:00:00.000Z",
    code: 0,
    signal: null,
    reply: minimalReply ? "OK" : "no",
    minimalReply,
    usage: {
      inputTokens: totalTokens - outputTokens,
      cachedInputTokens: 0,
      outputTokens,
      totalTokens,
    },
  };
}
