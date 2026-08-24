import assert from "node:assert/strict";
import test from "node:test";
import { buildTokenEval, formatTokenEval, percentile, runTokenEval } from "../src/eval.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

test("percentile uses the repeatable nearest-rank method", () => {
  assert.equal(percentile([100, 110, 120, 130, 140], 50), 120);
  assert.equal(percentile([100, 110, 120, 130, 140], 95), 140);
});

test("buildTokenEval reports a conservative p95 24-hour footprint", () => {
  const report = buildTokenEval({
    samples: [
      sample(100, true),
      sample(110, true),
      sample(120, true),
      sample(130, true),
      sample(140, false),
    ],
    maxRequestsPer24Hours: 5,
    metadata: { model: "default", reasoningEffort: "low", codexVersion: "codex-cli 1.2.3" },
  });

  assert.equal(report.runs, 5);
  assert.equal(report.exactMinimalReplies, 4);
  assert.equal(report.medianTokensPerRequest, 120);
  assert.equal(report.p95TokensPerRequest, 140);
  assert.equal(report.maxRequestsPer24Hours, 5);
  assert.equal(report.t24UpperEstimate, 700);
  assert.equal(report.result, "FAIL");
  assert.equal(report.method, "p95(input_tokens + output_tokens) × max requests per rolling 24 hours");
});

test("runTokenEval evaluates the exact production invocation repeatedly", async () => {
  let calls = 0;
  const report = await runTokenEval({
    config: DEFAULT_CONFIG,
    runs: 3,
    codexVersion: "codex-cli test",
    clock: () => Date.parse("2026-08-24T12:00:00.000Z"),
    runner: async () => {
      calls += 1;
      return {
        ok: true,
        startedAt: `2026-08-24T12:00:0${calls}.000Z`,
        code: 0,
        signal: null,
        reply: "OK",
        minimalReply: true,
        usage: {
          inputTokens: 100 + calls,
          cachedInputTokens: 80,
          outputTokens: 1,
          totalTokens: 101 + calls,
        },
      };
    },
  });

  assert.equal(calls, 3);
  assert.equal(report.runs, 3);
  assert.equal(report.exactMinimalReplies, 3);
  assert.equal(report.p95TokensPerRequest, 104);
  assert.equal(report.t24UpperEstimate, 520);
  assert.equal(report.result, "PASS");
  assert.equal(report.metadata.evaluatedAt, "2026-08-24T12:00:00.000Z");
  assert.equal(report.metadata.gudmoVersion, "0.4.2");
  assert.equal(report.metadata.prompt, "Reply only: OK");
  assert.deepEqual(report.samples[0], {
    run: 1,
    ok: true,
    startedAt: "2026-08-24T12:00:01.000Z",
    code: 0,
    signal: null,
    reply: "OK",
    minimalReply: true,
    usage: {
      inputTokens: 101,
      cachedInputTokens: 80,
      outputTokens: 1,
      totalTokens: 102,
    },
    error: null,
  });
});

test("runTokenEval rejects run counts that cannot produce a useful bounded eval", async () => {
  await assert.rejects(
    runTokenEval({ config: DEFAULT_CONFIG, runs: 0, runner: async () => ({ ok: true }) }),
    /runs must be an integer from 1 to 100/,
  );
});

test("formatTokenEval presents the complete measurable result", () => {
  const report = buildTokenEval({
    samples: [sample(120, true), sample(140, true)],
    maxRequestsPer24Hours: 5,
    metadata: { model: "default", reasoningEffort: "low", codexVersion: "codex-cli 1.2.3" },
  });

  assert.equal(formatTokenEval(report), [
    "Gudmo Token Footprint Eval",
    "Runs:                    2",
    "Measurable runs:         2/2",
    "Exact minimal replies:   2/2",
    "Median tokens/request:   120",
    "P95 tokens/request:      140",
    "24h request ceiling:     5",
    "T24 upper estimate:      700 tokens",
    "Method:                  p95(input_tokens + output_tokens) × max requests per rolling 24 hours",
    "Codex:                   codex-cli 1.2.3",
    "Model/reasoning:         default / low",
    "Result:                  PASS",
  ].join("\n"));
});

function sample(totalTokens, minimalReply) {
  return {
    ok: true,
    minimalReply,
    usage: { inputTokens: totalTokens - 1, cachedInputTokens: 0, outputTokens: 1, totalTokens },
  };
}
