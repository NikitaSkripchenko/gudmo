import { runCodex } from "./codex.js";
import { spawn } from "node:child_process";
import { VERSION } from "./constants.js";

export async function runTokenEval({
  config,
  runs,
  runner = runCodex,
  runnerOptions,
  codexVersion = "unknown",
  clock = Date.now,
} = {}) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new Error("runs must be an integer from 1 to 100");
  }
  const samples = [];
  for (let run = 0; run < runs; run += 1) {
    samples.push(await runner(config, runnerOptions));
  }
  return buildTokenEval({
    samples,
    maxRequestsPer24Hours: config.maxRequestsPer24Hours,
    metadata: {
      model: config.model || "default",
      reasoningEffort: config.reasoningEffort,
      codexVersion,
      gudmoVersion: VERSION,
      evaluatedAt: new Date(clock()).toISOString(),
      prompt: config.message,
    },
  });
}

export function formatTokenEval(report) {
  return [
    "Gudmo Token Footprint Eval",
    `Runs:                    ${report.runs}`,
    `Measurable runs:         ${report.measurableRuns}/${report.runs}`,
    `Exact minimal replies:   ${report.exactMinimalReplies}/${report.runs}`,
    `Median tokens/request:   ${report.medianTokensPerRequest ?? "unavailable"}`,
    `P95 tokens/request:      ${report.p95TokensPerRequest ?? "unavailable"}`,
    `24h request ceiling:     ${report.maxRequestsPer24Hours}`,
    `T24 upper estimate:      ${report.t24UpperEstimate === null ? "unavailable" : `${report.t24UpperEstimate} tokens`}`,
    `Method:                  ${report.method}`,
    `Codex:                   ${report.metadata.codexVersion}`,
    `Model/reasoning:         ${report.metadata.model} / ${report.metadata.reasoningEffort}`,
    `Result:                  ${report.result}`,
  ].join("\n");
}

export async function readCodexVersion(config, { env = process.env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(config.codexPath, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-500);
    });
    child.on("error", () => resolve("unknown"));
    child.on("close", (code) => resolve(code === 0 ? (output.trim() || "unknown") : "unknown"));
  });
}

export function buildTokenEval({ samples, maxRequestsPer24Hours, metadata }) {
  const measurable = samples.filter((sample) => sample.ok && Number.isFinite(sample.usage?.totalTokens));
  const totals = measurable.map((sample) => sample.usage.totalTokens);
  const medianTokensPerRequest = percentile(totals, 50);
  const p95TokensPerRequest = percentile(totals, 95);
  const exactMinimalReplies = samples.filter((sample) => sample.ok && sample.minimalReply).length;
  const passed = measurable.length === samples.length && exactMinimalReplies === samples.length;

  return {
    metric: "T24",
    method: "p95(input_tokens + output_tokens) × max requests per rolling 24 hours",
    runs: samples.length,
    measurableRuns: measurable.length,
    exactMinimalReplies,
    medianTokensPerRequest,
    p95TokensPerRequest,
    maxRequestsPer24Hours,
    t24UpperEstimate: p95TokensPerRequest === null ? null : p95TokensPerRequest * maxRequestsPer24Hours,
    result: passed ? "PASS" : "FAIL",
    metadata,
    samples: samples.map((sample, index) => ({
      run: index + 1,
      ok: sample.ok,
      startedAt: sample.startedAt || null,
      code: sample.code ?? null,
      signal: sample.signal ?? null,
      reply: typeof sample.reply === "string" ? sample.reply : null,
      minimalReply: sample.minimalReply === true,
      usage: sample.usage || null,
      error: sample.error || null,
    })),
  };
}

export function percentile(values, rank) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index];
}
