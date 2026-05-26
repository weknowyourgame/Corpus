import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/icons/Icon";
import { ProviderIcon } from "@/components/icons/ProviderIcon";
import { Loader } from "@/components/ui/loader";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { useModelsStore } from "@/stores/models";
import type { ProviderType } from "@/lib/providers/types";
import { cn } from "@/lib/utils";
import { LogOut, Sparkles, Copy, Check, X, RefreshCw, Route } from "lucide-react";

function ApiKeyInput({
  provider,
  label,
  placeholder,
  helpUrl,
  onSaved,
}: {
  provider: "anthropic" | "openrouter";
  label: string;
  placeholder: string;
  helpUrl: string;
  onSaved?: () => void;
}) {
  const { apiKeys, setApiKey, hasApiKey } = useSettingsStore();
  const [showKey, setShowKey] = useState(false);
  const [value, setValue] = useState(apiKeys[provider] || "");
  const isConfigured = hasApiKey(provider);

  const handleSave = () => {
    setApiKey(provider, value.trim());
    onSaved?.();
  };

  const handleClear = () => {
    setValue("");
    setApiKey(provider, "");
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ProviderIcon id={provider === "anthropic" ? "anthropic" : "openrouter"} size="sm" />
          <label className="text-sm font-medium">{label}</label>
        </div>
        {isConfigured && (
          <span className="text-xs text-green-600 bg-green-50 px-2 py-0.5 rounded-full flex items-center gap-1">
            <Icon name="check" size="sm" />
            Configured
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Get a key from{" "}
        <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
          {provider === "anthropic" ? "console.anthropic.com" : "openrouter.ai/keys"}
        </a>
      </p>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={showKey ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={placeholder}
            className="pr-10 rounded-xl font-mono text-sm"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <Icon name={showKey ? "eye-off" : "eye"} size="sm" />
          </button>
        </div>
        {value.trim() !== (apiKeys[provider] || "") ? (
          <Button onClick={handleSave} size="sm" className="rounded-xl">
            Save
          </Button>
        ) : isConfigured ? (
          <Button onClick={handleClear} variant="outline" size="sm" className="rounded-xl text-destructive">
            Clear
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ChatGPTAuth() {
  const {
    isLoggingIn,
    loginError,
    loginUrl,
    startLogin,
    logout,
    cancelLogin,
    checkOAuthCallback,
    isOAuthAuthenticated,
  } = useAuthStore();
  const { codexModels, isLoading: isLoadingModels, refreshModels, lastFetched } = useModelsStore();
  const [copied, setCopied] = useState(false);
  const isAuthenticated = isOAuthAuthenticated();

  useEffect(() => {
    if (!isLoggingIn) return;
    const interval = setInterval(async () => {
      const completed = await checkOAuthCallback();
      if (completed) clearInterval(interval);
    }, 1000);
    const timeout = setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [isLoggingIn, checkOAuthCallback]);

  const handleCopyUrl = async () => {
    if (loginUrl) {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Sign in with ChatGPT Plus or Pro. Uses the Codex API — no separate API key.
      </p>
      {loginError && (
        <p className="text-xs text-red-600 bg-red-50 p-2 rounded-lg">{loginError}</p>
      )}
      {isAuthenticated ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between p-3 bg-green-50 rounded-xl">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500" />
              <span className="text-sm text-green-700">Connected to ChatGPT</span>
            </div>
            <Button variant="ghost" size="sm" onClick={logout} className="text-red-600 hover:bg-red-50">
              <LogOut className="w-4 h-4 mr-1" />
              Sign Out
            </Button>
          </div>
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-muted-foreground">
              {codexModels.length} models
              {lastFetched && ` · ${new Date(lastFetched).toLocaleTimeString()}`}
            </span>
            <Button variant="ghost" size="sm" onClick={refreshModels} disabled={isLoadingModels} className="h-6 px-2 text-xs">
              <RefreshCw className={cn("w-3 h-3 mr-1", isLoadingModels && "animate-spin")} />
              Refresh
            </Button>
          </div>
        </div>
      ) : isLoggingIn ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-primary/5 rounded-xl">
            <Loader variant="text-shimmer" text="Signing in" size="sm" />
            <Button variant="ghost" size="sm" onClick={cancelLogin}>
              <X className="w-4 h-4" />
            </Button>
          </div>
          {loginUrl && (
            <div className="flex gap-2">
              <Input value={loginUrl} readOnly className="text-xs font-mono h-9" />
              <Button variant="outline" size="sm" onClick={handleCopyUrl} className="h-9 w-9 p-0">
                {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </Button>
            </div>
          )}
        </div>
      ) : (
        <Button variant="dark" onClick={startLogin} className="w-full">
          <Sparkles className="w-4 h-4 mr-2" />
          Sign in with ChatGPT
        </Button>
      )}
    </div>
  );
}

function ProviderTabs({
  active,
  onChange,
}: {
  active: ProviderType;
  onChange: (p: ProviderType) => void;
}) {
  const { isOAuthAuthenticated } = useAuthStore();
  const { hasApiKey } = useSettingsStore();

  const tabs: { id: ProviderType; label: string; icon: React.ReactNode; ready: boolean }[] = [
    { id: "codex", label: "Codex", icon: <Sparkles className="w-3.5 h-3.5" />, ready: isOAuthAuthenticated() },
    { id: "anthropic", label: "Claude", icon: <ProviderIcon id="anthropic" size="xs" />, ready: hasApiKey("anthropic") },
    { id: "openrouter", label: "OpenRouter", icon: <Route className="w-3.5 h-3.5" />, ready: hasApiKey("openrouter") },
  ];

  return (
    <div className="segmented">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className={cn("flex-1 flex flex-col items-center gap-0.5 py-2 px-1 text-[11px] font-medium", active === tab.id && "active")}
        >
          <span className="flex items-center gap-1">
            {tab.icon}
            {tab.ready && <span className="w-1.5 h-1.5 rounded-full bg-green-500" />}
          </span>
          {tab.label}
        </button>
      ))}
    </div>
  );
}

interface SettingsDialogProps {
  children?: React.ReactNode;
}

export function SettingsDialog({ children }: SettingsDialogProps) {
  const { selectedProvider, setSelectedModel } = useSettingsStore();
  const [tab, setTab] = useState<ProviderType>(selectedProvider);
  const { fetchClaudeModels, fetchOpenRouterModels, openrouterModels, claudeModels, isLoadingOpenRouter, isLoadingClaude } =
    useModelsStore();

  useEffect(() => {
    setTab(selectedProvider);
  }, [selectedProvider]);

  return (
    <Dialog>
      <DialogTrigger asChild>
        {children || (
          <button type="button" className="stud-icon-btn nav-button" aria-label="Settings">
            <Icon name="settings-gear" size="md" />
          </button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>AI Providers</DialogTitle>
          <DialogDescription>
            Choose a model. Agent chat credentials are read by the bridge server, not this browser.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="stud-provider-help">
            <p>To enable server chat, set <code>OPENROUTER_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>, or <code>STUD_CODEX_ACCESS_TOKEN</code> in <code>.env</code>, then restart <code>npm run dev</code>.</p>
          </div>
          <ProviderTabs
            active={tab}
            onChange={(p) => {
              setTab(p);
              setSelectedModel(
                p === "codex" ? "gpt-4o" : p === "anthropic" ? "claude-sonnet-4-20250514" : "openai/gpt-4o",
                p
              );
            }}
          />

          {tab === "codex" && <ChatGPTAuth />}

          {tab === "anthropic" && (
            <ApiKeyInput
              provider="anthropic"
              label="Claude API Key"
              placeholder="sk-ant-..."
              helpUrl="https://console.anthropic.com/settings/keys"
              onSaved={() => {
                fetchClaudeModels();
                setSelectedModel("claude-sonnet-4-20250514", "anthropic");
              }}
            />
          )}

          {tab === "openrouter" && (
            <div className="space-y-3">
              <ApiKeyInput
                provider="openrouter"
                label="OpenRouter API Key"
                placeholder="sk-or-..."
                helpUrl="https://openrouter.ai/keys"
                onSaved={() => {
                  fetchOpenRouterModels();
                  setSelectedModel("openai/gpt-4o", "openrouter");
                }}
              />
              {useSettingsStore.getState().hasApiKey("openrouter") && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {isLoadingOpenRouter ? "Loading models…" : `${openrouterModels.length} models with tool support`}
                  </span>
                  <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => fetchOpenRouterModels()} disabled={isLoadingOpenRouter}>
                    <RefreshCw className={cn("w-3 h-3", isLoadingOpenRouter && "animate-spin")} />
                  </Button>
                </div>
              )}
            </div>
          )}

          {tab === "anthropic" && useSettingsStore.getState().hasApiKey("anthropic") && (
            <p className="text-xs text-muted-foreground">
              {isLoadingClaude ? "Loading Claude models…" : `${claudeModels.length} Claude models available`}
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default SettingsDialog;
