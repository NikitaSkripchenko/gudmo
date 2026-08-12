import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJson, writeJsonAtomic, writeTextAtomic } from "./storage.js";

const MIN_REGISTRY_SCHEMA = 2;
const MAX_REGISTRY_SCHEMA = 4;
const MAX_REGISTRY_BYTES = 1 * 1_024 * 1_024;
const MAX_AUTH_SNAPSHOT_BYTES = 1 * 1_024 * 1_024;
const MAX_ACCOUNTS = 100;

export async function discoverAccounts({ paths, env = process.env } = {}) {
  const sourceCodexHome = env.CODEX_HOME || path.join(env.HOME || os.homedir(), ".codex");
  const registryPath = path.join(sourceCodexHome, "accounts", "registry.json");
  const registryStat = await fs.stat(registryPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (registryStat && registryStat.size > MAX_REGISTRY_BYTES) {
    throw new Error(`codex-auth registry exceeds 1 MiB: ${registryPath}`);
  }
  const registry = await readJson(registryPath, null);

  if (registry === null) {
    return [{
      key: "active",
      label: "active account",
      email: null,
      isolated: false,
      sourceAuthPath: null,
      paths,
      codexEnv: env,
    }];
  }

  if (!Number.isInteger(registry.schema_version)
    || registry.schema_version < MIN_REGISTRY_SCHEMA
    || registry.schema_version > MAX_REGISTRY_SCHEMA
    || !Array.isArray(registry.accounts)) {
    throw new Error(`Unsupported codex-auth registry schema in ${registryPath}`);
  }
  if (registry.accounts.length > MAX_ACCOUNTS) {
    throw new Error(`codex-auth registry exceeds the ${MAX_ACCOUNTS}-account safety limit`);
  }

  const accounts = registry.accounts.map((record) => {
    if (!record || typeof record.account_key !== "string" || !record.account_key) {
      throw new Error(`Invalid codex-auth account record in ${registryPath}`);
    }
    const accountPaths = getAccountPaths(paths, record.account_key);
    return {
      key: record.account_key,
      label: record.alias || record.email || record.account_key,
      email: record.email || null,
      isolated: true,
      sourceAuthPath: path.join(
        sourceCodexHome,
        "accounts",
        `${accountSnapshotKey(record.account_key)}.auth.json`,
      ),
      paths: accountPaths,
      codexEnv: { ...env, CODEX_HOME: accountPaths.codexHome },
    };
  });

  if (accounts.length === 0) throw new Error(`No accounts found in ${registryPath}`);
  return accounts;
}

export async function prepareAccount(account) {
  if (!account.isolated) return account;

  const sourceStat = await fs.stat(account.sourceAuthPath).catch((error) => {
    if (error?.code === "ENOENT") {
      throw new Error(`Missing codex-auth snapshot for ${account.label}: ${account.sourceAuthPath}`);
    }
    throw error;
  });
  if (sourceStat.size > MAX_AUTH_SNAPSHOT_BYTES) {
    throw new Error(`codex-auth snapshot exceeds 1 MiB for ${account.label}`);
  }
  const sourceText = await fs.readFile(account.sourceAuthPath, "utf8");
  try {
    JSON.parse(sourceText);
  } catch (error) {
    throw new Error(`Invalid codex-auth snapshot for ${account.label}: ${error.message}`);
  }

  const sourceDigest = crypto.createHash("sha256").update(sourceText).digest("hex");
  const metadataPath = path.join(account.paths.codexHome, ".gudmo-source.json");
  const runtimeAuthPath = path.join(account.paths.codexHome, "auth.json");
  const metadata = await readJson(metadataPath, null);
  const runtimeExists = await fs.access(runtimeAuthPath).then(() => true).catch(() => false);

  await fs.mkdir(account.paths.codexHome, { recursive: true, mode: 0o700 });
  await fs.chmod(account.paths.codexHome, 0o700);
  if (!runtimeExists || metadata?.sourceDigest !== sourceDigest) {
    await writeTextAtomic(runtimeAuthPath, sourceText.endsWith("\n") ? sourceText : `${sourceText}\n`, 0o600);
    await writeJsonAtomic(metadataPath, { sourceDigest });
  }
  await fs.chmod(runtimeAuthPath, 0o600);
  await writeTextAtomic(
    path.join(account.paths.codexHome, "config.toml"),
    'cli_auth_credentials_store = "file"\n',
    0o600,
  );
  return account;
}

export function accountSnapshotKey(accountKey) {
  if (accountKey && accountKey !== "." && accountKey !== ".." && /^[A-Za-z0-9._-]+$/.test(accountKey)) {
    return accountKey;
  }
  return Buffer.from(accountKey).toString("base64url");
}

export function getAccountPaths(paths, accountKey) {
  const id = crypto.createHash("sha256").update(accountKey).digest("hex").slice(0, 24);
  const root = path.join(paths.root, "accounts", id);
  return {
    ...paths,
    root,
    config: paths.config,
    state: path.join(root, "state.json"),
    lock: path.join(root, "run.lock"),
    log: path.join(root, "gudmo.log"),
    codexHome: path.join(root, "codex-home"),
  };
}
