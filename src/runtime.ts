import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  ImageContent,
  TextContent,
  ThinkingLevel,
  ToolCall,
} from "@earendil-works/pi-ai";

export type PermissionPreference = "full-access" | "interactive";

export type ClaudeBinding = {
  claudeSessionId: string;
  piSessionId: string;
  cwd: string;
  syncedThroughEntryId?: string;
};

export type PendingHandoff = {
  kind: "bootstrap" | "catch-up";
  summary: string;
  throughEntryId?: string;
};

export type RuntimeState = {
  permission: PermissionPreference;
  binding?: ClaudeBinding;
  pendingHandoff?: PendingHandoff;
  /** Pi tool names that were active before the Claude runtime took over. */
  savedActiveTools?: string[];
  /** Claude tool names discovered at runtime (MCP tools etc.), re-registered on session start. */
  knownClaudeTools?: string[];
  /** Migrated from v0.1 state entries. */
  claudeSessionId?: string;
};

/** Claude Code tool names known ahead of time; proxies are registered for each. */
export const CLAUDE_TOOL_NAMES = [
  "Agent",
  "AskUserQuestion",
  "Bash",
  "BashOutput",
  "Edit",
  "EnterPlanMode",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillShell",
  "ListMcpResources",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "ReadMcpResource",
  "Skill",
  "SlashCommand",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "ToolSearch",
  "WebFetch",
  "WebSearch",
  "Write",
] as const;

export type StructuredPatchHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
};

export type ToolActivityDetails = {
  structuredPatch?: StructuredPatchHunk[];
};

export type Activity =
  | {
      kind: "tool";
      title: string;
      toolUseId: string;
      args: Record<string, unknown>;
      result: string;
      isError: boolean;
      details?: ToolActivityDetails;
      timestamp: number;
    }
  | {
      kind: "status" | "error";
      title: string;
      detail?: string;
      isError?: boolean;
      timestamp: number;
    };

export const DEFAULT_STATE: RuntimeState = { permission: "full-access" };

export function lastUserContent(context: Context): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  const message = [...context.messages].reverse().find((item) => item.role === "user");
  if (!message) return [];
  if (typeof message.content === "string") return [{ type: "text", text: message.content }];
  return message.content.filter(
    (block): block is
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string } =>
      block.type === "text" || block.type === "image",
  );
}

export function lastUserText(context: Context): string {
  return lastUserContent(context)
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function effortFor(level: ThinkingLevel | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  if (!level) return undefined;
  if (level === "minimal" || level === "low") return "low";
  return level;
}

export function thinkingFor(
  modelId: string,
  level: ThinkingLevel | undefined,
  budgets?: Partial<Record<ThinkingLevel, number>>,
):
  | { type: "adaptive"; display: "summarized" }
  | { type: "enabled"; budgetTokens: number; display: "summarized" }
  | undefined {
  if (!level) return undefined;
  if (
    modelId === "claude-fable-5" ||
    modelId === "claude-opus-4-8" ||
    modelId === "claude-opus-4-6" ||
    modelId === "claude-sonnet-5" ||
    modelId === "claude-sonnet-4-6"
  ) {
    return { type: "adaptive", display: "summarized" };
  }
  const defaults: Record<ThinkingLevel, number> = {
    minimal: 1_024,
    low: 4_096,
    medium: 10_240,
    high: 20_480,
    xhigh: 32_000,
    max: 32_000,
  };
  return {
    type: "enabled",
    budgetTokens: budgets?.[level] ?? defaults[level],
    display: "summarized",
  };
}

/**
 * Extract the structured patch from an SDK user message's tool_use_result, if
 * it belongs to the given file. Claude Code attaches this metadata to Edit and
 * Write results; it is the authoritative diff of what was applied on disk.
 */
export function structuredPatchFromToolUseResult(
  toolUseResult: unknown,
  filePath: unknown,
): StructuredPatchHunk[] | undefined {
  if (!toolUseResult || typeof toolUseResult !== "object") return undefined;
  const record = toolUseResult as { structuredPatch?: unknown; filePath?: unknown };
  if (
    typeof filePath === "string" &&
    typeof record.filePath === "string" &&
    record.filePath !== filePath
  ) {
    return undefined;
  }
  if (!Array.isArray(record.structuredPatch) || record.structuredPatch.length === 0) {
    return undefined;
  }
  const hunks = record.structuredPatch as StructuredPatchHunk[];
  const valid = hunks.every(
    (hunk) =>
      typeof hunk?.oldStart === "number" &&
      typeof hunk?.newStart === "number" &&
      Array.isArray(hunk?.lines) &&
      hunk.lines.every((line) => typeof line === "string"),
  );
  return valid ? hunks : undefined;
}

/**
 * Convert unified-diff hunks into the line-numbered diff string format that
 * pi's renderDiff consumes ("+12 text" / "-12 text" / " 12 text").
 */
export function structuredPatchToDiffString(hunks: StructuredPatchHunk[]): string {
  const maxLine = hunks.reduce(
    (max, hunk) => Math.max(max, hunk.oldStart + hunk.lines.length, hunk.newStart + hunk.lines.length),
    1,
  );
  const width = String(maxLine).length;
  const output: string[] = [];
  hunks.forEach((hunk, index) => {
    if (index > 0) output.push("...");
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const content = line.slice(1);
      if (line.startsWith("+")) {
        output.push(`+${String(newLine).padStart(width)} ${content}`);
        newLine += 1;
      } else if (line.startsWith("-")) {
        output.push(`-${String(oldLine).padStart(width)} ${content}`);
        oldLine += 1;
      } else {
        output.push(` ${String(newLine).padStart(width)} ${content}`);
        oldLine += 1;
        newLine += 1;
      }
    }
  });
  return output.join("\n");
}

/** Unbounded async queue bridging the SDK pump and the per-round drain loop. */
export class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: Array<(item: T | undefined) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  /** Returns the next item, or undefined once the queue is closed and drained. */
  async next(): Promise<T | undefined> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.closed) return undefined;
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Outcome of a tool executed inside the Claude runtime, mirrored back to Pi. */
export type SdkToolOutcome = {
  content: Array<TextContent | ImageContent>;
  details: unknown;
  isError: boolean;
};

/** Convert an SDK tool_result block's content to Pi content blocks. */
export function toolResultContent(raw: unknown): Array<TextContent | ImageContent> {
  if (typeof raw === "string") return raw ? [{ type: "text", text: raw }] : [];
  if (!Array.isArray(raw)) return [];
  const blocks: Array<TextContent | ImageContent> = [];
  for (const item of raw as Array<Record<string, any>>) {
    if (item?.type === "text" && typeof item.text === "string") {
      blocks.push({ type: "text", text: item.text });
    } else if (item?.type === "image" && item.source?.type === "base64") {
      blocks.push({ type: "image", data: item.source.data ?? "", mimeType: item.source.media_type ?? "image/png" });
    }
  }
  return blocks;
}

/** Per-API-call token usage, as reported on one SDK assistant message. */
export type RoundUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Events the SDK pump feeds into the per-round drain loop, in stream order. */
export type RunEvent =
  | { kind: "stream_event"; event: any }
  | { kind: "usage"; usage: RoundUsage }
  | { kind: "toolcalls"; calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }
  | { kind: "result"; message: any }
  | { kind: "error"; message: string };

type InternalBlock =
  | { type: "text"; text: string; providerIndex?: number }
  | { type: "thinking"; thinking: string; thinkingSignature: string; providerIndex?: number };

/**
 * Consume run events until the current round completes: either Claude issued
 * tool calls (→ "toolUse", the run stays alive for the next round) or the SDK
 * reported the final result (→ "stop"). Mutates `output` and streams deltas.
 * Throws on SDK errors or when the queue closes without a result.
 */
export async function drainRound(
  events: AsyncQueue<RunEvent>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  hooks?: { onPhase?: (phase: string) => void; aborted?: () => boolean },
): Promise<"toolUse" | "stop"> {
  let currentBlocks = new Map<number, number>();
  let emittedText = false;
  let sawRoundUsage = false;

  while (true) {
    const item = await events.next();
    if (!item) {
      throw new Error(hooks?.aborted?.() ? "Claude Agent SDK request aborted." : "Claude runtime stream ended unexpectedly.");
    }

    if (item.kind === "error") throw new Error(item.message);

    if (item.kind === "usage") {
      // Per-API-call usage: this message's prompt tokens ARE Claude's current
      // context size, which Pi reads off the latest assistant message. The
      // cumulative run totals still come out right because every round carries
      // its own call's usage and Pi sums across messages.
      output.usage.input = item.usage.input;
      output.usage.output = item.usage.output;
      output.usage.cacheRead = item.usage.cacheRead;
      output.usage.cacheWrite = item.usage.cacheWrite;
      output.usage.totalTokens =
        item.usage.input + item.usage.output + item.usage.cacheRead + item.usage.cacheWrite;
      sawRoundUsage = true;
      continue;
    }

    if (item.kind === "stream_event") {
      const event = item.event as any;
      if (event.type === "message_start") {
        currentBlocks = new Map();
        hooks?.onPhase?.("Claude: thinking");
      }
      if (event.type === "content_block_start") {
        if (event.content_block?.type === "text") {
          hooks?.onPhase?.("Claude: responding");
          const index = output.content.length;
          (output.content as InternalBlock[]).push({ type: "text", text: "", providerIndex: event.index });
          currentBlocks.set(event.index, index);
          stream.push({ type: "text_start", contentIndex: index, partial: output });
        } else if (event.content_block?.type === "thinking") {
          hooks?.onPhase?.("Claude: thinking");
          const index = output.content.length;
          (output.content as InternalBlock[]).push({
            type: "thinking",
            thinking: "",
            thinkingSignature: "",
            providerIndex: event.index,
          });
          currentBlocks.set(event.index, index);
          stream.push({ type: "thinking_start", contentIndex: index, partial: output });
        }
      } else if (event.type === "content_block_delta") {
        const index = currentBlocks.get(event.index);
        const block = index === undefined ? undefined : (output.content[index] as InternalBlock | undefined);
        if (block?.type === "text" && event.delta?.type === "text_delta") {
          block.text += event.delta.text;
          emittedText = true;
          stream.push({ type: "text_delta", contentIndex: index!, delta: event.delta.text, partial: output });
        } else if (block?.type === "thinking" && event.delta?.type === "thinking_delta") {
          block.thinking += event.delta.thinking;
          stream.push({ type: "thinking_delta", contentIndex: index!, delta: event.delta.thinking, partial: output });
        } else if (block?.type === "thinking" && event.delta?.type === "signature_delta") {
          block.thinkingSignature += event.delta.signature;
        }
      } else if (event.type === "content_block_stop") {
        const index = currentBlocks.get(event.index);
        const block = index === undefined ? undefined : (output.content[index] as InternalBlock | undefined);
        if (block?.type === "text") {
          delete block.providerIndex;
          stream.push({ type: "text_end", contentIndex: index!, content: block.text, partial: output });
        } else if (block?.type === "thinking") {
          delete block.providerIndex;
          stream.push({ type: "thinking_end", contentIndex: index!, content: block.thinking, partial: output });
        }
      }
      continue;
    }

    if (item.kind === "toolcalls") {
      for (const call of item.calls) {
        const index = output.content.length;
        const toolCall: ToolCall = { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
      }
      return "toolUse";
    }

    // item.kind === "result"
    const message = item.message;
    if (!sawRoundUsage) {
      // No assistant usage seen this round — fall back to the run totals. Note
      // these are CUMULATIVE across all rounds; using them on a message that
      // already carries its own round usage would make Pi read the summed
      // prompt tokens as the current context size (the 500%-of-window bug).
      output.usage.input = message.usage?.input_tokens ?? 0;
      output.usage.output = message.usage?.output_tokens ?? 0;
      output.usage.cacheRead = message.usage?.cache_read_input_tokens ?? 0;
      output.usage.cacheWrite = message.usage?.cache_creation_input_tokens ?? 0;
      output.usage.totalTokens =
        output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
    }
    // The whole run's cost lands on the final message; earlier rounds carry 0,
    // so Pi's per-message cost sum stays correct.
    output.usage.cost.total = message.total_cost_usd ?? 0;
    if (message.subtype !== "success") {
      throw new Error((message.errors ?? []).join("\n") || message.subtype);
    }
    if (!emittedText && message.result) {
      const index = output.content.length;
      output.content.push({ type: "text", text: message.result });
      stream.push({ type: "text_start", contentIndex: index, partial: output });
      stream.push({ type: "text_delta", contentIndex: index, delta: message.result, partial: output });
      stream.push({ type: "text_end", contentIndex: index, content: message.result, partial: output });
    }
    return "stop";
  }
}

export function summarize(value: unknown, max = 2_000): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
