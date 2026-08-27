import assert from "node:assert/strict";
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
