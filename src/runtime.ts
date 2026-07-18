import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";

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
  /** Migrated from v0.1 state entries. */
  claudeSessionId?: string;
};

export type Activity =
  | {
      kind: "tool";
      title: string;
      toolUseId: string;
      args: Record<string, unknown>;
      result: string;
      isError: boolean;
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
