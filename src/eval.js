import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { VERSION } from "./constants.js";
import { PROVIDERS } from "./providers.js";

export async function runTokenEval({
  config,
  runs,
  tiers = [0],
  provider = PROVIDERS.codex,
  nonceFactory = crypto.randomUUID,
  runner = provider.runner,
  runnerOptions,
  codexVersion = "unknown",
  clock = Date.now,
} = {}) {
  if (!Number.isInteger(runs) || runs < 1 || runs > 100) {
    throw new Error("runs must be an integer from 1 to 100");
  }
  if (!Array.isArray(tiers) || tiers.length === 0 || tiers.some((tier) => (
    !Number.isInteger(tier) || tier < 0 || tier >= provider.tiers.length
  ))) {
    throw new Error(`tier indexes must be integers from 0 to ${provider.tiers.length - 1}`);
  }

  const tierReports = [];
  for (const tier of [...new Set(tiers)]) {
    const samples = [];
    let promptCharacters = 0;
    for (let run = 0; run < runs; run += 1) {
      const prompt = provider.buildPrompt({ tier, nonce: nonceFactory({ tier, run }), tiers: provider.tiers });
      promptCharacters = Math.max(promptCharacters, prompt.message.length);
      samples.push(await runner({
        ...config,
        message: prompt.message,
        reasoningEffort: prompt.reasoningEffort,
      }, runnerOptions));
    }
    tierReports.push(buildTierReport({ tier, samples, promptCharacters, provider }));
  }

  return {
    metric: "prompt-tier-tokens",
    result: tierReports.every((tier) => tier.result === "PASS") ? "PASS" : "FAIL",
    metadata: {
      provider: provider.id,
      model: (provider.id === "claude" ? config.claudeModel : config.model) || "default",
      reasoningEffort: provider.id === "claude" ? "n/a" : config.reasoningEffort,
      codexVersion,
      gudmoVersion: VERSION,
      evaluatedAt: new Date(clock()).toISOString(),
    },
    tiers: tierReports,
  };
}

export function formatTokenEval(report) {
  const lines = [
    "Gudmo Production Prompt Eval",
    `Provider:                ${report.metadata.provider ?? "codex"}`,
    `CLI:                     ${report.metadata.codexVersion}`,
    `Model/reasoning:         ${report.metadata.model} / ${report.metadata.reasoningEffort}`,
  ];
  for (const tier of report.tiers) {
    lines.push(
      "",
      `Tier ${tier.tier}: ${formatWorkload(tier)}`,
      `Runs:                     ${tier.runs}`,
      `Measurable runs:          ${tier.measurableRuns}/${tier.runs}`,
      `Valid replies:            ${tier.validReplies}/${tier.runs}`,
      `Median tokens:            ${tier.medianTokens ?? "unavailable"}`,
      `P95 tokens: ${tier.p95Tokens ?? "unavailable"}`,
    );
  }
  lines.push("", `Result:                  ${report.result}`);
  return lines.join("\n");
}

export async function readCodexVersion(config, { env = process.env, provider = PROVIDERS.codex } = {}) {
  return new Promise((resolve) => {
    const executable = config[provider.executableKey];
    const child = spawn(executable, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-500);
    });
    child.on("error", () => resolve("unknown"));
    child.on("close", (code) => resolve(code === 0 ? (output.trim() || "unknown") : "unknown"));
  });
}

function buildTierReport({ tier, samples, promptCharacters, provider = PROVIDERS.codex }) {
  const definition = provider.tiers[tier];
  const measurable = samples.filter((sample) => sample.ok && Number.isFinite(sample.usage?.totalTokens));
  const totals = measurable.map((sample) => sample.usage.totalTokens);
  const validReplies = samples.filter((sample) => sample.ok
    && Number.isFinite(sample.usage?.outputTokens)
    && sample.usage.outputTokens >= definition.outputWords).length;
  const passed = measurable.length === samples.length && validReplies === samples.length;
  return {
    tier: tier + 1,
    outputWords: definition.outputWords,
    reasoningEffort: definition.reasoningEffort,
    promptCharacters,
    runs: samples.length,
    measurableRuns: measurable.length,
    validReplies,
    medianTokens: percentile(totals, 50),
    p95Tokens: percentile(totals, 95),
    result: passed ? "PASS" : "FAIL",
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

function formatWorkload(tier) {
  const words = `${tier.outputWords} output ${tier.outputWords === 1 ? "word" : "words"}`;
  return tier.reasoningEffort ? `${words} / ${tier.reasoningEffort} reasoning` : words;
}

export function percentile(values, rank) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1);
  return sorted[index];
}
