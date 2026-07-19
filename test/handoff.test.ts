import assert from "node:assert/strict";
import test from "node:test";
import { getHandoffRange, needsClaudeHandoff, wrapHandoff } from "../src/handoff.js";

const user = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
}) as any;

const assistant = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "other",
    model: "model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 2,
  },
}) as any;

test("extracts only entries missed after the Claude synchronization cursor", () => {
  const range = getHandoffRange([user("a", "known"), assistant("b", "known"), user("c", "missed")], "b");
  assert.equal(range.divergent, false);
  assert.equal((range.messages[0] as any).content[0].text, "missed");
  assert.equal(range.throughEntryId, "c");
});

test("uses the latest compaction summary as the canonical missed history", () => {
  const branch = [
    user("a", "known"),
    user("b", "old missed"),
    user("c", "kept"),
    {
      type: "compaction",
      id: "d",
      parentId: "c",
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "canonical summary",
      firstKeptEntryId: "c",
      tokensBefore: 100,
    },
    user("e", "new"),
  ] as any;
  const range = getHandoffRange(branch, "a");
  assert.equal((range.messages[0] as any).role, "compactionSummary");
  assert.equal((range.messages[0] as any).summary, "canonical summary");
  assert.equal(range.messages.some((message: any) => message.content?.[0]?.text === "old missed"), false);
  assert.equal(range.messages.some((message: any) => message.content?.[0]?.text === "kept"), true);
});

test("detects a synchronization cursor from another branch", () => {
  assert.equal(getHandoffRange([user("a", "active")], "missing-anchor").divergent, true);
});

test("wraps a one-time handoff with an auditable Pi entry cursor", () => {
  const value = wrapHandoff("state", "catch-up", "abc", "continue");
  assert.match(value, /kind="catch-up" through_entry="abc"/);
  assert.match(value, /## Current request\ncontinue/);
});

const claudeAssistant = (id: string, text: string) => {
  const entry = assistant(id, text);
  entry.message.provider = "claude-runtime";
  return entry;
};

const toolResult = (id: string) => ({
  type: "message",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "toolResult", toolCallId: "t1", toolName: "Bash", content: [], timestamp: 3 },
}) as any;

const compaction = (id: string, firstKeptEntryId: string) => ({
  type: "compaction",
  id,
  parentId: null,
  timestamp: "2026-01-01T00:00:00.000Z",
  summary: "summary",
  firstKeptEntryId,
  tokensBefore: 100,
}) as any;

test("pi compaction of pure claude-runtime history needs no handoff", () => {
  const branch = [
    user("a", "turn"),
    claudeAssistant("b", "round 1"),
    toolResult("c"),
    claudeAssistant("d", "round 2"),
    compaction("e", "d"),
  ];
  const result = getHandoffRange(branch, "a");
  assert.equal(needsClaudeHandoff(result.rawMessages, "claude-runtime"), false);
  // Canonical view still carries the compaction summary for actual handoffs.
  assert.equal(result.messages.some((message: any) => message.role === "compactionSummary"), true);
});

test("foreign content behind a compaction summary still needs handoff", () => {
  const branch = [
    claudeAssistant("a", "synced"),
    assistant("b", "gpt answer"),
    compaction("c", "b"),
  ];
  const result = getHandoffRange(branch, "a");
  assert.equal(needsClaudeHandoff(result.rawMessages, "claude-runtime"), true);
});

test("user messages and branch summaries need handoff; claude rounds do not", () => {
  assert.equal(needsClaudeHandoff([{ role: "user", content: "hi", timestamp: 1 } as any], "claude-runtime"), true);
  assert.equal(
    needsClaudeHandoff(
      [{ role: "branchSummary", summary: "s", fromId: "x", timestamp: 1 } as any],
      "claude-runtime",
    ),
    true,
  );
  const claudeOnly = getHandoffRange(
    [user("a", "turn"), claudeAssistant("b", "round"), toolResult("c")],
    "a",
  );
  assert.equal(needsClaudeHandoff(claudeOnly.rawMessages, "claude-runtime"), false);
});
