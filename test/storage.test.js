import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendLog } from "../src/storage.js";

test("structured activity logs rotate at their configured size bound", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-storage-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, "gudmo.log");

  await appendLog(log, { event: "first", detail: "x".repeat(80) }, { maxBytes: 100 });
  await appendLog(log, { event: "second", detail: "y".repeat(80) }, { maxBytes: 100 });

  assert.match(await fs.readFile(`${log}.1`, "utf8"), /"first"/);
  assert.match(await fs.readFile(log, "utf8"), /"second"/);
});
