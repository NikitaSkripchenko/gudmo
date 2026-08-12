import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig, loadConfig } from "../src/config.js";

test("ensureConfig creates and loads defaults", async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, "config.json");
  const config = await ensureConfig(file);

  assert.equal(config.message, "gudmo");
  assert.deepEqual(config.enabledWindows, ["5h", "7d"]);
  assert.equal(config.reasoningEffort, "low");
  assert.equal(config.maxIntervalSeconds, 18_000);
});

test("loadConfig rejects invalid window names", async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, "config.json");
  await fs.writeFile(file, JSON.stringify({ enabledWindows: ["monthly"] }));

  await assert.rejects(loadConfig(file), /only contain 5h and 7d/);
});

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
