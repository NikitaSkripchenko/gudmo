import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCodexArgs, runCodex } from "../src/codex.js";
import { DEFAULT_CONFIG } from "../src/constants.js";

test("buildCodexArgs creates a minimal, ephemeral, read-only run", () => {
  const args = buildCodexArgs(DEFAULT_CONFIG, "/tmp");

  assert.deepEqual(args.slice(0, 5), [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
  ]);
  assert.ok(args.includes("read-only"));
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.equal(args.at(-1), "gudmo");
});

test("isolated runs force file-backed credentials", () => {
  const args = buildCodexArgs(DEFAULT_CONFIG, "/tmp", { account: { isolated: true } });
  assert.ok(args.includes('cli_auth_credentials_store="file"'));
});

test("runCodex executes the configured binary without a live request", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-codex-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, "#!/bin/sh\nprintf 'fake reply'\n", { mode: 0o700 });

  const result = await runCodex({ ...DEFAULT_CONFIG, codexPath: executable });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "fake reply");
});

test("runCodex confines authentication to the supplied CODEX_HOME", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-codex-env-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "fake-codex");
  await fs.writeFile(executable, "#!/bin/sh\nprintf '%s' \"$CODEX_HOME\"\n", { mode: 0o700 });

  const result = await runCodex(
    { ...DEFAULT_CONFIG, codexPath: executable },
    { env: { ...process.env, CODEX_HOME: path.join(root, "isolated") } },
  );

  assert.equal(result.ok, true);
  assert.equal(result.stdout, path.join(root, "isolated"));
});
