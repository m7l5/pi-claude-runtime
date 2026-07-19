import assert from "node:assert/strict";
import test from "node:test";
import {
  AsyncQueue,
  drainRound,
  effortFor,
  lastUserText,
  type RunEvent,
  structuredPatchFromToolUseResult,
  structuredPatchToDiffString,
  summarize,
  thinkingFor,
  toolResultContent,
} from "../src/runtime.js";

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

test("extracts a structured patch matching the edited file", () => {
  const patch = [
    { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" {", "+  \"version\": \"0.0.1\",", "   \"private\": true"] },
  ];
  const toolUseResult = { filePath: "/repo/package.json", structuredPatch: patch };
  assert.deepEqual(structuredPatchFromToolUseResult(toolUseResult, "/repo/package.json"), patch);
  assert.equal(structuredPatchFromToolUseResult(toolUseResult, "/repo/other.json"), undefined);
  assert.equal(structuredPatchFromToolUseResult(undefined, "/repo/package.json"), undefined);
  assert.equal(structuredPatchFromToolUseResult({ structuredPatch: [] }, "/repo/package.json"), undefined);
  assert.equal(
    structuredPatchFromToolUseResult({ structuredPatch: [{ oldStart: "1", lines: [] }] }, "/repo/package.json"),
    undefined,
  );
});

test("converts structured patch hunks to renderable line-numbered diffs", () => {
  const diff = structuredPatchToDiffString([
    {
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
      lines: [" {", "-  \"version\": \"0.0.1\",", "+  \"version\": \"0.0.2\",", "   \"private\": true,"],
    },
  ]);
  assert.deepEqual(diff.split("\n"), [
    " 1 {",
    "-2   \"version\": \"0.0.1\",",
    "+2   \"version\": \"0.0.2\",",
    " 3   \"private\": true,",
  ]);
});

const makeOutput = () =>
  ({
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "claude-runtime",
    model: "claude-fable-5",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  }) as any;

const makeStream = () => {
  const pushed: any[] = [];
  return { pushed, stream: { push: (event: any) => pushed.push(event), end: () => {} } as any };
};

const textEvents = (index: number, text: string) => [
  { kind: "stream_event", event: { type: "content_block_start", index, content_block: { type: "text" } } },
  { kind: "stream_event", event: { type: "content_block_delta", index, delta: { type: "text_delta", text } } },
  { kind: "stream_event", event: { type: "content_block_stop", index } },
] as RunEvent[];

test("queue preserves order and closes cleanly", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  const pending = queue.next();
  queue.push(2);
  assert.equal(await pending, 1);
  assert.equal(await queue.next(), 2);
  const blocked = queue.next();
  queue.close();
  assert.equal(await blocked, undefined);
  assert.equal(await queue.next(), undefined);
});

test("converts SDK tool_result content to Pi content blocks", () => {
  assert.deepEqual(toolResultContent("plain"), [{ type: "text", text: "plain" }]);
  assert.deepEqual(
    toolResultContent([
      { type: "text", text: "a" },
      { type: "image", source: { type: "base64", data: "xx", media_type: "image/jpeg" } },
      { type: "bogus" },
    ]),
    [
      { type: "text", text: "a" },
      { type: "image", data: "xx", mimeType: "image/jpeg" },
    ],
  );
  assert.deepEqual(toolResultContent(undefined), []);
});

test("splits a multi-round run at tool-call boundaries", async () => {
  const queue = new AsyncQueue<RunEvent>();
  const output1 = makeOutput();
  const { pushed: pushed1, stream: stream1 } = makeStream();

  queue.push({ kind: "stream_event", event: { type: "message_start" } });
  queue.push({
    kind: "stream_event",
    event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
  });
  queue.push({
    kind: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "consider" } },
  });
  queue.push({ kind: "stream_event", event: { type: "content_block_stop", index: 0 } });
  for (const event of textEvents(1, "working on it")) queue.push(event);
  queue.push({ kind: "toolcalls", calls: [{ id: "t1", name: "Edit", arguments: { file_path: "/a" } }] });

  const reason1 = await drainRound(queue, output1, stream1);
  assert.equal(reason1, "toolUse");
  assert.deepEqual(
    output1.content.map((block: any) => block.type),
    ["thinking", "text", "toolCall"],
  );
  assert.deepEqual(output1.content[2], { type: "toolCall", id: "t1", name: "Edit", arguments: { file_path: "/a" } });
  assert.deepEqual(
    pushed1.map((event) => event.type),
    ["thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "toolcall_start", "toolcall_end"],
  );

  // Round 2 on the same queue: final text then the SDK result.
  const output2 = makeOutput();
  const { pushed: pushed2, stream: stream2 } = makeStream();
  queue.push({ kind: "stream_event", event: { type: "message_start" } });
  for (const event of textEvents(0, "done")) queue.push(event);
  queue.push({
    kind: "result",
    message: {
      subtype: "success",
      result: "done",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
      total_cost_usd: 0.5,
    },
  });

  const reason2 = await drainRound(queue, output2, stream2);
  assert.equal(reason2, "stop");
  assert.deepEqual(output2.content, [{ type: "text", text: "done" }]);
  assert.equal(output2.usage.totalTokens, 18);
  assert.equal(output2.usage.cost.total, 0.5);
  // Text was streamed this round, so message.result must not be appended again.
  assert.equal(pushed2.filter((event) => event.type === "text_start").length, 1);
});

test("drain surfaces SDK errors and closed queues", async () => {
  const errored = new AsyncQueue<RunEvent>();
  errored.push({ kind: "result", message: { subtype: "error_during_execution", errors: ["boom"] } });
  await assert.rejects(() => drainRound(errored, makeOutput(), makeStream().stream), /boom/);

  const closed = new AsyncQueue<RunEvent>();
  closed.close();
  await assert.rejects(
    () => drainRound(closed, makeOutput(), makeStream().stream, { aborted: () => true }),
    /aborted/,
  );
});

test("rounds carry their own API usage; result totals never inflate context", async () => {
  const queue = new AsyncQueue<RunEvent>();

  // Round 1: its API call's usage, then tool calls.
  const output1 = makeOutput();
  queue.push({ kind: "usage", usage: { input: 1_000, output: 50, cacheRead: 100_000, cacheWrite: 2_000 } });
  queue.push({ kind: "toolcalls", calls: [{ id: "t1", name: "Bash", arguments: {} }] });
  assert.equal(await drainRound(queue, output1, makeStream().stream), "toolUse");
  assert.equal(output1.usage.input, 1_000);
  assert.equal(output1.usage.cacheRead, 100_000);
  assert.equal(output1.usage.cost.total, 0);

  // Round 2 (final): its own usage, then the CUMULATIVE run result. The round's
  // usage must survive — pi reads context size off the last assistant message.
  const output2 = makeOutput();
  queue.push({ kind: "usage", usage: { input: 1_200, output: 80, cacheRead: 110_000, cacheWrite: 500 } });
  for (const event of textEvents(0, "done")) queue.push(event);
  queue.push({
    kind: "result",
    message: {
      subtype: "success",
      result: "done",
      usage: {
        input_tokens: 2_200,
        output_tokens: 130,
        cache_read_input_tokens: 5_000_000,
        cache_creation_input_tokens: 2_500,
      },
      total_cost_usd: 1.25,
    },
  });
  assert.equal(await drainRound(queue, output2, makeStream().stream), "stop");
  assert.equal(output2.usage.cacheRead, 110_000, "context must be the round's usage, not the 5M cumulative");
  assert.equal(output2.usage.input, 1_200);
  assert.equal(output2.usage.totalTokens, 111_780);
  assert.equal(output2.usage.cost.total, 1.25);
});
