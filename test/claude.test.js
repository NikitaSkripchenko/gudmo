import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildClaudeArgs, parseClaudeResult, runClaude } from "../src/claude.js";
import { buildClaudeUsageArgs, readClaudeRateLimits } from "../src/claude-usage.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

const SUCCESS = {
  subtype: "success",
  is_error: false,
  result: "DONE",
  usage: { input_tokens: 2, cache_read_input_tokens: 33_592, output_tokens: 5 },
};

test("buildClaudeArgs runs headless without touching user settings or sessions", () => {
  const args = buildClaudeArgs({ ...DEFAULT_CONFIG, message: "production prompt" });

  assert.ok(args.includes("--print"));
  assert.deepEqual(args.slice(1, 4), ["--output-format", "json", "--no-session-persistence"]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), ["--setting-sources", ""]);
  assert.deepEqual(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2), ["--permission-mode", "manual"]);
  assert.equal(args.at(-1), "production prompt");
  assert.equal(args.includes("--model"), false);
});

test("buildClaudeArgs uses the Claude-specific model, never the Codex one", () => {
  const args = buildClaudeArgs({
    ...DEFAULT_CONFIG,
    message: "production prompt",
    model: "gpt-codex",
    claudeModel: "sonnet",
  });

  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "sonnet"]);
  assert.equal(args.includes("gpt-codex"), false);
});

test("buildClaudeUsageArgs reads usage without persisting a session", () => {
  assert.deepEqual(buildClaudeUsageArgs(), [
    "--print",
    "--output-format",
    "json",
    "--no-session-persistence",
    "/usage",
  ]);
});

test("parseClaudeResult extracts the reply and token usage", () => {
  const parsed = parseClaudeResult(JSON.stringify(SUCCESS));

  assert.deepEqual(parsed, {
    reply: "DONE",
    minimalReply: true,
    usage: { inputTokens: 2, cachedInputTokens: 33_592, outputTokens: 5, totalTokens: 7 },
  });
});

test("parseClaudeResult rejects failed turns and unmeasurable usage", () => {
  assert.throws(() => parseClaudeResult("not json"), /not valid JSON/);
  assert.throws(
    () => parseClaudeResult(JSON.stringify({ subtype: "error_max_turns", is_error: true, result: "stopped" })),
    /did not complete the turn/,
  );
  assert.throws(
    () => parseClaudeResult(JSON.stringify({ ...SUCCESS, usage: { input_tokens: 2 } })),
    /token usage/,
  );
});

test("runClaude executes the configured binary without a live request", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-claude-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-claude");
  await fs.writeFile(executable, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(SUCCESS)}\nJSON\n`, { mode: 0o700 });

  const result = await runClaude({ ...DEFAULT_CONFIG, message: "production prompt", claudePath: executable });

  assert.equal(result.ok, true);
  assert.equal(result.reply, "DONE");
  assert.equal(result.usage.totalTokens, 7);
});

test("runClaude reports a non-zero exit as a failed attempt", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-claude-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-claude");
  await fs.writeFile(executable, '#!/bin/sh\necho "credit balance is too low" >&2\nexit 1\n', { mode: 0o700 });

  const result = await runClaude({ ...DEFAULT_CONFIG, message: "prompt", claudePath: executable });

  assert.equal(result.ok, false);
  assert.match(result.error, /credit balance/);
});

test("readClaudeRateLimits turns a live usage report into comparable windows", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-claude-usage-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-claude");
  const payload = JSON.stringify({
    subtype: "success",
    is_error: false,
    result: "Current session: 12% used · resets Sep 15 at 10pm (UTC)",
  });
  await fs.writeFile(executable, `#!/bin/sh\ncat <<'JSON'\n${payload}\nJSON\n`, { mode: 0o700 });

  const snapshot = await readClaudeRateLimits({ ...DEFAULT_CONFIG, claudePath: executable });

  assert.equal(snapshot.windows[0].durationMinutes, 300);
  assert.match(snapshot.windows[0].resetsAt, /T22:00:00\.000Z$/);
});

test("readClaudeRateLimits fails closed when the CLI errors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-claude-usage-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-claude");
  await fs.writeFile(executable, '#!/bin/sh\necho "not logged in" >&2\nexit 1\n', { mode: 0o700 });

  await assert.rejects(
    readClaudeRateLimits({ ...DEFAULT_CONFIG, claudePath: executable }),
    /not logged in/,
  );
});
