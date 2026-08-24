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

  assert.equal(config.message, "Reply only: OK");
  assert.equal(config.maxRequestsPer24Hours, 5);
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

test("ensureConfig upgrades only the legacy default prompt", async (t) => {
  const root = await temporaryDirectory(t);
  const file = path.join(root, "config.json");
  await fs.writeFile(file, JSON.stringify({ message: "gudmo", retrySeconds: 90 }));

  const config = await ensureConfig(file);
  const stored = JSON.parse(await fs.readFile(file, "utf8"));

  assert.equal(config.message, "Reply only: OK");
  assert.equal(config.retrySeconds, 90);
  assert.equal(stored.message, "Reply only: OK");
});

test("loadConfig rejects a request ceiling outside the measurable range", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-config-ceiling-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "config.json");
  await fs.writeFile(file, JSON.stringify({ maxRequestsPer24Hours: 0 }));

  await assert.rejects(loadConfig(file), /maxRequestsPer24Hours must be an integer from 1 to 100/);
});

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
