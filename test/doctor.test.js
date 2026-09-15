import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runDoctor } from "../src/doctor.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

test("doctor checks manual renewal requirements without launchd or caffeinate", async () => {
  const result = await runDoctor(DEFAULT_CONFIG, {
    platform: "darwin",
    accounts: [],
    runner: async (_command, args) => ({
      ok: true,
      output: args[0] === "--version" ? "codex-cli test" : "Logged in using ChatGPT",
      error: null,
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map(({ name }) => name), [
    "platform",
    "node",
    "codex",
    "authentication",
  ]);
});

test("doctor accepts valid isolated account snapshots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-doctor-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const snapshot = path.join(root, "account.auth.json");
  await fs.writeFile(snapshot, JSON.stringify({ auth_mode: "chatgpt", tokens: {} }));

  const result = await runDoctor(DEFAULT_CONFIG, {
    platform: "darwin",
    accounts: [{ isolated: true, label: "account", sourceAuthPath: snapshot }],
    runner: async () => ({ ok: true, output: "codex-cli test", error: null }),
  });

  assert.equal(result.checks.find(({ name }) => name === "authentication").ok, true);
});

test("doctor verifies the Claude CLI and its subscription login", async () => {
  const calls = [];
  const result = await runDoctor(DEFAULT_CONFIG, {
    platform: "darwin",
    accounts: [],
    providers: ["claude"],
    runner: async (command, args) => {
      calls.push([command, ...args]);
      return {
        ok: true,
        output: args[0] === "--version"
          ? "2.1.270 (Claude Code)"
          : JSON.stringify({ result: "You are currently using your subscription to power your Claude Code usage" }),
        error: null,
      };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.checks.map(({ name }) => name), [
    "platform",
    "node",
    "claude",
    "claude-authentication",
  ]);
  assert.equal(calls.every(([command]) => command === DEFAULT_CONFIG.claudePath), true);
  assert.ok(calls.at(-1).includes("/usage"));
});

test("doctor fails Claude authentication without subscription usage", async () => {
  const result = await runDoctor(DEFAULT_CONFIG, {
    platform: "darwin",
    accounts: [],
    providers: ["claude"],
    runner: async (_command, args) => ({
      ok: true,
      output: args[0] === "--version"
        ? "2.1.270 (Claude Code)"
        : JSON.stringify({ result: "Using the Anthropic API with an API key" }),
      error: null,
    }),
  });

  assert.equal(result.ok, false);
  assert.match(result.checks.find(({ name }) => name === "claude-authentication").detail, /subscription login is required/);
});

test("doctor checks both providers when both are selected", async () => {
  const result = await runDoctor(DEFAULT_CONFIG, {
    platform: "darwin",
    accounts: [],
    providers: ["codex", "claude"],
    runner: async (_command, args) => ({
      ok: true,
      output: args[0] === "--version"
        ? "cli test"
        : "Logged in using ChatGPT; using your subscription",
      error: null,
    }),
  });

  assert.deepEqual(result.checks.map(({ name }) => name), [
    "platform",
    "node",
    "claude",
    "claude-authentication",
    "codex",
    "authentication",
  ]);
});
