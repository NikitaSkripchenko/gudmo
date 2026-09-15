import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig } from "../src/config.js";
import { getPaths } from "../src/paths.js";
import {
  buildClaudeVerification,
  getProvider,
  parseProviderSelection,
  PROVIDER_IDS,
  PROVIDERS,
} from "../src/providers.js";
import { renewFiveHourWindow } from "../src/scheduler.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const START = Date.parse("2026-08-27T00:00:00.000Z");

test("every provider id resolves to a complete renewal descriptor", () => {
  assert.deepEqual(PROVIDER_IDS, ["codex", "claude"]);
  for (const id of PROVIDER_IDS) {
    const provider = getProvider(id);
    assert.equal(provider.id, id);
    assert.equal(typeof provider.runner, "function");
    assert.equal(typeof provider.verifier, "function");
    assert.equal(typeof provider.verify, "function");
    assert.equal(typeof provider.buildPrompt, "function");
    assert.ok(provider.tiers.length >= 1);
  }
  assert.throws(() => getProvider("gemini"), /unknown provider/);
});

test("provider selection accepts each id plus all, and rejects anything else", () => {
  assert.deepEqual(parseProviderSelection("all"), ["codex", "claude"]);
  assert.deepEqual(parseProviderSelection("claude"), ["claude"]);
  assert.deepEqual(parseProviderSelection("codex"), ["codex"]);
  assert.throws(() => parseProviderSelection("gpt"), /--provider must be one of/);
});

test("claude renewal needs one minimal tier, not the Codex essay", () => {
  const prompt = PROVIDERS.claude.buildPrompt({
    tier: 0,
    nonce: "nonce-a",
    tiers: PROVIDERS.claude.tiers,
  });

  assert.equal(PROVIDERS.claude.tiers.length, 1);
  assert.match(prompt.message, /Renewal nonce: nonce-a\./);
  assert.match(prompt.message, /exactly one word: DONE/);
  assert.equal(prompt.message.includes("256 words"), false);
  assert.throws(
    () => PROVIDERS.claude.buildPrompt({ tier: 1, nonce: "n", tiers: PROVIDERS.claude.tiers }),
    /tier/,
  );
});

test("a five-hour window present after the prompt is claude renewal evidence", () => {
  const result = buildClaudeVerification({
    beforeWindows: [],
    afterWindows: [windowAt("2026-08-27T05:00:00.000Z")],
    beforeCheckedAt: "2026-08-27T00:00:00.000Z",
    checkedAt: "2026-08-27T00:01:00.000Z",
  });

  assert.equal(result.status, "renewed");
  assert.equal(result.beforeResetsAt, null);
  assert.equal(result.afterResetsAt, "2026-08-27T05:00:00.000Z");
  assert.equal(result.observationSeconds, 60);
});

test("claude verification never calls a missing or expired window a success", () => {
  assert.equal(buildClaudeVerification({
    afterWindows: [],
    beforeCheckedAt: "2026-08-27T00:00:00.000Z",
    checkedAt: "2026-08-27T00:01:00.000Z",
  }).status, "unavailable");

  assert.equal(buildClaudeVerification({
    afterWindows: [windowAt("2026-08-26T23:00:00.000Z")],
    beforeCheckedAt: "2026-08-27T00:00:00.000Z",
    checkedAt: "2026-08-27T00:01:00.000Z",
  }).status, "unavailable");

  assert.equal(buildClaudeVerification({
    afterWindows: [{ durationMinutes: 10_080, resetsAt: "2026-09-03T00:00:00.000Z" }],
    beforeCheckedAt: "2026-08-27T00:00:00.000Z",
    checkedAt: "2026-08-27T00:01:00.000Z",
  }).status, "unavailable");
});

test("an active claude window is skipped without spending a prompt", async (t) => {
  const paths = await setup(t);
  let sends = 0;

  const result = await renewFiveHourWindow({
    paths,
    clock: () => START,
    ...claudeWiring(),
    runner: async () => { sends += 1; return successfulClaudeResult(); },
    verifier: async () => ({
      fetchedAt: new Date(START).toISOString(),
      windows: [windowAt(new Date(START + 4 * HOUR).toISOString())],
    }),
  });

  assert.equal(result.status, "active");
  assert.equal(sends, 0);
});

test("claude renewal sends one prompt and verifies the window it anchored", async (t) => {
  const paths = await setup(t);
  let now = START;
  const messages = [];

  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    nonceFactory: () => "nonce-claude",
    verificationDelayMs: MINUTE,
    verificationMaxWaitMs: 0,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async () => {},
    ...claudeWiring(),
    runner: async (config) => { messages.push(config.message); return successfulClaudeResult(); },
    verifier: async () => ({
      fetchedAt: new Date(now).toISOString(),
      // No window before the prompt; the prompt starts one that ends on the hour.
      windows: messages.length === 0 ? [] : [windowAt(new Date(START + 5 * HOUR).toISOString())],
    }),
  });

  assert.equal(result.status, "renewed");
  assert.equal(result.attempts, 1);
  assert.equal(result.tier, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /nonce-claude/);
});

test("claude renewal stays unverified when no window ever appears", async (t) => {
  const paths = await setup(t);
  let now = START;
  let sends = 0;

  const result = await renewFiveHourWindow({
    paths,
    clock: () => now,
    verificationDelayMs: MINUTE,
    verificationMaxWaitMs: 0,
    verificationWaiter: async (delay) => { now += delay; },
    retryWaiter: async (delay) => { now += delay; },
    ...claudeWiring(),
    runner: async () => { sends += 1; return successfulClaudeResult(); },
    verifier: async () => ({ fetchedAt: new Date(now).toISOString(), windows: [] }),
  });

  assert.equal(result.status, "unverified");
  assert.equal(sends, 1);
  assert.match(result.error, /unavailable/);
});

function claudeWiring() {
  return {
    tiers: PROVIDERS.claude.tiers,
    buildPrompt: PROVIDERS.claude.buildPrompt,
    verify: PROVIDERS.claude.verify,
  };
}

function successfulClaudeResult() {
  return {
    ok: true,
    code: 0,
    reply: "DONE",
    minimalReply: true,
    usage: { inputTokens: 2, cachedInputTokens: 30_000, outputTokens: 5, totalTokens: 7 },
  };
}

function windowAt(resetsAt) {
  return { limitId: "five_hour", kind: "primary", durationMinutes: 300, resetsAt, usedPercent: 4 };
}

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-providers-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = getPaths({ GUDMO_HOME: root });
  await ensureConfig(paths.config);
  return paths;
}
