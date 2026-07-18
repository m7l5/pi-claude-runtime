import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseVersion, resolveClaudeUpdateCommand } from "../src/maintenance.js";

test("parses and compares Claude Code versions", () => {
  assert.equal(parseVersion("2.1.214 (Claude Code)"), "2.1.214");
  assert.equal(compareVersions("2.1.214", "2.1.215"), -1);
  assert.equal(compareVersions("2.1.214", "2.1.214"), 0);
  assert.equal(compareVersions("2.2.0", "2.1.999"), 1);
});

test("uses Claude's native updater for the native installation", async () => {
  assert.deepEqual(await resolveClaudeUpdateCommand("claude"), {
    command: "claude",
    args: ["update"],
  });
});
