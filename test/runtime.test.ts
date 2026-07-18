import assert from "node:assert/strict";
import test from "node:test";
import { effortFor, lastUserText, summarize, thinkingFor } from "../src/runtime.js";

test("extracts the latest user text", () => {
  const context = {
    systemPrompt: "",
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "latest" }], timestamp: 3 },
    ],
  } as any;
  assert.equal(lastUserText(context), "latest");
});

test("maps Pi thinking levels to Agent SDK effort", () => {
  assert.equal(effortFor("minimal"), "low");
  assert.equal(effortFor("medium"), "medium");
  assert.equal(effortFor("max"), "max");
  assert.equal(effortFor(undefined), undefined);
});

test("requests visible summarized thinking", () => {
  assert.deepEqual(thinkingFor("claude-fable-5", "high"), {
    type: "adaptive",
    display: "summarized",
  });
  assert.deepEqual(thinkingFor("claude-haiku-4-5", "medium"), {
    type: "enabled",
    budgetTokens: 10_240,
    display: "summarized",
  });
});

test("truncates activity details", () => {
  assert.equal(summarize("abcdef", 4), "abcd…");
});
