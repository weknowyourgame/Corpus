import { useState, useCallback, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  ChatContainerRoot,
  ChatContainerContent,
  ChatContainerFollow,
} from "@/components/ui/chat-container";
import { ScrollButton } from "@/components/ui/scroll-button";
import { MessageContent } from "@/components/ui/message";
import { ToolCalls } from "@/components/ui/tool-call";
import { Loader } from "@/components/ui/loader";
import { StudAppHeader } from "@/stud-ui";
import { StudComposer } from "@/stud-ui/StudComposer";
import { BotAvatar, UserAvatar } from "@/components/icons/Avatars";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { ContextChips, ChipAction } from "@/components/chat/ContextChips";
import { QuestionPrompt } from "@/components/chat/QuestionPrompt";
import { ApprovalPrompt } from "@/components/chat/ApprovalPrompt";
import { InstancePicker } from "@/components/chat/InstancePicker";
import { MutationDiff } from "@/components/chat/MutationDiff";
import { ConnectionBadges } from "@/components/chat/ConnectionBadges";
import { RecoveryBanner } from "@/components/chat/RecoveryBanner";
import { RunContextNotice } from "@/components/chat/RunContextNotice";
import { compatibleServerSelection } from "@/components/chat/model-routing";
import { buildChatSubmission, classifyToolOutput } from "@/components/chat/intents";
import { ChatActions } from "@/components/QuickActions";
import { CommandPalette } from "@/components/CommandPalette";
import { EmptyState } from "@/components/EmptyState";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { useRobloxStore, ConnectionStatus } from "@/stores/roblox";
import { usePluginStore } from "@/stores/plugin";
import {
  cancelServerRun,
  clearServerConversation,
  getServerProviderConfig,
  loadServerMessages,
  resumeServerRun,
  sendServerMessage,
  type ApprovalDecision,
  type ApprovalRequest,
  type MutationResult,
} from "@/lib/ai/server-agent";
import { useAppShortcuts } from "@/hooks/useKeyboardShortcuts";
import { cn } from "@/lib/utils";
import { SessionCode } from "@/components/SessionCode";
import { ArrowUp, Square, CheckCircle2, Download, FolderOpen, RefreshCw, Box, FileText, Play, ListTodo } from "lucide-react";

const SUGGESTIONS = [
  // Gameplay systems
  "Create an NPC that follows players",
  "Add a currency system with DataStore",
  "Make a gun that shoots projectiles",
  "Design a shop GUI with items",
  "Build a checkpoint system for an obby",
  "Create a leaderboard that saves scores",
  "Make doors that require keys to open",
  "Add a day/night cycle with lighting",
  // UI & Effects
  "Design a main menu with play button",
  "Create floating damage numbers",
  "Add a health bar above players",
  "Make a settings menu with sound toggle",
  // Mechanics
  "Create a sprinting system with stamina",
  "Add double jump ability",
  "Make a grappling hook tool",
  "Build a vehicle spawner",
  // World building
  "Find free models for a forest scene",
  "Create a teleporter between areas",
  "Add ambient sounds to the game",
  "Make parts that change color on touch",
  // Advanced
  "Set up a round-based game system",
  "Create an inventory system",
  "Add achievements that unlock badges",
  "Build a trading system between players",
];

function ConnectionStep({
  step,
  title,
  description,
  status,
}: {
  step: number;
  title: string;
  description: string;
  status: "pending" | "active" | "complete";
}) {
  return (
    <div className="stud-step-row">
      <div
        className={cn(
          "stud-step-num",
          status === "complete" && "is-complete",
          status === "active" && "is-active"
        )}
      >
        {status === "complete" ? (
          <CheckCircle2 className="w-4 h-4" />
        ) : status === "active" ? (
          <Loader variant="circular" size="sm" />
        ) : (
          step
        )}
      </div>
      <div className="flex-1 pt-0.5">
        <h3 className="font-medium text-[15px]">{title}</h3>
        <p className="text-sm mt-0.5" style={{ color: "var(--stud-muted)" }}>
          {description}
        </p>
      </div>
    </div>
  );
}

// Connection screen shown when bridge is not connected
function ConnectionScreen({ status }: { status: ConnectionStatus }) {
  const { 
    status: pluginStatus, 
    isChecking, 
    checkPlugin, 
  } = usePluginStore();
  
  const [showManualPath, setShowManualPath] = useState(false);

  // Check plugin status on mount
  useEffect(() => {
    checkPlugin();
  }, [checkPlugin]);

  const handleDownloadPlugin = async () => {
    // Fetch the plugin content and trigger download
    try {
      const response = await fetch("/studio-plugin/stud-bridge.server.lua");
      if (!response.ok) {
        // If not available via fetch, we'll use the embedded version from Tauri
        // For now, show manual path
        setShowManualPath(true);
        return;
      }
      const content = await response.text();
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "stud-bridge.server.lua";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setShowManualPath(true);
    }
  };

  const getStepStatus = (step: 1 | 2 | 3 | 4): "pending" | "active" | "complete" => {
    if (status === "connected") return "complete";
    if (status === "bridge_only") {
      if (step <= 3) return "complete";
      return "active";
    }
    if (status === "disconnected") {
      if (step === 1) return "active";
      return "pending";
    }
    return "pending";
  };

  const pluginInstalled = pluginStatus?.installed && pluginStatus?.is_current_version;

  return (
    <div className="stud-app-shell stud-workbench">
      <div className="stud-atmosphere" aria-hidden="true" />
      <StudAppHeader status={status} trailing={<SettingsDialog />} />

      <main className="stud-connection-layout">
        <div className="stud-connection-stack">
          <div className="text-center">
            <span className="stud-eyebrow">OPEN A LIVE SCENE</span>
            <h1 className="stud-display-title mt-6" style={{ fontSize: "2.25rem" }}>
              Connect Roblox Studio
            </h1>
            <div className="stud-display-subtitle">
              <Loader variant="terminal" text="Waiting for Roblox Studio" size="sm" />
            </div>
          </div>

          <SessionCode />
          <ConnectionBadges status={status} />
          <div className="stud-agent-tasks stud-agent-tasks-connection" aria-hidden="true">
            <div className="stud-agent-task is-active"><span />Bridge check <strong>Polling Studio</strong></div>
            <div className="stud-agent-task"><span />Task ready <strong>Install plugin</strong></div>
            <div className="stud-agent-task"><span />Safety on <strong>Approvals locked</strong></div>
          </div>

          <div className="stud-panel p-6 space-y-5">
            <ConnectionStep
              step={1}
              title="Bridge server running"
              description="Started automatically with npm run dev"
              status={getStepStatus(1)}
            />

            <div className="stud-divider ml-4 w-8" />

            <ConnectionStep
              step={2}
              title="Install the Stud plugin"
              description="Download and copy to your Roblox Plugins folder"
              status={getStepStatus(2)}
            />

            <div className="stud-divider ml-4 w-8" />

            <ConnectionStep
              step={3}
              title="Open Roblox Studio"
              description="Enable HTTP requests in Game Settings → Security"
              status={getStepStatus(3)}
            />

            <div className="stud-divider ml-4 w-8" />

            <ConnectionStep
              step={4}
              title="Connect in Studio"
              description="Paste your session code in the plugin and click Connect"
              status={getStepStatus(4)}
            />
          </div>

          <div className="stud-panel p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-medium">Plugin Status</span>
                {isChecking ? (
                  <Loader variant="circular" size="sm" />
                ) : pluginInstalled ? (
                  <span className="status-pill">
                    <span style={{ background: "#2f9c63" }} />
                    Installed
                  </span>
                ) : pluginStatus?.installed ? (
                  <span className="status-pill">Update available</span>
                ) : (
                  <span className="status-pill">Not installed</span>
                )}
              </div>
              <button
                type="button"
                className="stud-icon-btn"
                onClick={() => checkPlugin()}
                disabled={isChecking}
              >
                <RefreshCw className={cn("w-4 h-4", isChecking && "animate-spin")} />
              </button>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleDownloadPlugin} className="flex-1">
                <Download className="w-4 h-4 mr-2" />
                Download Plugin
              </Button>
              <Button
                variant="outline"
                onClick={handleDownloadPlugin}
                title="Download plugin file for manual installation"
              >
                <FolderOpen className="w-4 h-4" />
              </Button>
            </div>

            {showManualPath && pluginStatus && (
              <div className="stud-panel-soft p-3 text-xs space-y-1" style={{ color: "var(--stud-muted)" }}>
                <p className="font-medium" style={{ color: "var(--stud-text)" }}>
                  Manual installation
                </p>
                <p>Copy the plugin to your Roblox Plugins folder:</p>
                <code
                  className="block px-2 py-1 rounded text-xs break-all"
                  style={{ background: "var(--stud-soft)", fontFamily: "var(--stud-tech)" }}
                >
                  {pluginStatus.plugins_folder}
                </code>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export function Home() {
  const [input, setInput] = useState("");
  const [activeChips, setActiveChips] = useState<ChipAction[]>([]);
  const [displayedSuggestions, setDisplayedSuggestions] = useState<string[]>([]);
  const [serverProviders, setServerProviders] = useState({ anthropic: false, openrouter: false, codex: false });
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [mutationResults, setMutationResults] = useState<Array<MutationResult & { id: string }>>([]);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const approvalResolver = useRef<((decision: ApprovalDecision) => void) | null>(null);
  const {
    messages,
    isStreaming,
    error,
    pendingQuestion,
    addMessage,
    updateMessage,
    addToolCall,
    updateToolCall,
    setStreaming,
    setError,
    setPendingQuestion,
    setQuestionResolver,
    answerQuestion,
    clearMessages,
    replaceMessages,
  } = useChatStore();
  const { selectedModel, selectedProvider, setSelectedModel } = useSettingsStore();
  const { status: studioStatus, transport: studioTransport, startPolling } = useRobloxStore();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const requestApproval = useCallback((approval: ApprovalRequest) => new Promise<ApprovalDecision>((resolve) => {
    setPendingApproval(approval);
    approvalResolver.current = resolve;
  }), []);
  const answerApproval = useCallback((decision: ApprovalDecision) => {
    approvalResolver.current?.(decision);
    approvalResolver.current = null;
    setPendingApproval(null);
  }, []);
  const handleClearChat = useCallback(async () => {
    await clearServerConversation();
    if (pendingApproval) answerApproval("deny");
    if (pendingQuestion) answerQuestion([]);
    setPendingApproval(null);
    setPendingQuestion(null);
    setRunNotice(null);
    setError(null);
    clearMessages();
  }, [pendingApproval, pendingQuestion, answerApproval, answerQuestion, setPendingQuestion, setError, clearMessages]);

  // Keyboard shortcuts
  useAppShortcuts({
    onClearChat: () => {
      if (messages.length > 0 && !isStreaming) {
        handleClearChat();
      }
    },
    onFocusInput: () => {
      inputRef.current?.focus();
    },
  });

  // Start polling for connection on mount
  useEffect(() => {
    const cleanup = startPolling();
    return cleanup;
  }, [startPolling]);

  // Shuffle and pick random suggestions on mount and when messages clear
  useEffect(() => {
    const shuffled = [...SUGGESTIONS].sort(() => Math.random() - 0.5);
    setDisplayedSuggestions(shuffled.slice(0, 4));
  }, [messages.length === 0]);

  useEffect(() => {
    void getServerProviderConfig().then(setServerProviders);
  }, []);

  useEffect(() => {
    const selection = compatibleServerSelection(selectedProvider, selectedModel, serverProviders);
    if (!selection || (selection.provider === selectedProvider && selection.model === selectedModel)) return;
    setSelectedModel(selection.model, selection.provider);
  }, [serverProviders, selectedModel, selectedProvider, setSelectedModel]);

  useEffect(() => {
    if (studioStatus !== "connected" || messages.length) return;
    void loadServerMessages().then(async (saved) => {
      if (saved.length) replaceMessages(saved);
      let assistantId: string | null = null;
      let fullText = "";
      const target = () => {
        assistantId ??= addMessage({ role: "assistant", content: "" });
        return assistantId;
      };
      const resumed = await resumeServerRun({
        onToken: (token) => {
          fullText += token;
          updateMessage(target(), fullText);
        },
        onToolCall: (call) => {
          addToolCall(target(), { id: call.id, name: call.name, args: call.input });
          updateToolCall(target(), call.id, { status: "running" });
        },
        onToolResult: (result) => updateToolCall(target(), result.id, { ...classifyToolOutput(result.output), result: result.output }),
        onInteraction: (_id, questions) => new Promise((resolve) => {
          setPendingQuestion({ id: crypto.randomUUID(), toolCallId: "", messageId: target(), questions });
          setQuestionResolver(resolve);
        }),
        onApproval: (approval) => {
          updateToolCall(target(), approval.toolCallId, { status: "waiting" });
          return requestApproval(approval);
        },
        onMutationResult: (result) => {
          setMutationResults((prev) => [{ ...result, id: result.transactionId }, ...prev]);
        },
        onFinish: () => {
          setPendingApproval(null);
          setStreaming(false);
        },
        onError: (failure) => {
          setError(failure.message);
          setStreaming(false);
        },
      });
      if (resumed) setStreaming(true);
    });
  }, [
    studioStatus,
    messages.length,
    replaceMessages,
    addMessage,
    updateMessage,
    addToolCall,
    updateToolCall,
    setPendingQuestion,
    setQuestionResolver,
    requestApproval,
    setStreaming,
    setError,
  ]);

  const hasConfiguredProvider = serverProviders[selectedProvider];
  const hasAnyServerProvider = Object.values(serverProviders).some(Boolean);
  const isConnected = studioStatus === "connected";

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();
    const submission = buildChatSubmission(userMessage, activeChips);

    setInput("");
    setActiveChips([]); // Clear chips after submit

    // Add user message (show without context prefix for cleaner UI, but store chips)
    addMessage({ role: "user", content: userMessage, contextChips: activeChips.length > 0 ? [...activeChips] : undefined });

    // Add placeholder for assistant
    const assistantId = addMessage({ role: "assistant", content: "" });

    setStreaming(true);
    setError(null);
    setRunNotice(null);

    try {
      let fullText = "";

      await sendServerMessage(submission.message, selectedProvider, selectedModel, submission.mode, {
        onToken: (token) => {
          fullText += token;
          updateMessage(assistantId, fullText);
        },
        onToolCall: (toolCall) => {
          addToolCall(assistantId, {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.input,
          });
          updateToolCall(assistantId, toolCall.id, { status: "running" });
        },
        onToolResult: (toolResult) => {
          updateToolCall(assistantId, toolResult.id, {
            ...classifyToolOutput(toolResult.output),
            result: toolResult.output,
          });
        },
        onInteraction: (_interactionId, questions) =>
          new Promise((resolve) => {
            setPendingQuestion({
              id: crypto.randomUUID(),
              toolCallId: "",
              messageId: assistantId,
              questions,
            });
            setQuestionResolver(resolve);
          }),
        onApproval: (approval) => {
          updateToolCall(assistantId, approval.toolCallId, { status: "waiting" });
          return requestApproval(approval);
        },
        onMutationResult: (result) => {
          setMutationResults((prev) => [{ ...result, id: result.transactionId }, ...prev]);
        },
        onFinish: () => {
          setPendingApproval(null);
          setStreaming(false);
        },
        onError: (error) => {
          console.error("[Home] Stream error:", error);
          setError(error.message);
          setStreaming(false);
        },
      });
    } catch (error) {
      console.error("[Home] Chat error:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      setError(errorMessage);
      setStreaming(false);
    }
  }, [input, isStreaming, activeChips, addMessage, updateMessage, addToolCall, updateToolCall, setStreaming, setError, selectedProvider, selectedModel, setPendingQuestion, setQuestionResolver, requestApproval]);

  const handleSuggestionClick = (suggestion: string) => {
    setInput(suggestion);
  };

  const handleChipClick = (chipId: ChipAction) => {
    // Toggle chip
    setActiveChips(prev =>
      prev.includes(chipId)
        ? prev.filter(c => c !== chipId)
        : [...prev, chipId]
    );

    // For "run-code" chip, pre-fill input template
    if (chipId === "run-code" && !activeChips.includes(chipId)) {
      setInput(prev => prev || "Run this code in Studio:\n```lua\n\n```");
    }
  };

  const handleStop = async () => {
    await cancelServerRun();
    if (pendingApproval) answerApproval("deny");
    if (pendingQuestion) answerQuestion([]);
    setPendingApproval(null);
    setPendingQuestion(null);
    setStreaming(false);
    setRunNotice("Run cancelled by user.");
  };

  // Show connection screen if not connected
  if (!isConnected) {
    return <ConnectionScreen status={studioStatus} />;
  }

  const composerActions = (
    <>
      <div className="flex items-center gap-1">
        <InstancePicker onSelect={(path) => setInput((prev) => prev + `@${path} `)} />
      </div>
      <div className="flex items-center gap-2">
        <ModelSelector disabled={!hasAnyServerProvider} serverProviders={serverProviders} />
        <button
          type="button"
          className={cn("stud-icon-btn", input.trim() && !isStreaming && hasConfiguredProvider && "is-primary")}
          onClick={isStreaming ? handleStop : handleSubmit}
          disabled={isStreaming ? false : !input.trim() || !hasConfiguredProvider}
          aria-label={isStreaming ? "Cancel run" : "Send message"}
        >
          {isStreaming ? <Square className="h-4 w-4 fill-current" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </>
  );
  const mutationOwner = (result: MutationResult) =>
    [...messages].reverse().find((message) =>
      message.toolCalls?.some((toolCall) => toolCall.name === result.toolName)
    )?.id;

  if (messages.length === 0) {
    return (
      <div className="stud-app-shell stud-workbench">
        <div className="stud-atmosphere" aria-hidden="true" />
        <StudAppHeader status={studioStatus} transport={studioTransport} trailing={<SettingsDialog />} />
        <main className="stud-app-main stud-welcome-layout">
          <div className="stud-welcome-card">
            <div className="stud-welcome-heading">
              <span className="stud-eyebrow">STUD FOR ROBLOX STUDIO</span>
              <h1 className="stud-display-title">Build an entire Roblox<br />game with agents</h1>
              <p className="stud-display-subtitle">
                Run scripting, worldbuilding, UI, DataStores, and live Studio ops.
              </p>
            </div>
            <div className="stud-agent-tasks" aria-hidden="true">
              <div className="stud-agent-task is-active"><span />Task running <strong>Generate world</strong></div>
              <div className="stud-agent-task"><span />Task Completed <strong>Write Luau scripts</strong></div>
              <div className="stud-agent-task"><span />Task Completed <strong>Place assets</strong></div>
            </div>
            <section className="stud-prompt-deck">
              <ContextChips
                onChipClick={handleChipClick}
                activeChips={activeChips}
                disabled={isStreaming || !hasConfiguredProvider}
              />
              <RunContextNotice active={activeChips} />
              <StudComposer
                value={input}
                onValueChange={setInput}
                onSubmit={handleSubmit}
                isLoading={isStreaming}
                disabled={!hasConfiguredProvider}
                placeholder={
                  hasConfiguredProvider
                      ? "Describe the world, mechanic, or script you want to build..."
                      : "Configure a server provider in .env to start..."
                }
              >
                {composerActions}
              </StudComposer>
            </section>
            <div className="stud-suggestions">
              {displayedSuggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="stud-suggestion-chip"
                  onClick={() => handleSuggestionClick(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            {!hasConfiguredProvider && (
              <RecoveryBanner error="No server AI provider credential configured." />
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="stud-app-shell stud-workbench">
      <div className="stud-atmosphere" aria-hidden="true" />
      <StudAppHeader
        status={studioStatus}
        transport={studioTransport}
        compact
        trailing={
          <>
            <ChatActions onClear={handleClearChat} disabled={messages.length === 0 || isStreaming} />
            <SettingsDialog />
          </>
        }
      />

      <main className="stud-chat-workspace">
        <aside className="stud-session-rail">
          <div className="stud-rail-status"><span /> LIVE WORLD</div>
          <h2>Scene<br />control</h2>
          <p className="stud-rail-copy">Your agent is attached to the open Roblox place.</p>
          <ConnectionBadges status={studioStatus} className="stud-rail-routes" />
          <div className="stud-rail-divider" />
          <p className="stud-rail-label">RUNNING MODEL</p>
          <p className="stud-rail-model">{selectedModel}</p>
          <p className="stud-rail-label">GUARDRAIL</p>
          <p className="stud-rail-copy">Writes and code execution stay behind approval.</p>
          <div className="stud-session-tasks" aria-label="Agent task status">
            <div className="stud-session-task is-active"><span />Running <strong>Read Studio state</strong></div>
            <div className="stud-session-task"><span />Waiting <strong>Human approvals</strong></div>
            <div className="stud-session-task"><span />Ready <strong>MCP + plugin tools</strong></div>
          </div>
          <div className="stud-rail-image" aria-hidden="true" />
        </aside>

        <div className="studio-window stud-chat-panel">
        <header className="stud-chat-header">
          <div className="stud-chat-title">
            <span className="stud-live-beacon" />
            <strong>STUD AGENT</strong>
            <small>live workspace</small>
          </div>
          <ConnectionBadges status={studioStatus} />
        </header>

      <ChatContainerRoot className="stud-transcript">
        <ChatContainerContent className="stud-chat-scroll space-y-2">
          {/* Empty state when no messages */}
          {messages.length === 0 && !isStreaming && (
            <EmptyState className="py-8" />
          )}

          {messages.map((message) => (
            <div
              key={message.id}
              className={cn("stud-message-block", message.role === "user" && "is-user")}
            >
              {message.role === "user" && message.contextChips && message.contextChips.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap justify-end">
                  {message.contextChips.map((chip) => (
                    <span key={chip} className="stud-suggestion-chip text-xs py-1">
                      {chip === "toolbox" && <><Box className="w-3 h-3 inline mr-1" /> Toolbox</>}
                      {chip === "docs" && <><FileText className="w-3 h-3 inline mr-1" /> Docs</>}
                      {chip === "run-code" && <><Play className="w-3 h-3 inline mr-1" /> Run Code</>}
                      {chip === "plan" && <><ListTodo className="w-3 h-3 inline mr-1" /> Plan</>}
                    </span>
                  ))}
                </div>
              )}

              <div className={cn("stud-message-row", message.role === "user" && "is-user")}>
                {message.role === "assistant" ? <BotAvatar /> : <UserAvatar />}
                <div className="flex-1 min-w-0">
                  <p className="stud-message-label">{message.role === "assistant" ? "STUD" : "YOU"}</p>
                  {message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="stud-tool-card">
                      <ToolCalls toolCalls={message.toolCalls} />
                      {mutationResults.filter((result) => mutationOwner(result) === message.id).slice(0, 5).map((result) => (
                        <MutationDiff
                          key={result.id}
                          toolName={result.toolName}
                          path={result.path}
                          before={result.before}
                          after={result.after}
                          transactionId={result.transactionId}
                          className="mt-2"
                        />
                      ))}
                    </div>
                  )}
                  {message.content ? (
                    <div
                      className={cn(
                        "stud-message-bubble",
                        message.role === "user" ? "is-user" : "is-assistant"
                      )}
                    >
                      <MessageContent markdown={message.role === "assistant"} className="prose prose-sm max-w-none">
                        {message.content}
                      </MessageContent>
                    </div>
                  ) : (
                    isStreaming &&
                    message.role === "assistant" &&
                    !message.toolCalls?.length && (
                      <div className="flex items-center gap-2 py-2">
                        <Loader variant="wave" size="sm" />
                        <span className="text-sm" style={{ color: "var(--stud-muted)" }}>
                          Thinking...
                        </span>
                      </div>
                    )
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Mutation diffs */}
          {mutationResults.some((result) => !mutationOwner(result)) && (
            <div className="space-y-1.5 px-1">
              {mutationResults.filter((result) => !mutationOwner(result)).slice(0, 5).map((r) => (
                <MutationDiff
                  key={r.id}
                  toolName={r.toolName}
                  path={r.path}
                  before={r.before}
                  after={r.after}
                  transactionId={r.transactionId}
                />
              ))}
            </div>
          )}

          {error && (
            <RecoveryBanner error={error} onDismiss={() => setError(null)} />
          )}
          {runNotice && (
            <RecoveryBanner error={runNotice} onDismiss={() => setRunNotice(null)} />
          )}

          {/* Pending question from AI */}
          {pendingQuestion && (
            <div className="stud-interaction-card">
              <QuestionPrompt
                questions={pendingQuestion.questions}
                onSubmit={answerQuestion}
                disabled={false}
              />
            </div>
          )}

          {pendingApproval && (
            <div className="stud-interaction-card">
              <ApprovalPrompt approval={pendingApproval} onDecision={answerApproval} />
            </div>
          )}

          {/* Streaming indicator */}
          {isStreaming && !pendingQuestion && !pendingApproval && (
            <div className="flex items-center gap-3 py-3 max-w-fit mx-auto">
              <Loader variant="wave" size="sm" />
              <span className="text-sm" style={{ color: "var(--stud-muted)" }}>
                AI is working...
              </span>
            </div>
          )}
        </ChatContainerContent>
        <ChatContainerFollow submissionCount={messages.filter((message) => message.role === "user").length} />
        <ScrollButton className="stud-scroll-button" aria-label="Jump to newest message" />
      </ChatContainerRoot>

      <div className="stud-chat-composer">
        <ContextChips onChipClick={handleChipClick} activeChips={activeChips} disabled={isStreaming} />
        <RunContextNotice active={activeChips} />
        <StudComposer
          value={input}
          onValueChange={setInput}
          onSubmit={handleSubmit}
          isLoading={isStreaming}
          disabled={!hasConfiguredProvider}
          placeholder={hasConfiguredProvider ? "Ask a follow-up..." : "Configure a server provider in .env to continue..."}
          className="mt-3"
        >
          {composerActions}
        </StudComposer>
      </div>
        </div>
      </main>

      <CommandPalette
        onCommand={(cmd, payload) => {
          if (cmd === "prompt" && typeof payload === "string") {
            setInput(payload);
          }
        }}
        onClearChat={handleClearChat}
      />
    </div>
  );
}

export default Home;
