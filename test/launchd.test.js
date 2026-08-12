import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/constants.js";
import { generateLaunchAgent, getLaunchAgentStatus, SCHEDULER_LOOP } from "../src/launchd.js";

test("launch agent is AC-only, low-memory, background-priority, and log-bounded", () => {
  const plist = generateLaunchAgent({
    config: DEFAULT_CONFIG,
    paths: { schedulerLog: "/tmp/unused-scheduler.log" },
    env: { HOME: "/Users/example", PATH: "/usr/bin:/bin" },
    nodePath: "/usr/bin/node",
  });

  assert.match(plist, /<string>\/usr\/bin\/caffeinate<\/string>/);
  assert.match(plist, /<string>-s<\/string>/);
  assert.doesNotMatch(plist, /<string>-i<\/string>/);
  assert.match(plist, /<string>\/bin\/sh<\/string>/);
  assert.match(plist, /<string>-c<\/string>/);
  assert.match(plist, /gudmo-scheduler/);
  assert.match(plist, /tail -c 65536/);
  assert.doesNotMatch(plist, /gudmo-loop\.sh/);
  assert.doesNotMatch(plist, /<string>daemon<\/string>/);
  assert.doesNotMatch(plist, /StartInterval/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>60<\/integer>/);
  assert.match(plist, /<key>Nice<\/key>\s*<integer>10<\/integer>/);
  assert.match(plist, /<key>LowPriorityIO<\/key>\s*<true\/>/);
  assert.match(plist, /<key>StandardOutPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key>\s*<string>\/dev\/null<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
});

test("embedded scheduler loop is valid POSIX shell", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-loop-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "loop.sh");
  await fs.writeFile(file, SCHEDULER_LOOP);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync("/bin/sh", ["-n", file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("configured and loaded scheduler states are reported separately", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gudmo-launchd-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const launchAgent = path.join(root, "agent.plist");
  await fs.writeFile(launchAgent, "plist");

  const status = await getLaunchAgentStatus({ launchAgent }, { platform: "linux" });

  assert.deepEqual(status, { configured: true, loaded: false });
});
