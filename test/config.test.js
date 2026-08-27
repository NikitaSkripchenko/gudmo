import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConfig, loadConfig } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

test("ensureConfig creates only manual renewal runtime settings", async (t) => {
  const file = path.join(await temporaryDirectory(t), "config.json");
  const config = await ensureConfig(file);

  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), DEFAULT_CONFIG);
});

test("ensureConfig removes legacy scheduler and prompt settings", async (t) => {
  const file = path.join(await temporaryDirectory(t), "config.json");
  await fs.writeFile(file, JSON.stringify({
    message: "legacy",
    enabledWindows: ["5h", "7d"],
    maxRequestsPer24Hours: 5,
    timeoutSeconds: 90,
  }));

  const config = await ensureConfig(file);
  const stored = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(config.timeoutSeconds, 90);
  assert.equal("message" in stored, false);
  assert.equal("enabledWindows" in stored, false);
  assert.equal("maxRequestsPer24Hours" in stored, false);
});

test("loadConfig validates the remaining runtime settings", async (t) => {
  const root = await temporaryDirectory(t);
  const invalidTimeout = path.join(root, "timeout.json");
  const invalidRetry = path.join(root, "retry.json");
  await fs.writeFile(invalidTimeout, JSON.stringify({ timeoutSeconds: 9 }));
  await fs.writeFile(invalidRetry, JSON.stringify({ retrySeconds: 3601 }));

  await assert.rejects(loadConfig(invalidTimeout), /timeoutSeconds/);
  await assert.rejects(loadConfig(invalidRetry), /retrySeconds/);
});

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-config-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
