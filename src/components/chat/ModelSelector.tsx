import { useState, useEffect, useMemo } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader } from "@/components/ui/loader";
import { ProviderIcon } from "@/components/icons/ProviderIcon";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { useModelsStore } from "@/stores/models";
import type { ProviderType } from "@/lib/providers/types";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Search, Brain, Sparkles, Route } from "lucide-react";

interface ModelSelectorProps {
  className?: string;
  disabled?: boolean;
  serverProviders?: Record<ProviderType, boolean>;
}

export function ModelSelector({ className, disabled, serverProviders }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { selectedModel, selectedProvider, setSelectedModel, hasApiKey, apiKeys } = useSettingsStore();
  const { isOAuthAuthenticated } = useAuthStore();
  const {
    codexModels,
    claudeModels,
    openrouterModels,
    isLoading,
    isLoadingClaude,
    isLoadingOpenRouter,
    fetchModels,
    fetchClaudeModels,
    fetchOpenRouterModels,
  } = useModelsStore();

  const isCodexAuth = isOAuthAuthenticated();
  const isConfigured = (provider: ProviderType) => serverProviders?.[provider] || (
    provider === "codex" ? isCodexAuth : hasApiKey(provider)
  );

  useEffect(() => {
    if (isCodexAuth) fetchModels();
  }, [isCodexAuth, fetchModels]);

  useEffect(() => {
    if (apiKeys.anthropic) fetchClaudeModels();
  }, [apiKeys.anthropic, fetchClaudeModels]);

  useEffect(() => {
    if (apiKeys.openrouter) fetchOpenRouterModels();
  }, [apiKeys.openrouter, fetchOpenRouterModels]);

  useEffect(() => {
    if (open && apiKeys.openrouter && openrouterModels.length === 0) {
      fetchOpenRouterModels();
    }
  }, [open, apiKeys.openrouter, openrouterModels.length, fetchOpenRouterModels]);

  const getShortName = () => {
    const all = [...codexModels, ...claudeModels, ...openrouterModels];
    const found = all.find((m) => m.id === selectedModel);
    if (found) return found.name;
    if (selectedProvider === "openrouter" && selectedModel === "anthropic/claude-sonnet-4") return "Claude Sonnet 4";
    return selectedModel;
  };

  const allModels = useMemo(() => {
    const models: Array<{
      id: string;
      name: string;
      provider: ProviderType;
      description?: string;
      isNew?: boolean;
      reasoning?: boolean;
      disabled?: boolean;
    }> = [];

    if (isConfigured("codex")) {
      codexModels.forEach((m) => {
        models.push({
          id: m.id,
          name: m.name,
          provider: "codex",
          description: m.description,
          isNew: m.isNew,
          reasoning: m.reasoning,
        });
      });
    }

    if (isConfigured("anthropic")) {
      claudeModels.forEach((m) => {
        models.push({
          id: m.id,
          name: m.name,
          provider: "anthropic",
          description: m.description,
        });
      });
    } else {
      claudeModels.slice(0, 2).forEach((m) => {
        models.push({
          id: m.id,
          name: m.name,
          provider: "anthropic",
          description: "Add API key in Settings",
          disabled: true,
        });
      });
    }

    if (isConfigured("openrouter")) {
      openrouterModels.forEach((m) => {
        models.push({
          id: m.id,
          name: m.name,
          provider: "openrouter",
          description: m.description,
        });
      });
      if (!openrouterModels.length) {
        models.push({
          id: "anthropic/claude-sonnet-4",
          name: "Claude Sonnet 4",
          provider: "openrouter",
          description: "Server-configured OpenRouter",
        });
      }
    }

    return models;
  }, [codexModels, claudeModels, openrouterModels, isCodexAuth, hasApiKey, serverProviders]);

  const filteredModels = useMemo(() => {
    if (!search.trim()) return allModels;
    const q = search.toLowerCase();
    return allModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        m.description?.toLowerCase().includes(q)
    );
  }, [allModels, search]);

  const groupedModels = useMemo(
    () => ({
      codex: filteredModels.filter((m) => m.provider === "codex" && !m.reasoning),
      reasoning: filteredModels.filter((m) => m.provider === "codex" && m.reasoning),
      claude: filteredModels.filter((m) => m.provider === "anthropic"),
      openrouter: filteredModels.filter((m) => m.provider === "openrouter"),
    }),
    [filteredModels]
  );

  const handleSelect = (modelId: string, provider: ProviderType) => {
    setSelectedModel(modelId, provider);
    setOpen(false);
    setSearch("");
  };

  const providerIconId = () => {
    if (selectedProvider === "anthropic") return "anthropic";
    if (selectedProvider === "openrouter") return "openrouter";
    return "openai";
  };

  const loading = isLoading || isLoadingClaude || isLoadingOpenRouter;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          size="sm"
          className={cn("stud-model-trigger gap-1.5 px-2.5 h-9 text-xs", className)}
          aria-label={`Choose model. Current model: ${getShortName()}`}
        >
          <ProviderIcon id={providerIconId()} size="xs" />
          <span className="font-medium max-w-[148px] truncate">{getShortName()}</span>
          <ChevronDown className="w-3 h-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="stud-popover stud-model-popover w-80 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="stud-model-search p-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <Input
              placeholder="Search models..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="stud-model-input h-9 pl-8 text-sm rounded-lg"
              autoFocus
            />
          </div>
        </div>

        <div className="stud-model-list max-h-[340px] overflow-y-auto p-1.5">
          {loading && (
            <div className="flex items-center justify-center py-4">
              <Loader variant="circular" size="sm" />
            </div>
          )}

          {!loading && filteredModels.length === 0 && (
            <div className="text-center py-6 text-sm text-muted-foreground px-2">
              {isConfigured("openrouter") || isConfigured("codex") || isConfigured("anthropic")
                ? "No models match your search"
                : "Add a provider in Settings"}
            </div>
          )}

          {groupedModels.codex.length > 0 && (
            <ModelGroup label="Codex (ChatGPT)" icon={<Sparkles className="w-3 h-3" />}>
              {groupedModels.codex.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  isSelected={selectedModel === model.id && selectedProvider === "codex"}
                  onClick={() => handleSelect(model.id, "codex")}
                  disabled={model.disabled}
                />
              ))}
            </ModelGroup>
          )}

          {groupedModels.reasoning.length > 0 && (
            <ModelGroup label="Codex Reasoning" icon={<Brain className="w-3 h-3" />}>
              {groupedModels.reasoning.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  isSelected={selectedModel === model.id && selectedProvider === "codex"}
                  onClick={() => handleSelect(model.id, "codex")}
                  disabled={model.disabled}
                />
              ))}
            </ModelGroup>
          )}

          {groupedModels.claude.length > 0 && (
            <ModelGroup label="Claude" icon={<ProviderIcon id="anthropic" size="xs" />}>
              {groupedModels.claude.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  isSelected={selectedModel === model.id && selectedProvider === "anthropic"}
                  onClick={() => handleSelect(model.id, "anthropic")}
                  disabled={model.disabled}
                />
              ))}
            </ModelGroup>
          )}

          {groupedModels.openrouter.length > 0 && (
            <ModelGroup label="OpenRouter" icon={<Route className="w-3 h-3" />}>
              {groupedModels.openrouter.map((model) => (
                <ModelRow
                  key={model.id}
                  model={model}
                  isSelected={selectedModel === model.id && selectedProvider === "openrouter"}
                  onClick={() => handleSelect(model.id, "openrouter")}
                  disabled={model.disabled}
                />
              ))}
            </ModelGroup>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ModelGroup({
  label,
  icon,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-1">
      <div className="stud-model-group flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}

function ModelRow({
  model,
  isSelected,
  onClick,
  disabled,
}: {
  model: { id: string; name: string; description?: string; isNew?: boolean };
  isSelected: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-selected={isSelected}
      className={cn(
        "stud-model-row w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors",
        isSelected && "is-selected",
        disabled && "is-disabled"
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn("text-sm font-medium truncate", disabled && "text-muted-foreground")}>
            {model.name}
          </span>
          {model.isNew && (
            <span className="flex-shrink-0 text-[9px] text-amber-600 bg-amber-50 px-1 rounded">New</span>
          )}
        </div>
        {model.description && (
          <span className="text-[11px] text-muted-foreground truncate block">{model.description}</span>
        )}
        <span className="text-[10px] text-muted-foreground/70 font-mono truncate block">{model.id}</span>
      </div>
      {isSelected && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
    </button>
  );
}

export default ModelSelector;
