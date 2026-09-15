import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeClaudeUsage,
  parseResetPhrase,
  readUsageText,
} from "../src/claude-usage.js";

const REPORT = [
  "You are currently using your subscription to power your Claude Code usage",
  "",
  "Current session: 12% used · resets Sep 15 at 10pm (Europe/Kiev)",
  "Current week (all models): 13.5% used · resets Sep 18 at 5am (Europe/Kiev)",
  "",
  "What's contributing to your limits usage?",
  "Last 24h · 294 requests · 4 sessions",
].join("\n");

test("the usage report yields a comparable five-hour window", () => {
  const { windows } = normalizeClaudeUsage(REPORT, {
    fetchedAt: "2026-09-15T17:04:55.000Z",
  });

  assert.deepEqual(windows[0], {
    limitId: "five_hour",
    kind: "primary",
    durationMinutes: 300,
    resetsAt: "2026-09-15T19:00:00.000Z",
    usedPercent: 12,
  });
  assert.equal(windows[1].durationMinutes, 10_080);
  assert.equal(windows[1].usedPercent, 13.5);
});

test("a report without a session line exposes no five-hour window", () => {
  const { windows } = normalizeClaudeUsage([
    "You are currently using your subscription to power your Claude Code usage",
    "Current week (all models): 13% used · resets Sep 18 at 5am (Europe/Kiev)",
  ].join("\n"), { fetchedAt: "2026-09-15T17:04:55.000Z" });

  assert.equal(windows.some((window) => window.durationMinutes === 300), false);
});

test("a session line without a reset keeps the window but no timestamp", () => {
  const { windows } = normalizeClaudeUsage(
    "Current session: 4% used",
    { fetchedAt: "2026-09-15T17:04:55.000Z" },
  );

  assert.equal(windows.length, 1);
  assert.equal(windows[0].resetsAt, null);
  assert.equal(windows[0].usedPercent, 4);
});

test("reset phrases keep minutes, midnight, noon, and explicit years", () => {
  const reference = new Date("2026-09-15T17:00:00.000Z");
  assert.equal(parseResetPhrase("Sep 15 at 10:30pm (UTC)", reference), "2026-09-15T22:30:00.000Z");
  assert.equal(parseResetPhrase("Sep 15 at 12am (UTC)", reference), "2026-09-15T00:00:00.000Z");
  assert.equal(parseResetPhrase("Sep 15 at 12pm (UTC)", reference), "2026-09-15T12:00:00.000Z");
  assert.equal(parseResetPhrase("Jan 2, 2027 at 3am (UTC)", reference), "2027-01-02T03:00:00.000Z");
});

test("a year-less phrase near a year boundary resolves to the nearest year", () => {
  const reference = new Date("2026-12-31T22:00:00.000Z");
  assert.equal(parseResetPhrase("Jan 1 at 2am (UTC)", reference), "2027-01-01T02:00:00.000Z");
});

test("unparseable reset phrases fail closed instead of guessing", () => {
  const reference = new Date("2026-09-15T17:00:00.000Z");
  assert.equal(parseResetPhrase("in about 3 hours", reference), null);
  assert.equal(parseResetPhrase("Xyz 15 at 10pm (UTC)", reference), null);
  assert.equal(parseResetPhrase("Sep 15 at 13pm (UTC)", reference), null);
});

test("an empty or malformed report is rejected rather than reported empty", () => {
  assert.throws(() => normalizeClaudeUsage("", {}), /empty usage report/);
  assert.throws(() => readUsageText("not json"), /not valid JSON/);
  assert.throws(
    () => readUsageText(JSON.stringify({ subtype: "error_during_execution", is_error: true, result: "nope" })),
    /rejected the usage request/,
  );
  assert.throws(
    () => readUsageText(JSON.stringify({ subtype: "success", result: 12 })),
    /did not include a result/,
  );
});

test("the usage payload is read out of the print-mode JSON envelope", () => {
  const text = readUsageText(JSON.stringify({ subtype: "success", is_error: false, result: REPORT }));
  assert.equal(normalizeClaudeUsage(text, { fetchedAt: "2026-09-15T17:04:55.000Z" }).windows.length, 2);
});
