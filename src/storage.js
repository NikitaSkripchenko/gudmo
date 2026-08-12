import fs from "node:fs/promises";
import path from "node:path";

export const MAX_LOG_BYTES = 1 * 1_024 * 1_024;

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

export async function appendLog(file, entry, { maxBytes = MAX_LOG_BYTES } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify(entry)}\n`;
  const size = await fs.stat(file).then((stat) => stat.size).catch((error) => {
    if (error?.code === "ENOENT") return 0;
    throw error;
  });
  if (size > 0 && size + Buffer.byteLength(line, "utf8") > maxBytes) {
    const archive = `${file}.1`;
    await fs.rm(archive, { force: true });
    await fs.rename(file, archive).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
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
      const stat = await fs.stat(lockPath).catch(() => null);
      if (!stat || Date.now() - stat.mtimeMs <= staleAfterMs || attempt > 0) return null;
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }

  return null;
}
