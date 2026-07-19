import {
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BorderedLoader,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
  generateDiffString,
  keyHint,
  renderDiff,
  type Theme,
  type ToolDefinition,
  ToolExecutionComponent,
  truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  Container,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";
import { CLAUDE_RUNTIME_MODELS } from "./src/models.js";
import {
  generateHandoffSummary,
  getHandoffRange,
  needsClaudeHandoff,
  wrapHandoff,
} from "./src/handoff.js";
import {
  checkClaudeVersion,
  type ClaudeVersionState,
  resolveClaudeUpdateCommand,
} from "./src/maintenance.js";
import {
  type Activity,
  AsyncQueue,
  CLAUDE_TOOL_NAMES,
  DEFAULT_STATE,
  type Deferred,
  deferred,
  drainRound,
  effortFor,
  lastUserContent,
  lastUserText,
  type PendingHandoff,
  type RunEvent,
  type RuntimeState,
  type SdkToolOutcome,
  structuredPatchFromToolUseResult,
  structuredPatchToDiffString,
  summarize,
  thinkingFor,
  toolResultContent,
} from "./src/runtime.js";

const PROVIDER = "claude-runtime";
const STATE_ENTRY = "pi-claude-runtime-state";
const ACTIVITY_ENTRY = "pi-claude-runtime-activity";
const STATUS_ID = "claude-runtime";

type ApprovalChoice = "once" | "session" | "deny";
type ActivityInput = Activity extends infer Item
  ? Item extends { timestamp: number }
    ? Omit<Item, "timestamp">
    : never
  : never;

const displayPath = (value: unknown): string => {
  const raw = typeof value === "string" ? value : "";
  const home = process.env.HOME;
  return home && raw.startsWith(home) ? `~${raw.slice(home.length)}` : raw;
};

const toPiTool = (name: string, args: Record<string, unknown>) => {
  switch (name) {
    case "Read":
      return { name: "read", args: { path: args.file_path, offset: args.offset, limit: args.limit } };
    case "Write":
      return { name: "write", args: { path: args.file_path, content: args.content } };
    case "Edit":
      return {
        name: "edit",
        args: {
          path: args.file_path,
          edits: [{ oldText: args.old_string, newText: args.new_string }],
        },
      };
    case "Bash":
      return { name: "bash", args: { command: args.command } };
    case "Grep":
      return { name: "grep", args: { pattern: args.pattern, path: args.path } };
    case "Glob":
      return { name: "find", args: { pattern: args.pattern, path: args.path } };
    default:
      return { name, args };
  }
};

const makeOutput = (model: Model<Api>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});

const approvalOverlay = async (
  ctx: ExtensionContext,
  toolName: string,
  input: Record<string, unknown>,
  title?: string,
  description?: string,
): Promise<ApprovalChoice> => {
  if (ctx.mode !== "tui") return "deny";
  const items: SelectItem[] = [
    { value: "once", label: "Allow once", description: "Run only this tool call" },
    { value: "session", label: "Allow for session", description: "Apply Claude's suggested session rule" },
    { value: "deny", label: "Deny", description: "Return a denial to Claude" },
  ];

  return (
    (await ctx.ui.custom<ApprovalChoice | null>(
      (tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
        container.addChild(
          new Text(theme.fg("warning", theme.bold(title ?? `Claude wants to use ${toolName}`)), 1, 0),
        );
        if (description) container.addChild(new Text(theme.fg("muted", description), 1, 0));
        container.addChild(new Text(theme.fg("dim", summarize(input, 4_000)), 1, 1));
        const list = new SelectList(items, items.length, {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("dim", text),
          noMatch: (text) => theme.fg("warning", text),
        });
        list.onSelect = (item) => done(item.value as ApprovalChoice);
        list.onCancel = () => done("deny");
        container.addChild(list);
        container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc deny"), 1, 0));
        container.addChild(new DynamicBorder((text: string) => theme.fg("warning", text)));
        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput(data);
            tui.requestRender();
          },
        };
      },
      { overlay: true, overlayOptions: { width: "70%", maxHeight: "80%", anchor: "center" } },
    )) ?? "deny"
  );
};

export default function claudeRuntime(pi: ExtensionAPI) {
  let state: RuntimeState = { ...DEFAULT_STATE };
  let activeContext: ExtensionContext | undefined;
  let handoffSourceModel: Model<Api> | undefined;
  let runtimePhase = "Claude: idle";
  let versionState: ClaudeVersionState = { checked: false, updateAvailable: false };
  const binary = process.env.PI_CLAUDE_RUNTIME_BINARY ?? "claude";
  const runtimeStatus = () => {
    const version = !versionState.checked
      ? "CLI checking"
      : versionState.updateAvailable
        ? `CLI ${versionState.current ?? "?"}→${versionState.latest ?? "?"}`
        : versionState.current
          ? `CLI ${versionState.current} ✓`
          : "CLI unknown";
    return `${runtimePhase} • ${version}`;
  };
  const publishRuntimeStatus = () => {
    activeContext?.ui.setStatus(
      STATUS_ID,
      activeContext.model?.provider === PROVIDER ? runtimeStatus() : undefined,
    );
  };
  const setRuntimePhase = (phase: string) => {
    runtimePhase = phase;
    publishRuntimeStatus();
  };
  const refreshVersion = async () => {
    versionState = await checkClaudeVersion(binary);
    publishRuntimeStatus();
    return versionState;
  };

  const persistState = () => pi.appendEntry<RuntimeState>(STATE_ENTRY, state);
  const activity = (data: ActivityInput) =>
    pi.appendEntry<Activity>(ACTIVITY_ENTRY, { ...data, timestamp: Date.now() });

  const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    if (state.permission === "full-access") return { behavior: "allow", updatedInput: input };
    if (!activeContext) return { behavior: "deny", message: "Pi approval UI is unavailable." };
    const choice = await approvalOverlay(
      activeContext,
      toolName,
      input,
      options.title,
      options.description ?? options.decisionReason,
    );
    if (choice === "deny") return { behavior: "deny", message: "User denied tool execution." };
    return {
      behavior: "allow",
      updatedInput: input,
      ...(choice === "session" && options.suggestions
        ? { updatedPermissions: options.suggestions }
        : {}),
    };
  };

  // ----- Claude runtime run state -----
  // A "run" is one Claude Code query. It spans several Pi turns: each round of
  // thinking/text ends with stopReason "toolUse" when Claude issues tool calls,
  // Pi "executes" the proxy tools below (which merely await Claude's own
  // results), and the next streamSimple call drains the following round.
  type ActiveRun = {
    piSessionId: string;
    abortController: AbortController;
    events: AsyncQueue<RunEvent>;
    pendingResults: Map<string, Deferred<SdkToolOutcome>>;
    earlyResults: Map<string, SdkToolOutcome>;
  };
  let activeRun: ActiveRun | undefined;

  const awaitClaudeToolResult = (toolCallId: string, signal?: AbortSignal): Promise<SdkToolOutcome> => {
    const run = activeRun;
    if (!run) {
      return Promise.resolve({
        content: [{ type: "text", text: "The Claude runtime run is not active." }],
        details: undefined,
        isError: true,
      });
    }
    const early = run.earlyResults.get(toolCallId);
    if (early) {
      run.earlyResults.delete(toolCallId);
      return Promise.resolve(early);
    }
    const waiter = deferred<SdkToolOutcome>();
    run.pendingResults.set(toolCallId, waiter);
    signal?.addEventListener(
      "abort",
      () => {
        if (run.pendingResults.delete(toolCallId)) {
          waiter.resolve({ content: [{ type: "text", text: "Aborted." }], details: undefined, isError: true });
        }
      },
      { once: true },
    );
    return waiter.promise;
  };

  const proxyHeader =
    (title: string, detail: (args: Record<string, any>) => string) =>
    (args: Record<string, any>, theme: Theme) =>
      new Text(`${theme.fg("toolTitle", theme.bold(title))} ${detail(args ?? {})}`.trimEnd(), 0, 0);

  const PROXY_PREVIEW_LINES = 5;

  // Ctrl+O support: mirror native bash's collapsed rendering — last N visual
  // lines plus an expand hint — since the generic result fallback ignores the
  // expanded flag entirely and would dump full output with no way to collapse.
  const proxyResultRenderer = (
    result: { content: Array<{ type: string; text?: string }> },
    options: { expanded?: boolean },
    theme: Theme,
    context: { isError: boolean },
  ) => {
    const container = new Container();
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .replace(/\r/g, "")
      .trim();
    if (!text) return container;
    const styled = text
      .split("\n")
      .map((line) => theme.fg(context.isError ? "error" : "toolOutput", line))
      .join("\n");
    if (options.expanded === true) {
      container.addChild(new Spacer(1));
      container.addChild(new Text(styled, 0, 0));
      return container;
    }
    let cached: { width: number; lines: string[]; skipped: number } | undefined;
    container.addChild({
      render: (width: number) => {
        if (cached === undefined || cached.width !== width) {
          const preview = truncateToVisualLines(styled, PROXY_PREVIEW_LINES, width);
          cached = { width, lines: preview.visualLines, skipped: preview.skippedCount };
        }
        if (cached.skipped > 0) {
          const hint =
            theme.fg("muted", `... (${String(cached.skipped)} earlier lines,`) +
            ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
          return ["", truncateToWidth(hint, width, "..."), ...cached.lines];
        }
        return ["", ...cached.lines];
      },
      invalidate: () => {
        cached = undefined;
      },
    });
    return container;
  };

  const editProxyRenderers = {
    renderCall: proxyHeader("edit", (args) => displayPath(args.file_path)),
    renderResult: (
      result: { content: Array<{ type: string; text?: string }>; details?: unknown },
      _options: unknown,
      theme: Theme,
      context: { args?: Record<string, any>; isError: boolean },
    ) => {
      const container = new Container();
      if (context.isError) {
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        if (text) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("error", text), 0, 0));
        }
        return container;
      }
      const args = context.args ?? {};
      const patch = structuredPatchFromToolUseResult(result.details, args.file_path);
      const diff = patch
        ? structuredPatchToDiffString(patch)
        : typeof args.old_string === "string" && typeof args.new_string === "string"
          ? generateDiffString(args.old_string, args.new_string).diff
          : undefined;
      if (diff) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(renderDiff(diff), 0, 0));
      }
      return container;
    },
  };

  const PROXY_RENDERERS: Record<string, { renderCall?: unknown; renderResult?: unknown }> = {
    Edit: editProxyRenderers,
    MultiEdit: editProxyRenderers,
    Bash: { renderCall: proxyHeader("bash", (args) => String(args.command ?? "")) },
    Read: { renderCall: proxyHeader("read", (args) => displayPath(args.file_path)) },
    Write: { renderCall: proxyHeader("write", (args) => displayPath(args.file_path)) },
    Grep: { renderCall: proxyHeader("grep", (args) => String(args.pattern ?? "")) },
    Glob: { renderCall: proxyHeader("find", (args) => String(args.pattern ?? "")) },
  };

  const registeredProxies = new Set<string>();

  const claudeProxyTool = (name: string): ToolDefinition<any, any> =>
    ({
      name,
      label: name,
      description: `${name} runs inside the Claude runtime; Pi mirrors its recorded result.`,
      parameters: { type: "object", properties: {}, additionalProperties: true },
      execute: async (toolCallId: string, _params: unknown, signal?: AbortSignal) => {
        const outcome = await awaitClaudeToolResult(toolCallId, signal);
        if (outcome.isError) {
          const text = outcome.content
            .filter((block): block is { type: "text"; text: string } => block.type === "text")
            .map((block) => block.text)
            .join("\n");
          throw new Error(text || `${name} failed in the Claude runtime.`);
        }
        return { content: outcome.content, details: outcome.details };
      },
      renderResult: proxyResultRenderer,
      ...PROXY_RENDERERS[name],
    }) as unknown as ToolDefinition<any, any>;

  const registerProxy = (name: string) => {
    if (!name || registeredProxies.has(name)) return;
    registeredProxies.add(name);
    pi.registerTool(claudeProxyTool(name));
  };
  for (const name of CLAUDE_TOOL_NAMES) registerProxy(name);

  /** Register proxies for tool names discovered at runtime and keep them active. */
  const rememberClaudeTools = (names: string[]) => {
    const fresh = names.filter((name) => name && !registeredProxies.has(name));
    if (fresh.length === 0) return;
    for (const name of fresh) registerProxy(name);
    state = { ...state, knownClaudeTools: [...new Set([...(state.knownClaudeTools ?? []), ...fresh])].sort() };
    persistState();
    if (activeContext?.model?.provider === PROVIDER) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...fresh])]);
    }
  };

  /** Swap Pi's active tools to the Claude proxies while the runtime drives, and back. */
  const applyToolScope = (provider: string | undefined) => {
    if (provider === PROVIDER) {
      if (state.savedActiveTools === undefined) {
        const nonProxy = pi.getActiveTools().filter((name) => !registeredProxies.has(name));
        state = { ...state, savedActiveTools: nonProxy };
        persistState();
      }
      pi.setActiveTools([...registeredProxies]);
    } else if (state.savedActiveTools !== undefined) {
      pi.setActiveTools(state.savedActiveTools);
      state = { ...state, savedActiveTools: undefined };
      persistState();
    }
  };

  const pumpRun = (run: ActiveRun, sdkQuery: AsyncIterable<SDKMessage>, piSessionId: string) => {
    void (async () => {
      const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
      const seenToolUses = new Set<string>();
      const seenToolResults = new Set<string>();
      try {
        for await (const message of sdkQuery) {
          if (
            "session_id" in message &&
            message.session_id &&
            message.session_id !== state.binding?.claudeSessionId
          ) {
            state = {
              ...state,
              binding: {
                claudeSessionId: message.session_id,
                piSessionId,
                cwd: activeContext?.cwd ?? process.cwd(),
                syncedThroughEntryId: state.binding?.syncedThroughEntryId,
              },
            };
            persistState();
          }
          const parentToolUseId = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? null;

          if (message.type === "stream_event") {
            if (!parentToolUseId) run.events.push({ kind: "stream_event", event: message.event });
            continue;
          }

          if (message.type === "assistant") {
            const apiUsage = (message.message as any).usage as
              | {
                  input_tokens?: number | null;
                  output_tokens?: number | null;
                  cache_read_input_tokens?: number | null;
                  cache_creation_input_tokens?: number | null;
                }
              | undefined;
            if (!parentToolUseId && apiUsage) {
              // This API call's prompt tokens are Claude's actual context size.
              run.events.push({
                kind: "usage",
                usage: {
                  input: apiUsage.input_tokens ?? 0,
                  output: apiUsage.output_tokens ?? 0,
                  cacheRead: apiUsage.cache_read_input_tokens ?? 0,
                  cacheWrite: apiUsage.cache_creation_input_tokens ?? 0,
                },
              });
            }
            const calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }> = [];
            for (const block of message.message.content as any[]) {
              if (block.type !== "tool_use" || seenToolUses.has(block.id)) continue;
              seenToolUses.add(block.id);
              pendingTools.set(block.id, { name: block.name, args: block.input ?? {} });
              setRuntimePhase(`Claude: ${block.name}`);
              if (!parentToolUseId) calls.push({ id: block.id, name: block.name, arguments: block.input ?? {} });
            }
            if (calls.length > 0) {
              rememberClaudeTools(calls.map((call) => call.name));
              run.events.push({ kind: "toolcalls", calls });
            }
            if (message.error) activity({ kind: "error", title: `Claude: ${message.error}`, isError: true });
            continue;
          }

          if (message.type === "user" && Array.isArray(message.message.content)) {
            const toolUseResult = (message as { tool_use_result?: unknown }).tool_use_result;
            for (const block of message.message.content as any[]) {
              if (block.type !== "tool_result" || seenToolResults.has(block.tool_use_id)) continue;
              seenToolResults.add(block.tool_use_id);
              const pending = pendingTools.get(block.tool_use_id);
              pendingTools.delete(block.tool_use_id);
              if (parentToolUseId) {
                // Subagent tools are not part of Pi's turn structure; keep them
                // as side-channel activity entries.
                const structuredPatch =
                  pending?.name === "Edit" && block.is_error !== true
                    ? structuredPatchFromToolUseResult(toolUseResult, pending.args.file_path)
                    : undefined;
                activity({
                  kind: "tool",
                  title: pending?.name ?? "Tool",
                  toolUseId: block.tool_use_id,
                  args: pending?.args ?? {},
                  result: summarize(block.content),
                  isError: block.is_error === true,
                  ...(structuredPatch ? { details: { structuredPatch } } : {}),
                });
                continue;
              }
              const outcome: SdkToolOutcome = {
                content: toolResultContent(block.content),
                details: toolUseResult,
                isError: block.is_error === true,
              };
              const waiter = run.pendingResults.get(block.tool_use_id);
              if (waiter) {
                run.pendingResults.delete(block.tool_use_id);
                waiter.resolve(outcome);
              } else {
                run.earlyResults.set(block.tool_use_id, outcome);
              }
            }
            continue;
          }

          if (message.type === "tool_progress") {
            setRuntimePhase(`Claude: ${message.tool_name} ${Math.round(message.elapsed_time_seconds)}s`);
            continue;
          }

          if (message.type === "system") {
            if (message.subtype === "init") {
              rememberClaudeTools((message as { tools?: string[] }).tools ?? []);
            } else if (message.subtype === "compact_boundary") {
              const metadata = (message as any).compact_metadata ?? {};
              const tokens =
                typeof metadata.pre_tokens === "number"
                  ? ` (${Math.round(metadata.pre_tokens / 1000)}k${
                      typeof metadata.post_tokens === "number"
                        ? ` → ${Math.round(metadata.post_tokens / 1000)}k`
                        : ""
                    } tokens)`
                  : "";
              activity({
                kind: "status",
                title: `Claude compacted its context${metadata.trigger === "auto" ? " automatically" : ""}${tokens}`,
              });
              setRuntimePhase("Claude: continuing");
            } else if (message.subtype === "status") {
              const statusMessage = message as any;
              if (statusMessage.status === "compacting") setRuntimePhase("Claude: compacting");
              if (statusMessage.compact_result === "failed") {
                activity({
                  kind: "error",
                  title: "Claude context compaction failed",
                  detail: statusMessage.compact_error,
                  isError: true,
                });
              }
            } else {
              const systemMessage = message as any;
              const label = systemMessage.summary ?? systemMessage.description ?? systemMessage.text;
              if (label) setRuntimePhase(`Claude: ${summarize(label, 60)}`);
            }
            continue;
          }

          if (message.type === "result") {
            run.events.push({ kind: "result", message });
            continue;
          }
        }
      } catch (error) {
        run.events.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        run.events.close();
        for (const waiter of run.pendingResults.values()) {
          waiter.resolve({
            content: [{ type: "text", text: "The Claude runtime run ended before this tool result arrived." }],
            details: undefined,
            isError: true,
          });
        }
        run.pendingResults.clear();
      }
    })();
  };

  const streamClaudeRuntime = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output = makeOutput(model);

    void (async () => {
      const abort = () => activeRun?.abortController.abort();
      options?.signal?.addEventListener("abort", abort, { once: true });
      try {
        const piSessionId = activeContext?.sessionManager.getSessionId() ?? "ephemeral";
        const lastMessage = context.messages[context.messages.length - 1] as { role?: string } | undefined;
        const continuing =
          activeRun !== undefined &&
          activeRun.piSessionId === piSessionId &&
          !activeRun.abortController.signal.aborted &&
          lastMessage?.role === "toolResult";

        if (continuing) {
          stream.push({ type: "start", partial: output });
          setRuntimePhase("Claude: continuing");
        } else {
          if (activeRun) {
            // A new user message arrived (steering or a fresh turn) while a run
            // was still open; Claude session resume carries the context over.
            activeRun.abortController.abort();
            activeRun = undefined;
          }
          const userContent = lastUserContent(context);
          const promptText = lastUserText(context);
          if (userContent.length === 0) throw new Error("Claude Agent SDK requires a user prompt.");

          const branch = activeContext?.sessionManager.getBranch() ?? [];
          const currentUserEntry = [...branch].reverse().find(
            (entry) => entry.type === "message" && entry.message.role === "user",
          );
          const bindingMatchesSession =
            state.binding?.piSessionId === piSessionId && state.binding.cwd === (activeContext?.cwd ?? process.cwd());
          if (state.binding && !bindingMatchesSession) {
            state = { ...state, binding: undefined };
          }

          const range = getHandoffRange(
            branch,
            state.binding?.syncedThroughEntryId,
            currentUserEntry?.id,
          );
          if (range.divergent) {
            state = { ...state, binding: undefined, pendingHandoff: undefined };
          }
          // Rounds and tool results produced by the Claude runtime itself are
          // already in Claude's own session; only foreign content needs a
          // handoff. Judged on the raw range so a Pi-side compaction of pure
          // Claude-runtime history does not masquerade as foreign content.
          const needsHandoff = needsClaudeHandoff(range.rawMessages, PROVIDER);

          let handoff: PendingHandoff | undefined = state.pendingHandoff;
          if (!handoff && range.messages.length > 0 && needsHandoff) {
            setRuntimePhase("Claude: preparing handoff");
            handoff = {
              kind: state.binding && !range.divergent ? "catch-up" : "bootstrap",
              summary: await generateHandoffSummary(
                activeContext!,
                handoffSourceModel,
                range.messages,
                promptText,
                options?.signal,
              ),
              throughEntryId: range.throughEntryId,
            };
            state = { ...state, pendingHandoff: handoff };
            persistState();
          }

          const effectiveText = handoff
            ? wrapHandoff(handoff.summary, handoff.kind, handoff.throughEntryId, promptText)
            : promptText;
          const effectiveContent = userContent.map((block, index) =>
            block.type === "text" && index === userContent.findIndex((item) => item.type === "text")
              ? { ...block, text: effectiveText }
              : block,
          );
          if (!effectiveContent.some((block) => block.type === "text")) {
            effectiveContent.unshift({ type: "text", text: effectiveText });
          }
          const hasImages = effectiveContent.some((block) => block.type === "image");
          const prompt = hasImages
            ? (async function* (): AsyncGenerator<SDKUserMessage> {
                yield {
                  type: "user",
                  message: {
                    role: "user",
                    content: effectiveContent.map((block) =>
                      block.type === "text"
                        ? block
                        : {
                            type: "image" as const,
                            source: {
                              type: "base64" as const,
                              media_type: block.mimeType as "image/gif" | "image/jpeg" | "image/png" | "image/webp",
                              data: block.data,
                            },
                          },
                    ),
                  },
                  parent_tool_use_id: null,
                  session_id: "",
                };
              })()
            : effectiveText;

          stream.push({ type: "start", partial: output });
          setRuntimePhase(state.binding ? "Claude: resuming" : "Claude: starting");

          const run: ActiveRun = {
            piSessionId,
            abortController: new AbortController(),
            events: new AsyncQueue<RunEvent>(),
            pendingResults: new Map(),
            earlyResults: new Map(),
          };
          activeRun = run;

          const sdkQuery = query({
            prompt,
            options: {
              cwd: activeContext?.cwd ?? process.cwd(),
              model: model.id,
              pathToClaudeCodeExecutable: binary,
              systemPrompt: { type: "preset", preset: "claude_code" },
              tools: { type: "preset", preset: "claude_code" },
              settingSources: ["user", "project", "local"],
              includePartialMessages: true,
              forwardSubagentText: true,
              abortController: run.abortController,
              canUseTool,
              ...(state.binding ? { resume: state.binding.claudeSessionId } : {}),
              ...(state.permission === "full-access"
                ? { permissionMode: "bypassPermissions", allowDangerouslySkipPermissions: true }
                : { permissionMode: "default" }),
              ...(effortFor(options?.reasoning) ? { effort: effortFor(options?.reasoning) } : {}),
              ...(thinkingFor(model.id, options?.reasoning, options?.thinkingBudgets)
                ? { thinking: thinkingFor(model.id, options?.reasoning, options?.thinkingBudgets) }
                : {}),
              env: {
                ...process.env,
                CLAUDE_AGENT_SDK_CLIENT_APP: "pi-claude-runtime/0.1.0",
              },
            },
          });
          pumpRun(run, sdkQuery as AsyncIterable<SDKMessage>, piSessionId);
        }

        const run = activeRun!;
        const reason = await drainRound(run.events, output, stream, {
          onPhase: setRuntimePhase,
          aborted: () => run.abortController.signal.aborted || options?.signal?.aborted === true,
        });

        if (reason === "toolUse") {
          // The handoff reached Claude's session; a steering restart must not resend it.
          if (state.pendingHandoff) {
            state = { ...state, pendingHandoff: undefined };
            persistState();
          }
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end();
          return;
        }

        activeRun = undefined;
        if (state.binding) {
          const branch = activeContext?.sessionManager.getBranch() ?? [];
          const currentUserEntry = [...branch].reverse().find(
            (entry) => entry.type === "message" && entry.message.role === "user",
          );
          state = {
            ...state,
            binding: {
              ...state.binding,
              syncedThroughEntryId: currentUserEntry?.id ?? state.binding.syncedThroughEntryId,
            },
            pendingHandoff: undefined,
          };
          persistState();
        }
        handoffSourceModel = undefined;
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
      } catch (error) {
        const aborted =
          options?.signal?.aborted === true || activeRun?.abortController.signal.aborted === true;
        if (activeRun) {
          activeRun.abortController.abort();
          activeRun = undefined;
        }
        output.stopReason = aborted ? "aborted" : "error";
        output.errorMessage = error instanceof Error ? error.message : String(error);
        activity({ kind: "error", title: "Claude runtime failed", detail: output.errorMessage, isError: true });
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      } finally {
        setRuntimePhase("Claude: idle");
        options?.signal?.removeEventListener("abort", abort);
      }
    })();

    return stream;
  };

  type ToolActivity = Extract<Activity, { kind: "tool" }>;

  // The built-in edit tool recomputes its diff preview from the file on disk,
  // but Claude Code has already applied the edit by the time this entry
  // renders — the old text is gone, so that preview reports a bogus
  // "Could not find the exact text" failure. Render the recorded outcome instead.
  const recordedEditDiff = (data: ToolActivity): string | undefined => {
    if (data.details?.structuredPatch?.length) {
      return structuredPatchToDiffString(data.details.structuredPatch);
    }
    if (data.isError) return undefined;
    // Entries recorded without a structured patch: approximate with a diff of
    // the replaced block itself (line numbers are relative to the block).
    const oldText = data.args.old_string;
    const newText = data.args.new_string;
    if (typeof oldText !== "string" || typeof newText !== "string") return undefined;
    return generateDiffString(oldText, newText).diff;
  };

  const recordedEditDefinition = (data: ToolActivity): ToolDefinition<any, any> =>
    ({
      name: "edit",
      label: "edit",
      description: "Edit recorded from the Claude runtime",
      parameters: undefined,
      execute: async () => {
        throw new Error("Recorded Claude runtime edits cannot be re-executed.");
      },
      renderShell: "default",
      renderCall: (_args: unknown, theme: Theme) => {
        const container = new Container();
        container.addChild(
          new Text(
            `${theme.fg("toolTitle", theme.bold("edit"))} ${displayPath(data.args.file_path)}`,
            0,
            0,
          ),
        );
        const diff = recordedEditDiff(data);
        if (diff) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(renderDiff(diff), 0, 0));
        }
        return container;
      },
      renderResult: (
        result: { content: Array<{ type: string; text?: string }> },
        _options: unknown,
        theme: Theme,
      ) => {
        const container = new Container();
        if (!data.isError) return container;
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
        if (!text) return container;
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("error", text), 0, 0));
        return container;
      },
    }) as unknown as ToolDefinition<any, any>;

  pi.registerEntryRenderer<Activity>(ACTIVITY_ENTRY, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data) return new Text("", 0, 0);
    if (data.kind !== "tool") {
      return new Text(
        `${data.isError ? theme.fg("error", "✗") : theme.fg("accent", "●")} ${theme.bold(data.title)}${data.detail ? `\n${theme.fg("muted", data.detail)}` : ""}`,
        0,
        0,
      );
    }

    const mapped = toPiTool(data.title, data.args);
    const component = new ToolExecutionComponent(
      mapped.name,
      data.toolUseId,
      mapped.args,
      { showImages: true },
      data.title === "Edit" ? recordedEditDefinition(data) : undefined,
      { requestRender: () => {} } as TUI,
      activeContext?.cwd ?? process.cwd(),
    );
    component.markExecutionStarted();
    component.setArgsComplete();
    component.updateResult(
      { content: [{ type: "text", text: data.result }], isError: data.isError },
      false,
    );
    component.setExpanded(expanded);
    return component;
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    state = { ...DEFAULT_STATE };
    const branch = ctx.sessionManager.getBranch();
    for (const entry of branch) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY) state = entry.data as RuntimeState;
    }
    if (state.claudeSessionId && !state.binding) {
      const lastClaudeEntry = [...branch].reverse().find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.provider === PROVIDER,
      );
      state = {
        ...state,
        claudeSessionId: undefined,
        binding: {
          claudeSessionId: state.claudeSessionId,
          piSessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
          syncedThroughEntryId: lastClaudeEntry?.id,
        },
      };
      persistState();
    }
    if (activeRun && activeRun.piSessionId !== ctx.sessionManager.getSessionId()) {
      activeRun.abortController.abort();
      activeRun = undefined;
    }
    for (const name of state.knownClaudeTools ?? []) registerProxy(name);
    applyToolScope(ctx.model?.provider);
    setRuntimePhase("Claude: idle");
    void refreshVersion();
  });
  pi.on("before_agent_start", (_event, ctx) => { activeContext = ctx; });
  pi.on("model_select", (event, ctx) => {
    activeContext = ctx;
    if (event.model.provider === PROVIDER && event.previousModel?.provider !== PROVIDER) {
      handoffSourceModel = event.previousModel as Model<Api> | undefined;
    }
    if (event.model.provider !== PROVIDER && activeRun) {
      activeRun.abortController.abort();
      activeRun = undefined;
    }
    applyToolScope(event.model.provider);
    publishRuntimeStatus();
  });
  pi.on("turn_end", (event, ctx) => {
    if (
      event.message.role !== "assistant" ||
      event.message.provider !== PROVIDER ||
      event.message.stopReason !== "stop" ||
      !state.binding
    ) return;
    const assistantEntry = [...ctx.sessionManager.getBranch()].reverse().find(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        entry.message.provider === PROVIDER &&
        entry.message.timestamp === event.message.timestamp,
    );
    if (!assistantEntry) return;
    state = {
      ...state,
      binding: { ...state.binding, syncedThroughEntryId: assistantEntry.id },
    };
    persistState();
  });
  pi.on("session_before_compact", (event, ctx) => {
    // While the Claude runtime is bound, Pi's context is never sent to an API —
    // Claude Code manages (and compacts) its own session, and the usage we
    // report reflects Claude's context, not Pi's. Threshold/overflow
    // compactions triggered by those numbers would only spend tokens
    // summarizing history Pi never transmits. Manual /compact stays honored.
    if (event.reason !== "manual" && ctx.model?.provider === PROVIDER && state.binding) {
      return { cancel: true };
    }
    return undefined;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_ID, undefined);
    activeContext = undefined;
  });

  pi.registerCommand("handoff-claude", {
    description: "Generate a compaction-aware handoff and switch to Claude Runtime",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("handoff-claude requires interactive mode", "error");
        return;
      }
      const goal = args.trim() || "Continue the current work.";
      const sourceModel = ctx.model as Model<Api> | undefined;
      const branch = ctx.sessionManager.getBranch();
      const range = getHandoffRange(branch, state.binding?.syncedThroughEntryId);
      if (range.messages.length === 0) {
        ctx.ui.notify("No Pi conversation state needs to be handed off.", "info");
      }

      const summary = await ctx.ui.custom<string | null>((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(tui, theme, "Generating Claude handoff...");
        loader.onAbort = () => done(null);
        generateHandoffSummary(ctx, sourceModel, range.messages, goal, loader.signal)
          .then(done)
          .catch(() => done(null));
        return loader;
      });
      if (summary === null) {
        ctx.ui.notify("Claude handoff cancelled.", "info");
        return;
      }
      const edited = await ctx.ui.editor("Edit Claude handoff", summary);
      if (edited === undefined) return;

      if (range.divergent) state = { ...state, binding: undefined };
      state = {
        ...state,
        pendingHandoff: {
          kind: state.binding && !range.divergent ? "catch-up" : "bootstrap",
          summary: edited,
          throughEntryId: range.throughEntryId,
        },
      };
      persistState();

      let target = ctx.model?.provider === PROVIDER ? ctx.model : undefined;
      if (!target) {
        const selected = await ctx.ui.select(
          "Claude model",
          CLAUDE_RUNTIME_MODELS.map((model) => model.id),
        );
        if (!selected) return;
        target = ctx.modelRegistry.find(PROVIDER, selected);
      }
      if (!target || !(await pi.setModel(target))) {
        ctx.ui.notify("Could not select the Claude Runtime model.", "error");
        return;
      }
      if (sourceModel?.provider !== PROVIDER) handoffSourceModel = sourceModel;
      ctx.ui.setEditorText(goal);
      ctx.ui.notify("Claude handoff is ready. Submit the prepared request.", "info");
    },
  });

  pi.registerCommand("claude-permissions", {
    description: "Toggle Claude runtime permissions: full-access or interactive",
    handler: async (args, ctx) => {
      const requested = args.trim();
      const permission = requested === "interactive" || requested === "full-access"
        ? requested
        : await ctx.ui.select("Claude tool permissions", ["full-access", "interactive"]);
      if (permission !== "interactive" && permission !== "full-access") return;
      state = { ...state, permission };
      persistState();
      ctx.ui.notify(`Claude runtime permissions: ${permission}`, "info");
    },
  });

  pi.registerCommand("claude-version", {
    description: "Check the installed and latest Claude Code CLI versions",
    handler: async (_args, ctx) => {
      const version = await refreshVersion();
      const message = version.current
        ? version.updateAvailable
          ? `Claude Code ${version.current} → ${version.latest} is available. Run /claude-update.`
          : `Claude Code ${version.current} is current.`
        : "Could not determine the installed Claude Code version.";
      ctx.ui.notify(message, version.updateAvailable ? "warning" : "info");
    },
  });

  pi.registerCommand("claude-update", {
    description: "Update the Claude Code CLI using its detected installation method",
    handler: async (_args, ctx) => {
      const update = await resolveClaudeUpdateCommand(binary);
      ctx.ui.notify(`Running: ${update.command} ${update.args.join(" ")}`, "info");
      const result = await pi.exec(update.command, update.args, { timeout: 5 * 60_000 });
      if (result.code !== 0) {
        ctx.ui.notify(result.stderr.trim() || result.stdout.trim() || "Claude Code update failed.", "error");
        return;
      }
      const version = await refreshVersion();
      ctx.ui.notify(
        version.current ? `Claude Code is now ${version.current}.` : "Claude Code update completed.",
        "info",
      );
    },
  });

  pi.registerProvider(PROVIDER, {
    name: "Claude Runtime (Agent SDK)",
    baseUrl: "agent-sdk://local",
    apiKey: "agent-sdk",
    api: "anthropic-messages",
    streamSimple: streamClaudeRuntime,
    models: CLAUDE_RUNTIME_MODELS.map((model) => ({ ...model, input: [...model.input] })),
  });
}
