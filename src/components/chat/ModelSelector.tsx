import { useState, useEffect, useMemo } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader } from "@/components/ui/loader";
import { Switch } from "@/components/ui/switch";
import { useSettingsStore } from "@/stores/settings";
import { ALL_TIERS, TIER_LABELS, TIER_DESCRIPTIONS } from "@/lib/ai/profiles";
import type { Tier } from "@/lib/ai/profiles";
import { bridgeUrl } from "@/lib/bridge/config";
import { cn } from "@/lib/utils";
import { Check, ChevronDown, Search, Terminal } from "lucide-react";

interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
}

async function fetchModels(): Promise<OpenRouterModel[]> {
  const headers = new Headers();
  const devToken = localStorage.getItem("stud_dev_mode_token") || "";
  if (devToken) headers.set("X-Stud-Dev-Token", devToken);
  const res = await fetch(bridgeUrl("/agent/models"), { headers, credentials: "include" });
  if (!res.ok) return [];
  const data = await res.json() as { models: OpenRouterModel[] };
  return data.models ?? [];
}

interface ModelSelectorProps {
  className?: string;
  disabled?: boolean;
  allowDevMode?: boolean;
}

export function ModelSelector({ className, disabled, allowDevMode = false }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);

  const { selectedTier, setTier, devMode, setDevMode, devModel, setDevModel } = useSettingsStore();

  // Fetch models when dev mode is on and popover opens
  useEffect(() => {
    if (!allowDevMode || !devMode || !open || models.length > 0) return;
    setLoading(true);
    fetchModels().then((m) => { setModels(m); setLoading(false); });
  }, [allowDevMode, devMode, open, models.length]);

  useEffect(() => {
    if (allowDevMode || !devMode) return;
    setDevMode(false);
    setDevModel("");
  }, [allowDevMode, devMode, setDevMode, setDevModel]);

  const filtered = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  }, [models, search]);

  const currentLabel = devMode
    ? devModel ? (models.find((m) => m.id === devModel)?.name ?? devModel.split("/")[1] ?? devModel) : "Pick model…"
    : TIER_LABELS[selectedTier];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <Button
          variant="outline"
          size="sm"
          className={cn("stud-model-trigger gap-1.5 px-2.5 h-9 text-xs", devMode && "border-amber-400/60 text-amber-600", className)}
          aria-label={`Choose ${devMode ? "model" : "tier"}. Current: ${currentLabel}`}
        >
          {devMode && <Terminal className="w-3 h-3 opacity-70" />}
          <span className="font-medium max-w-[140px] truncate">{currentLabel}</span>
          <ChevronDown className="w-3 h-3 opacity-50" />
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="stud-popover w-72 p-0"
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        {allowDevMode && (
          <div className="flex items-center justify-between px-3 py-2.5 border-b">
            <div className="flex items-center gap-2">
              <Terminal className="w-3.5 h-3.5 text-amber-500" />
              <span className="text-xs font-medium">Dev mode</span>
            </div>
            <Switch
              checked={devMode}
              onCheckedChange={(on) => {
                setDevMode(on);
                if (!on) {
                  setSearch("");
                  setDevModel("");
                }
              }}
            />
          </div>
        )}

        {devMode ? (
          <>
            {/* Search */}
            <div className="p-2 border-b">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search all OpenRouter models…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-8 pl-8 text-xs"
                  autoFocus
                />
              </div>
            </div>

            {/* Model list */}
            <div className="max-h-72 overflow-y-auto p-1">
              {loading && (
                <div className="flex justify-center py-6">
                  <Loader variant="circular" size="sm" />
                </div>
              )}
              {!loading && filtered.length === 0 && (
                <p className="text-center text-xs text-muted-foreground py-6">
                  {models.length === 0 ? "No models loaded from the server" : "No results"}
                </p>
              )}
              {!loading && filtered.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { setDevModel(m.id); setOpen(false); setSearch(""); }}
                  data-selected={devModel === m.id}
                  className={cn(
                    "stud-model-row w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-colors",
                    devModel === m.id && "is-selected"
                  )}
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{m.name}</div>
                    <div className="text-[10px] text-muted-foreground font-mono truncate">{m.id}</div>
                  </div>
                  {devModel === m.id && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
                </button>
              ))}
            </div>

            <div className="px-3 py-2 border-t">
              <p className="text-[10px] text-amber-600">Dev mode: bypasses tier routing, uses this model for everything.</p>
            </div>
          </>
        ) : (
          /* Tier selector */
          <div className="p-1">
            {ALL_TIERS.map((tier: Tier) => (
              <button
                key={tier}
                type="button"
                onClick={() => { setTier(tier); setOpen(false); }}
                data-selected={selectedTier === tier}
                className={cn(
                  "stud-model-row w-full flex items-center gap-2 px-2.5 py-2.5 rounded-lg text-left transition-colors",
                  selectedTier === tier && "is-selected"
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{TIER_LABELS[tier]}</div>
                  <div className="text-[11px] text-muted-foreground">{TIER_DESCRIPTIONS[tier]}</div>
                </div>
                {selectedTier === tier && <Check className="w-3.5 h-3.5 text-primary flex-shrink-0" />}
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

export default ModelSelector;
