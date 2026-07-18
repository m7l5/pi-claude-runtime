import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { complete, type Message, type Model } from "@earendil-works/pi-ai/compat";
import {
  convertToLlm,
  serializeConversation,
  type ExtensionContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

const HANDOFF_SYSTEM_PROMPT = `You transfer state from a Pi coding-agent timeline into a Claude Code session. Produce a concise, self-contained state update containing:
- current goal and user intent
- completed and in-progress work
- important decisions and constraints
- files read or modified
- failures or unresolved issues
- exact next steps
Do not address the user, add preamble, or invent information. Use markdown headings.`;

const entryToMessage = (entry: SessionEntry): AgentMessage | undefined => {
  if (entry.type === "message") return entry.message;
  if (entry.type === "compaction") {
    return {
      role: "compactionSummary",
      summary: entry.summary,
      tokensBefore: entry.tokensBefore,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      timestamp: new Date(entry.timestamp).getTime(),
    };
  }
  return undefined;
};

export type HandoffRange = {
  messages: AgentMessage[];
  throughEntryId?: string;
  divergent: boolean;
};

export function getHandoffRange(
  branch: SessionEntry[],
  fromExclusive?: string,
  throughExclusive?: string,
): HandoffRange {
  const fromIndex = fromExclusive ? branch.findIndex((entry) => entry.id === fromExclusive) : -1;
  const divergent = Boolean(fromExclusive && fromIndex < 0);
  const endIndex = throughExclusive
    ? branch.findIndex((entry) => entry.id === throughExclusive)
    : branch.length;
  const safeEnd = endIndex < 0 ? branch.length : endIndex;
  const start = divergent ? 0 : fromIndex + 1;
  const segment = branch.slice(start, safeEnd);

  let canonical = segment;
  let compactionIndex = -1;
  for (let index = segment.length - 1; index >= 0; index--) {
    if (segment[index]?.type === "compaction") {
      compactionIndex = index;
      break;
    }
  }
  if (compactionIndex >= 0) {
    const compaction = segment[compactionIndex]!;
    if (compaction.type === "compaction") {
      const absoluteKept = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
      const keptStart = Math.max(start, absoluteKept >= 0 ? absoluteKept : start);
      const absoluteCompaction = start + compactionIndex;
      canonical = [
        compaction,
        ...branch.slice(keptStart, absoluteCompaction),
        ...branch.slice(absoluteCompaction + 1, safeEnd),
      ];
    }
  }

  const messages = canonical.map(entryToMessage).filter((message) => message !== undefined);
  const throughEntryId = safeEnd > 0 ? branch[safeEnd - 1]?.id : undefined;
  return { messages, throughEntryId, divergent };
}

export const serializeHandoff = (messages: AgentMessage[]): string =>
  serializeConversation(convertToLlm(messages));

export async function generateHandoffSummary(
  ctx: ExtensionContext,
  model: Model<any> | undefined,
  messages: AgentMessage[],
  goal: string,
  signal?: AbortSignal,
): Promise<string> {
  const conversation = serializeHandoff(messages);
  if (!conversation.trim()) return goal ? `## Task\n${goal}` : "";

  if (!model || model.provider === "claude-runtime") {
    const clipped = conversation.length > 40_000
      ? `[Earlier context omitted]\n${conversation.slice(-40_000)}`
      : conversation;
    return `## State transferred from Pi\n${clipped}${goal ? `\n\n## Task\n${goal}` : ""}`;
  }

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return `## State transferred from Pi\n${conversation.slice(-40_000)}${goal ? `\n\n## Task\n${goal}` : ""}`;
  }
  const prompt: Message = {
    role: "user",
    content: [{
      type: "text",
      text: `## Pi conversation range\n\n${conversation}\n\n## User's next goal\n\n${goal || "Continue the current work."}`,
    }],
    timestamp: Date.now(),
  };
  try {
    const response = await complete(
      model,
      { systemPrompt: HANDOFF_SYSTEM_PROMPT, messages: [prompt] },
      { apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal },
    );
    const generated = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (generated.trim()) return generated;
  } catch {
    if (signal?.aborted) throw new Error("Handoff generation aborted.");
  }
  return `## State transferred from Pi\n${conversation.slice(-40_000)}${goal ? `\n\n## Task\n${goal}` : ""}`;
}

export function wrapHandoff(
  summary: string,
  kind: "bootstrap" | "catch-up",
  throughEntryId: string | undefined,
  currentRequest: string,
): string {
  return `<pi_handoff kind="${kind}"${throughEntryId ? ` through_entry="${throughEntryId}"` : ""}>
${summary}
</pi_handoff>

## Current request
${currentRequest}`;
}
