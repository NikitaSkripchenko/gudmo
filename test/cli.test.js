import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/cli.js";

test("status initializes an isolated home and reports both manual windows due", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-cli-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const output = [];

  const code = await main(["status", "--json"], {
    env: { GUDMO_HOME: root, HOME: root },
    out: (line) => output.push(line),
    err: (line) => output.push(line),
  });
  const status = JSON.parse(output.join("\n"));

  assert.equal(code, 0);
  assert.equal(status.accountMode, "active");
  assert.equal(status.accounts.length, 1);
  assert.deepEqual(status.accounts[0].manualTickDueNow, ["5h", "7d"]);
  assert.equal(status.schedulerConfigured, false);
  assert.equal(typeof status.schedulerRunning, "boolean");
});
