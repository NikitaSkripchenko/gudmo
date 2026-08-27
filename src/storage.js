import fs from "node:fs/promises";
import path from "node:path";

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${file}: ${error.message}`);
    }
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  return writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomic(file, value, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, value, {
      encoding: "utf8",
      mode,
    });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function acquireLock(lockPath, { staleAfterMs = 10 * 60 * 1_000 } = {}) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }));
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readJson(path.join(lockPath, "owner.json"), null).catch(() => null);
      if (isDeadProcess(owner?.pid)) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs <= staleAfterMs || attempt > 0) return null;
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  return null;
}

function isDeadProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}
