import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireLock } from "../src/storage.js";

test("a recent lock owned by a dead process is reclaimed immediately", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-dead-lock-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "run.lock");
  await fs.mkdir(lock);
  await fs.writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));

  const release = await acquireLock(lock);

  assert.equal(typeof release, "function");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(lock, "owner.json"), "utf8")), {
    pid: process.pid,
  });
  await release();
});

test("a lock owned by the current process remains protected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-live-lock-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "run.lock");
  const release = await acquireLock(lock);

  assert.equal(await acquireLock(lock), null);
  await release();
});
