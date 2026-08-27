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
      evalReport: path.join(override, "eval-latest.json"),
    };
  }

  const configRoot = env.XDG_CONFIG_HOME || path.join(home, ".config");
  const stateRoot = env.XDG_STATE_HOME || path.join(home, ".local", "state");

  return {
    root: path.join(stateRoot, "gudmo"),
    config: path.join(configRoot, "gudmo", "config.json"),
    state: path.join(stateRoot, "gudmo", "state.json"),
    lock: path.join(stateRoot, "gudmo", "run.lock"),
    evalReport: path.join(stateRoot, "gudmo", "eval-latest.json"),
  };
}
