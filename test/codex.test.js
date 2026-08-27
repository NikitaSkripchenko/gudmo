import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexArgs, parseCodexEvents, runCodex } from "../src/codex.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

test("buildCodexArgs creates a minimal, ephemeral, read-only run", () => {
  const args = buildCodexArgs({ ...DEFAULT_CONFIG, message: "production prompt" }, "/tmp");

  assert.deepEqual(args.slice(0, 5), [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
  ]);
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes("--json"));
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.equal(args.at(-1), "production prompt");
  assert.equal("message" in DEFAULT_CONFIG, false);
});

test("parseCodexEvents extracts the final reply and conservative token total", () => {
  const parsed = parseCodexEvents([
    JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
    JSON.stringify({ type: "item.completed", item: { id: "item-1", type: "agent_message", text: "OK" } }),
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1_200, cached_input_tokens: 1_000, output_tokens: 2 },
    }),
  ].join("\n"));

  assert.deepEqual(parsed, {
    reply: "OK",
    minimalReply: true,
    usage: { inputTokens: 1_200, cachedInputTokens: 1_000, outputTokens: 2, totalTokens: 1_202 },
  });
});

test("parseCodexEvents rejects successful output without measurable usage", () => {
  assert.throws(
    () => parseCodexEvents(JSON.stringify({
      type: "item.completed",
      item: { id: "item-1", type: "agent_message", text: "OK" },
    })),
    /token usage/,
  );
});

test("parseCodexEvents normalizes slash-method Codex event envelopes", () => {
  const parsed = parseCodexEvents([
    JSON.stringify({
      method: "item/completed",
      params: { item: { id: "item-1", type: "agent_message", text: "OK" } },
    }),
    JSON.stringify({
      method: "turn/completed",
      params: { usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 1 } },
    }),
  ].join("\n"));

  assert.equal(parsed.reply, "OK");
  assert.equal(parsed.usage.totalTokens, 21);
});

test("isolated runs force file-backed credentials", () => {
  const args = buildCodexArgs(DEFAULT_CONFIG, "/tmp", { account: { isolated: true } });
  assert.ok(args.includes('cli_auth_credentials_store="file"'));
});

test("runCodex executes the configured binary without a live request", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-codex-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, `#!/bin/sh
printf '%s\\n' \\
  '{"type":"item.completed","item":{"id":"item-1","type":"agent_message","text":"OK"}}' \\
  '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":8,"output_tokens":1}}'
`, { mode: 0o700 });

  const result = await runCodex({ ...DEFAULT_CONFIG, message: "production prompt", codexPath: executable });

  assert.equal(result.ok, true);
  assert.equal(result.reply, "OK");
  assert.equal(result.usage.totalTokens, 11);
});

test("runCodex confines authentication to the supplied CODEX_HOME", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-codex-env-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, `#!/bin/sh
printf '%s\\n' \\
  "{\\"type\\":\\"item.completed\\",\\"item\\":{\\"id\\":\\"item-1\\",\\"type\\":\\"agent_message\\",\\"text\\":\\"$CODEX_HOME\\"}}" \\
  '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":8,"output_tokens":1}}'
`, { mode: 0o700 });

  const result = await runCodex(
    { ...DEFAULT_CONFIG, message: "production prompt", codexPath: executable },
    { env: { ...process.env, CODEX_HOME: path.join(root, "isolated") } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.reply, path.join(root, "isolated"));
});
