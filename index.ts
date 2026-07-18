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
  ToolExecutionComponent,
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
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import { CLAUDE_RUNTIME_MODELS } from "./src/models.js";
import {
  generateHandoffSummary,
  getHandoffRange,
  wrapHandoff,
} from "./src/handoff.js";
import {
  checkClaudeVersion,
  type ClaudeVersionState,
  resolveClaudeUpdateCommand,
} from "./src/maintenance.js";
import {
  type Activity,
  DEFAULT_STATE,
  effortFor,
  lastUserContent,
  lastUserText,
  type PendingHandoff,
  type RuntimeState,
  summarize,
  thinkingFor,
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

type InternalBlock =
  | { type: "text"; text: string; providerIndex: number }
  | { type: "thinking"; thinking: string; thinkingSignature: string; providerIndex: number };

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

  const streamClaudeRuntime = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const output = makeOutput(model);

    void (async () => {
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      options?.signal?.addEventListener("abort", abort, { once: true });
      let resultError: string | undefined;
      let emittedText = false;
      const seenToolUses = new Set<string>();
      const seenToolResults = new Set<string>();
      const pendingTools = new Map<string, { name: string; args: Record<string, unknown> }>();
      let currentBlocks = new Map<number, number>();

      try {
        const userContent = lastUserContent(context);
        const promptText = lastUserText(context);
        if (userContent.length === 0) throw new Error("Claude Agent SDK requires a user prompt.");

        const branch = activeContext?.sessionManager.getBranch() ?? [];
        const currentUserEntry = [...branch].reverse().find(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
        const piSessionId = activeContext?.sessionManager.getSessionId() ?? "ephemeral";
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

        let handoff: PendingHandoff | undefined = state.pendingHandoff;
        if (!handoff && range.messages.length > 0) {
          setRuntimePhase("Claude: preparing handoff");
          handoff = {
            kind: state.binding && !range.divergent ? "catch-up" : "bootstrap",
            summary: await generateHandoffSummary(
              activeContext!,
              handoffSourceModel,
              range.messages,
              promptText,
              abortController.signal,
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
            abortController,
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

        for await (const message of sdkQuery as AsyncIterable<SDKMessage>) {
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

          if (message.type === "stream_event") {
            const event = message.event as any;
            if (event.type === "message_start") {
              currentBlocks = new Map();
              setRuntimePhase("Claude: thinking");
            }
            if (event.type === "content_block_start") {
              if (event.content_block?.type === "text") {
                setRuntimePhase("Claude: responding");
                const index = output.content.length;
                (output.content as InternalBlock[]).push({ type: "text", text: "", providerIndex: event.index });
                currentBlocks.set(event.index, index);
                stream.push({ type: "text_start", contentIndex: index, partial: output });
              } else if (event.content_block?.type === "thinking") {
                setRuntimePhase("Claude: thinking");
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
                delete (block as { providerIndex?: number }).providerIndex;
                stream.push({ type: "text_end", contentIndex: index!, content: block.text, partial: output });
              } else if (block?.type === "thinking") {
                delete (block as { providerIndex?: number }).providerIndex;
                stream.push({ type: "thinking_end", contentIndex: index!, content: block.thinking, partial: output });
              }
            }
            continue;
          }

          if (message.type === "assistant") {
            for (const block of message.message.content as any[]) {
              if (block.type !== "tool_use" || seenToolUses.has(block.id)) continue;
              seenToolUses.add(block.id);
              pendingTools.set(block.id, { name: block.name, args: block.input ?? {} });
              setRuntimePhase(`Claude: ${block.name}`);
            }
            if (message.error) activity({ kind: "error", title: `Claude: ${message.error}`, isError: true });
            continue;
          }

          if (message.type === "user" && Array.isArray(message.message.content)) {
            for (const block of message.message.content as any[]) {
              if (block.type !== "tool_result" || seenToolResults.has(block.tool_use_id)) continue;
              seenToolResults.add(block.tool_use_id);
              const pending = pendingTools.get(block.tool_use_id);
              activity({
                kind: "tool",
                title: pending?.name ?? "Tool",
                toolUseId: block.tool_use_id,
                args: pending?.args ?? {},
                result: summarize(block.content),
                isError: block.is_error === true,
              });
              pendingTools.delete(block.tool_use_id);
            }
            continue;
          }

          if (message.type === "tool_progress") {
            setRuntimePhase(`Claude: ${message.tool_name} ${Math.round(message.elapsed_time_seconds)}s`);
            continue;
          }

          if (message.type === "system" && message.subtype !== "init") {
            const systemMessage = message as any;
            const label = systemMessage.summary ?? systemMessage.description ?? systemMessage.text;
            if (label) setRuntimePhase(`Claude: ${summarize(label, 60)}`);
            continue;
          }

          if (message.type === "result") {
            output.usage.input = message.usage.input_tokens ?? 0;
            output.usage.output = message.usage.output_tokens ?? 0;
            output.usage.cacheRead = message.usage.cache_read_input_tokens ?? 0;
            output.usage.cacheWrite = message.usage.cache_creation_input_tokens ?? 0;
            output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
            output.usage.cost.total = message.total_cost_usd ?? 0;
            if (message.subtype !== "success") resultError = message.errors.join("\n") || message.subtype;
            else if (!emittedText && message.result) {
              const index = output.content.length;
              output.content.push({ type: "text", text: message.result });
              stream.push({ type: "text_start", contentIndex: index, partial: output });
              stream.push({ type: "text_delta", contentIndex: index, delta: message.result, partial: output });
              stream.push({ type: "text_end", contentIndex: index, content: message.result, partial: output });
            }
          }
        }

        if (resultError) throw new Error(resultError);
        if (abortController.signal.aborted) throw new Error("Claude Agent SDK request aborted.");
        if (state.binding) {
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
        output.stopReason = abortController.signal.aborted ? "aborted" : "error";
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
      undefined,
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
    setRuntimePhase("Claude: idle");
    void refreshVersion();
  });
  pi.on("before_agent_start", (_event, ctx) => { activeContext = ctx; });
  pi.on("model_select", (event, ctx) => {
    activeContext = ctx;
    if (event.model.provider === PROVIDER && event.previousModel?.provider !== PROVIDER) {
      handoffSourceModel = event.previousModel as Model<Api> | undefined;
    }
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
