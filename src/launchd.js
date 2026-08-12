import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { LAUNCHD_LABEL } from "./constants.js";
import { writeTextAtomic } from "./storage.js";

const execFileAsync = promisify(execFile);
const CLI_PATH = fileURLToPath(new URL("../bin/gudmo.js", import.meta.url));
export const SCHEDULER_LOOP = `
node_path=$1
cli_path=$2
error_log=$3
temporary_error="$error_log.tmp"

while :; do
  if delay_seconds=$("$node_path" "$cli_path" _cycle 2>"$temporary_error"); then
    : >"$error_log"
  else
    /usr/bin/tail -c 65536 "$temporary_error" >"$error_log"
    delay_seconds=900
  fi
  /bin/rm -f "$temporary_error"
  case "$delay_seconds" in
    ''|*[!0-9]*) delay_seconds=900 ;;
  esac
  /bin/sleep "$delay_seconds"
done
`.trim();

export function generateLaunchAgent({ paths, config, env = process.env, nodePath = process.execPath } = {}) {
  const environment = {
    HOME: env.HOME,
    PATH: env.PATH || "/usr/local/bin:/usr/bin:/bin",
    GUDMO_HOME: env.GUDMO_HOME,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME,
    XDG_STATE_HOME: env.XDG_STATE_HOME,
    CODEX_HOME: env.CODEX_HOME,
  };

  const environmentXml = Object.entries(environment)
    .filter(([, value]) => value)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-s</string>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${xmlEscape(SCHEDULER_LOOP)}</string>
    <string>gudmo-scheduler</string>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(CLI_PATH)}</string>
    <string>${xmlEscape(paths.schedulerLog)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environmentXml}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

export async function installLaunchAgent({ paths, config, env = process.env, start = true } = {}) {
  if (process.platform !== "darwin" && !env.GUDMO_ALLOW_NON_DARWIN) {
    throw new Error("background installation currently supports macOS launchd only");
  }

  await fs.mkdir(paths.root, { recursive: true, mode: 0o700 });
  const plist = generateLaunchAgent({ paths, config, env });
  await writeTextAtomic(paths.launchAgent, plist);
  if (!start) return { path: paths.launchAgent, started: false };

  const domain = `gui/${process.getuid()}`;
  await execFileAsync("launchctl", ["bootout", domain, paths.launchAgent]).catch(() => {});
  try {
    await execFileAsync("launchctl", ["bootstrap", domain, paths.launchAgent]);
  } catch (error) {
    throw new Error(`could not start launch agent: ${commandError(error)}`);
  }
  return { path: paths.launchAgent, started: true };
}

export async function uninstallLaunchAgent({ paths, env = process.env } = {}) {
  if (process.platform === "darwin" || env.GUDMO_ALLOW_NON_DARWIN) {
    const domain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : "gui/0";
    await execFileAsync("launchctl", ["bootout", domain, paths.launchAgent]).catch(() => {});
  }
  const removed = await fs.unlink(paths.launchAgent).then(() => true).catch((error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
  return { path: paths.launchAgent, removed };
}

export async function getLaunchAgentStatus(paths, { platform = process.platform } = {}) {
  const configured = await fs.access(paths.launchAgent).then(() => true).catch(() => false);
  if (platform !== "darwin") return { configured, loaded: false };

  const domain = `gui/${process.getuid()}`;
  const loaded = await execFileAsync("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`])
    .then(() => true)
    .catch(() => false);
  return { configured, loaded };
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function commandError(error) {
  return error?.stderr?.trim() || error?.message || String(error);
}
