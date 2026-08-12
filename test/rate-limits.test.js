import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/constants.js";
import { normalizeRateLimits, readAccountRateLimits } from "../src/rate-limits.js";

const RESPONSE = {
  rateLimits: { limitId: "codex", primary: null, secondary: null },
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: 1_787_038_006 },
      secondary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_786_453_200 },
    },
  },
};

test("normalizeRateLimits extracts reset timestamps from every server window", () => {
  const result = normalizeRateLimits(RESPONSE, "2026-08-11T00:00:00.000Z");

  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows.map((window) => window.durationMinutes), [10_080, 300]);
  assert.equal(result.windows[0].resetsAt, "2026-08-18T07:26:46.000Z");
  assert.equal(result.windows[1].usedPercent, 20);
});

test("readAccountRateLimits speaks JSON-RPC inside an isolated CODEX_HOME", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-rate-limit-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  const isolatedHome = path.join(root, "isolated-codex-home");
  const response = JSON.stringify({ id: 2, result: RESPONSE });
  await fs.writeFile(executable, `#!/usr/bin/env node
if (process.env.CODEX_HOME !== ${JSON.stringify(isolatedHome)} || !process.argv.includes('cli_auth_credentials_store="file"')) {
  process.exit(9);
}
process.stdin.resume();
process.stdin.once("data", () => {
  process.stdout.write(${JSON.stringify(`${response}\n`)});
});
`, { mode: 0o700 });

  const result = await readAccountRateLimits(
    { ...DEFAULT_CONFIG, codexPath: executable },
    { env: { ...process.env, CODEX_HOME: isolatedHome }, account: { isolated: true } },
  );

  assert.equal(result.windows.length, 2);
  assert.equal(result.windows[1].durationMinutes, 300);
});

test("readAccountRateLimits rejects an unbounded unterminated response", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-rate-limit-bound-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.once("data", () => process.stdout.write("x".repeat(65 * 1024)));
`, { mode: 0o700 });

  await assert.rejects(
    readAccountRateLimits({ ...DEFAULT_CONFIG, codexPath: executable }),
    /exceeded 64 KiB/,
  );
});
