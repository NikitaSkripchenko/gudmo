import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { accountSnapshotKey, discoverAccounts, prepareAccount } from "../src/accounts.js";
import { getPaths } from "../src/paths.js";

test("codex-auth accounts get stable snapshot paths and private runtimes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-accounts-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sourceDir = path.join(home, ".codex", "accounts");
  const gudmoHome = path.join(home, "gudmo");
  await fs.mkdir(sourceDir, { recursive: true });
  const key = "user::account";
  const sourcePath = path.join(sourceDir, `${accountSnapshotKey(key)}.auth.json`);
  await fs.writeFile(sourcePath, '{"tokens":{"access_token":"source-one"}}\n', { mode: 0o600 });
  await fs.writeFile(path.join(sourceDir, "registry.json"), JSON.stringify({
    schema_version: 4,
    active_account_key: key,
    accounts: [{ account_key: key, email: "person@example.com", alias: "work" }],
  }));

  const paths = getPaths({ GUDMO_HOME: gudmoHome, HOME: home });
  const [account] = await discoverAccounts({ paths, env: { GUDMO_HOME: gudmoHome, HOME: home } });
  await prepareAccount(account);
  const runtimeAuth = path.join(account.paths.codexHome, "auth.json");

  assert.equal(account.label, "work");
  assert.equal(account.sourceAuthPath, sourcePath);
  assert.notEqual(account.paths.state, paths.state);
  assert.equal(account.codexEnv.CODEX_HOME, account.paths.codexHome);
  assert.match(await fs.readFile(runtimeAuth, "utf8"), /source-one/);
  assert.equal((await fs.stat(runtimeAuth)).mode & 0o777, 0o600);

  await fs.writeFile(runtimeAuth, '{"tokens":{"access_token":"refreshed-private"}}\n', { mode: 0o600 });
  await prepareAccount(account);
  assert.match(await fs.readFile(runtimeAuth, "utf8"), /refreshed-private/);

  await fs.writeFile(sourcePath, '{"tokens":{"access_token":"source-two"}}\n', { mode: 0o600 });
  await prepareAccount(account);
  assert.match(await fs.readFile(runtimeAuth, "utf8"), /source-two/);
});

test("snapshot filenames match codex-auth URL-safe base64 rules", () => {
  assert.equal(accountSnapshotKey("safe.key-1"), "safe.key-1");
  assert.equal(accountSnapshotKey("user::account"), Buffer.from("user::account").toString("base64url"));
  assert.equal(accountSnapshotKey(".."), Buffer.from("..").toString("base64url"));
});

test("account discovery rejects registries beyond the account safety limit", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-account-limit-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sourceDir = path.join(home, ".codex", "accounts");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "registry.json"), JSON.stringify({
    schema_version: 4,
    accounts: Array.from({ length: 101 }, (_, index) => ({ account_key: `account-${index}` })),
  }));

  await assert.rejects(
    discoverAccounts({ paths: getPaths({ GUDMO_HOME: path.join(home, "gudmo") }), env: { HOME: home } }),
    /100-account safety limit/,
  );
});
