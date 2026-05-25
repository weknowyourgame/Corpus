import { useState, useCallback, useEffect, useRef } from "react";
import { PromptInputAction } from "@/components/ui/prompt-input";
import { Button } from "@/components/ui/button";
import {
  ChatContainerRoot,
  ChatContainerContent,
} from "@/components/ui/chat-container";
import { ScrollButton } from "@/components/ui/scroll-button";
import { MessageContent } from "@/components/ui/message";
import { ToolCalls } from "@/components/ui/tool-call";
import { Loader } from "@/components/ui/loader";
import { StudAppHeader } from "@/stud-ui";
import { StudComposer } from "@/stud-ui/StudComposer";
import { BotAvatar, UserAvatar } from "@/components/icons/Avatars";
import { Icon } from "@/components/icons/Icon";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { SettingsPanel } from "@/components/SettingsPanel";
import { ContextChips, ChipAction } from "@/components/chat/ContextChips";
import { QuestionPrompt } from "@/components/chat/QuestionPrompt";
import { ApprovalPrompt } from "@/components/chat/ApprovalPrompt";
import { InstancePicker } from "@/components/chat/InstancePicker";
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
} from "@/lib/ai/server-agent";
import { useAppShortcuts } from "@/hooks/useKeyboardShortcuts";
import { improvePrompt } from "@/lib/ai/prompt-improver";
import { cn } from "@/lib/utils";
import { SessionCode } from "@/components/SessionCode";
import { ArrowUp, Square, CheckCircle2, Download, FolderOpen, RefreshCw, Box, FileText, Globe, Play, ListTodo, Settings, Sparkles } from "lucide-react";

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
    <div className="stud-app-shell">
      <StudAppHeader trailing={<SettingsDialog />} />

      <main className="stud-connection-layout">
        <div className="stud-connection-stack">
          <div className="text-center">
            <Loader variant="wave" size="lg" />
            <h1 className="stud-display-title mt-6" style={{ fontSize: "2.25rem" }}>
              Connect Roblox Studio
            </h1>
            <div className="stud-display-subtitle">
              <Loader variant="terminal" text="Waiting for connection" size="sm" />
            </div>
          </div>

          <SessionCode />

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
  const [isImproving, setIsImproving] = useState(false);
  const [displayedSuggestions, setDisplayedSuggestions] = useState<string[]>([]);
  const [serverProviders, setServerProviders] = useState({ anthropic: false, openrouter: false, codex: false });
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
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
  const { status: studioStatus, startPolling } = useRobloxStore();
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
    clearMessages();
  }, [pendingApproval, pendingQuestion, answerApproval, answerQuestion, setPendingQuestion, clearMessages]);

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
    if (serverProviders[selectedProvider]) return;
    if (serverProviders.anthropic) {
      setSelectedModel("claude-sonnet-4-20250514", "anthropic");
    } else if (serverProviders.openrouter) {
      setSelectedModel("anthropic/claude-sonnet-4", "openrouter");
    } else if (serverProviders.codex) {
      setSelectedModel("gpt-4o", "codex");
    }
  }, [serverProviders, selectedProvider, setSelectedModel]);

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
        onToolResult: (result) => updateToolCall(target(), result.id, { status: "complete", result: result.output }),
        onInteraction: (_id, questions) => new Promise((resolve) => {
          setPendingQuestion({ id: crypto.randomUUID(), toolCallId: "", messageId: target(), questions });
          setQuestionResolver(resolve);
        }),
        onApproval: requestApproval,
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

  // Improve prompt handler
  const handleImprovePrompt = useCallback(async () => {
    if (!input.trim() || isImproving || isStreaming) return;

    setIsImproving(true);
    try {
      const result = await improvePrompt(input);
      if (result.improved && result.improved !== input) {
        setInput(result.improved);
      }
      if (result.error) {
        console.warn("[Home] Prompt improvement error:", result.error);
      }
    } catch (err) {
      console.error("[Home] Failed to improve prompt:", err);
    } finally {
      setIsImproving(false);
    }
  }, [input, isImproving, isStreaming]);

  const handleSubmit = useCallback(async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();

    // Build context prefix based on active chips
    const prefixes: string[] = [];
    if (activeChips.includes("docs")) {
      prefixes.push("[Search Roblox documentation first]");
    }
    if (activeChips.includes("web")) {
      prefixes.push("[Search the web for information]");
    }
    if (activeChips.includes("search-models")) {
      prefixes.push("[Search the Creator Store for free models if needed]");
    }
    if (activeChips.includes("plan")) {
      prefixes.push("[Create a detailed plan before making changes]");
    }
    const chipContext = prefixes.join(" ");
    const fullMessage = chipContext ? `${chipContext}\n\n${userMessage}` : userMessage;
    const mode = activeChips.includes("plan") ? "plan" : "execute";

    setInput("");
    setActiveChips([]); // Clear chips after submit

    console.log("[Home] Submitting message:", userMessage, "with context:", chipContext);

    // Add user message (show without context prefix for cleaner UI, but store chips)
    addMessage({ role: "user", content: userMessage, contextChips: activeChips.length > 0 ? [...activeChips] : undefined });

    // Add placeholder for assistant
    const assistantId = addMessage({ role: "assistant", content: "" });

    setStreaming(true);
    setError(null);

    try {
      let fullText = "";

      await sendServerMessage(fullMessage, selectedProvider, selectedModel, mode, {
        onToken: (token) => {
          fullText += token;
          updateMessage(assistantId, fullText);
        },
        onToolCall: (toolCall) => {
          console.log("[Home] Tool call received:", toolCall.name);
          // Add tool call to the assistant message
          addToolCall(assistantId, {
            id: toolCall.id,
            name: toolCall.name,
            args: toolCall.input,
          });
          // Mark it as running
          updateToolCall(assistantId, toolCall.id, { status: "running" });
        },
        onToolResult: (toolResult) => {
          console.log("[Home] Tool result received:", toolResult.id);
          // Update the tool call with the result
          updateToolCall(assistantId, toolResult.id, {
            status: "complete",
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
        onApproval: requestApproval,
        onFinish: () => {
          console.log("[Home] Stream finished, total length:", fullText.length);
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
  };

  // Show connection screen if not connected
  if (!isConnected) {
    return <ConnectionScreen status={studioStatus} />;
  }

  const composerActions = (
    <>
      <div className="flex items-center gap-1">
        <PromptInputAction tooltip="Attach file">
          <button type="button" className="stud-icon-btn" disabled>
            <Icon name="link" size="sm" />
          </button>
        </PromptInputAction>
        <InstancePicker onSelect={(path) => setInput((prev) => prev + `@${path} `)} />
      </div>
      <div className="flex items-center gap-2">
        <ModelSelector disabled={!hasAnyServerProvider} serverProviders={serverProviders} />
        <PromptInputAction tooltip="Improve prompt for Stud">
          <button
            type="button"
            className="stud-icon-btn"
            onClick={handleImprovePrompt}
            disabled={!input.trim() || isImproving || isStreaming || !hasConfiguredProvider}
          >
            {isImproving ? <Loader variant="circular" size="sm" /> : <Sparkles className="h-4 w-4" />}
          </button>
        </PromptInputAction>
        <button
          type="button"
          className={cn("stud-icon-btn", input.trim() && !isStreaming && hasConfiguredProvider && "is-primary")}
          onClick={isStreaming ? handleStop : handleSubmit}
          disabled={!input.trim() || !hasConfiguredProvider}
        >
          {isStreaming ? <Square className="h-4 w-4 fill-current" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </>
  );

  if (messages.length === 0) {
    return (
      <div className="stud-app-shell">
        <StudAppHeader status={studioStatus} trailing={<SettingsDialog />} />
        <main className="stud-app-main stud-connection-layout">
          <div className="w-full max-w-2xl space-y-8">
            <div className="text-center">
              <h1 className="stud-display-title">What would you like to build?</h1>
              <p className="stud-display-subtitle">
                Create scripts, design systems, and build games in Roblox Studio.
              </p>
            </div>
            <ContextChips
              onChipClick={handleChipClick}
              activeChips={activeChips}
              disabled={isStreaming || !hasConfiguredProvider}
            />
            <StudComposer
              value={input}
              onValueChange={setInput}
              onSubmit={handleSubmit}
              isLoading={isStreaming}
              isImproving={isImproving}
              disabled={!hasConfiguredProvider}
              placeholder={
                isImproving
                  ? "Improving your prompt..."
                  : hasConfiguredProvider
                    ? "Ask me anything about Roblox development..."
                    : "Configure an API key in settings to start..."
              }
            >
              {composerActions}
            </StudComposer>
            <div className="flex flex-wrap justify-center gap-2">
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
              <p className="text-center text-sm" style={{ color: "var(--stud-muted)" }}>
                <Icon name="key" size="sm" className="inline mr-1" />
                No AI provider configured.{" "}
                <SettingsDialog>
                  <button type="button" className="underline">
                    Open settings
                  </button>
                </SettingsDialog>
              </p>
            )}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="stud-app-shell">
      <StudAppHeader
        status={studioStatus}
        compact
        trailing={
          <>
            <ChatActions onClear={handleClearChat} disabled={messages.length === 0 || isStreaming} />
            <SettingsPanel
              trigger={
                <button type="button" className="stud-icon-btn" aria-label="Settings">
                  <Settings className="w-4 h-4" />
                </button>
              }
            />
            <SettingsDialog />
          </>
        }
      />

      <div className="studio-window stud-app-main mx-auto w-[min(100%-40px,920px)] my-4 flex flex-col min-h-0 flex-1">
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[var(--stud-border)]">
          <strong style={{ fontFamily: "var(--stud-tech)", fontSize: 13, letterSpacing: "0.12em" }}>
            STUDIO CHAT
          </strong>
        </header>

      <ChatContainerRoot className="flex-1 relative min-h-0">
        <ChatContainerContent className="stud-chat-scroll space-y-2">
          {error && (
            <div className="stud-alert-error flex items-start gap-3">
              <div className="flex-shrink-0 w-5 h-5 mt-0.5">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="font-medium">Error</p>
                <p className="text-sm mt-1">{error}</p>
              </div>
              <button
                onClick={() => setError(null)}
                className="flex-shrink-0 text-red-500 hover:text-red-700"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

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
                      {chip === "search-models" && <><Box className="w-3 h-3 inline mr-1" /> Models</>}
                      {chip === "docs" && <><FileText className="w-3 h-3 inline mr-1" /> Docs</>}
                      {chip === "web" && <><Globe className="w-3 h-3 inline mr-1" /> Web</>}
                      {chip === "run-code" && <><Play className="w-3 h-3 inline mr-1" /> Run</>}
                      {chip === "plan" && <><ListTodo className="w-3 h-3 inline mr-1" /> Plan</>}
                    </span>
                  ))}
                </div>
              )}

              <div className="flex gap-3 items-start">
                {message.role === "assistant" ? <BotAvatar /> : <UserAvatar />}
                <div className="flex-1 min-w-0">
                  {message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="stud-tool-card">
                      <ToolCalls toolCalls={message.toolCalls} />
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

          {/* Pending question from AI */}
          {pendingQuestion && (
            <div className="max-w-2xl mx-auto">
              <QuestionPrompt
                questions={pendingQuestion.questions}
                onSubmit={answerQuestion}
                disabled={false}
              />
            </div>
          )}

          {pendingApproval && (
            <div className="max-w-2xl mx-auto">
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
        <div className="absolute bottom-28 left-1/2 -translate-x-1/2">
          <ScrollButton />
        </div>
      </ChatContainerRoot>

      <div className="stud-chat-composer px-4 pb-4">
        <ContextChips onChipClick={handleChipClick} activeChips={activeChips} disabled={isStreaming} />
        <StudComposer
          value={input}
          onValueChange={setInput}
          onSubmit={handleSubmit}
          isLoading={isStreaming}
          isImproving={isImproving}
          placeholder={isImproving ? "Improving your prompt..." : "Ask a follow-up..."}
          className="mt-3"
        >
          {composerActions}
        </StudComposer>
      </div>
      </div>

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
