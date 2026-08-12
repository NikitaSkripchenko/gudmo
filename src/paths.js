import os from "node:os";
import path from "node:path";

export function getPaths(env = process.env) {
  const home = env.HOME || os.homedir();
  const override = env.GUDMO_HOME;

  if (override) {
    return {
      root: override,
      config: path.join(override, "config.json"),
      state: path.join(override, "state.json"),
      lock: path.join(override, "run.lock"),
      log: path.join(override, "gudmo.log"),
      schedulerLog: path.join(override, "scheduler.log"),
      launchAgent: path.join(override, `${env.GUDMO_LAUNCHD_LABEL || "dev.gudmo.renew"}.plist`),
    };
  }

  const configRoot = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const stateRoot = env.XDG_STATE_HOME || path.join(home, ".local", "state");

  return {
    root: path.join(stateRoot, "gudmo"),
    config: path.join(configRoot, "gudmo", "config.json"),
    state: path.join(stateRoot, "gudmo", "state.json"),
    lock: path.join(stateRoot, "gudmo", "run.lock"),
    log: path.join(stateRoot, "gudmo", "gudmo.log"),
    schedulerLog: path.join(stateRoot, "gudmo", "scheduler.log"),
    launchAgent: path.join(home, "Library", "LaunchAgents", "dev.gudmo.renew.plist"),
  };
}
