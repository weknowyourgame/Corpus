import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Loader } from "@/components/ui/loader";
import { bridgeUrl } from "@/lib/bridge/config";
import { cn } from "@/lib/utils";
import { Check, RotateCcw, Save, Search, SlidersHorizontal, Terminal } from "lucide-react";

type ModelProfile = {
  profileId: string;
  defaultModel: string;
  fallbackModels: string[];
  overrideModel: string | null;
  activeModel: string;
};

type OpenRouterModel = {
  id: string;
  name: string;
  description?: string;
};

type ConfigResponse = {
  profiles: ModelProfile[];
  overrides: Record<string, string>;
};

const profileLabels: Record<string, string> = {
  "planner-free": "Free planner",
  "planner-pro": "Pro planner",
  "planner-hyper": "Hyper planner",
  "planner-super": "Super planner",
  "coder-free": "Free coder",
  "coder-pro": "Pro coder",
  "coder-hyper": "Hyper coder",
  "coder-super": "Super coder",
  classifier: "Classifier",
  summarizer: "Memory / summary / suggestions",
  "title-generator": "Title generator",
  embeddings: "Embeddings label",
};

const groupFor = (profileId: string) => {
  if (profileId.startsWith("planner-")) return "Planner";
  if (profileId.startsWith("coder-")) return "Coder";
  if (profileId === "embeddings") return "Corpus";
  return "Utility";
};

const devHeaders = () => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = localStorage.getItem("stud_dev_mode_token") || "";
  if (token) headers.set("X-Stud-Dev-Token", token);
  return headers;
};

async function fetchConfig(): Promise<ConfigResponse> {
  const res = await fetch(bridgeUrl("/agent/dev/model-config"), {
    credentials: "include",
    headers: devHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res) || "Dev model config is locked");
  return res.json() as Promise<ConfigResponse>;
}

async function saveConfig(overrides: Record<string, string>): Promise<ConfigResponse> {
  const res = await fetch(bridgeUrl("/agent/dev/model-config"), {
    method: "PATCH",
    credentials: "include",
    headers: devHeaders(),
    body: JSON.stringify({ overrides }),
  });
  if (!res.ok) throw new Error(await readError(res) || "Could not save dev model config");
  return res.json() as Promise<ConfigResponse>;
}

async function readError(res: Response) {
  try {
    const data = await res.json() as { error?: string };
    if (data.error) return `${data.error} (${res.status})`;
  } catch {
    // Fall through to status text.
  }
  return `${res.statusText || "Request failed"} (${res.status})`;
}

async function fetchModels(): Promise<OpenRouterModel[]> {
  const res = await fetch(bridgeUrl("/agent/models"), {
    credentials: "include",
    headers: devHeaders(),
  });
  if (!res.ok) return [];
  const data = await res.json() as { models?: OpenRouterModel[] };
  return data.models ?? [];
}

export function DevModelConfigDialog({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [query, setQuery] = useState("");
  const [selectedProfile, setSelectedProfile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockToken, setUnlockToken] = useState("");
  const [saved, setSaved] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([fetchConfig(), models.length ? Promise.resolve(models) : fetchModels()])
      .then(([config, modelList]) => {
        setProfiles(config.profiles);
        setOverrides(config.overrides ?? {});
        setModels(modelList);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  const unlock = () => {
    localStorage.setItem("stud_dev_mode_token", unlockToken.trim());
    load();
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models.slice(0, 80);
    return models
      .filter((model) => model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q))
      .slice(0, 80);
  }, [models, query]);

  const groupedProfiles = useMemo(() => {
    const groups = new Map<string, ModelProfile[]>();
    for (const profile of profiles) {
      const group = groupFor(profile.profileId);
      groups.set(group, [...(groups.get(group) ?? []), profile]);
    }
    return [...groups.entries()];
  }, [profiles]);

  const setOverride = (profileId: string, model: string) => {
    setOverrides((current) => ({ ...current, [profileId]: model }));
    setSaved(false);
  };

  const clearOverride = (profileId: string) => {
    setOverrides((current) => {
      const next = { ...current };
      delete next[profileId];
      return next;
    });
    setSaved(false);
  };

  const save = () => {
    setSaving(true);
    setError(null);
    saveConfig(overrides)
      .then((config) => {
        setProfiles(config.profiles);
        setOverrides(config.overrides ?? {});
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  const activeProfile = selectedProfile ?? profiles[0]?.profileId ?? null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn("stud-icon-btn nav-button", className)}
          aria-label="Dev model config"
          title="Dev model config"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-amber-500" />
            Dev Model Config
          </DialogTitle>
          <DialogDescription>
            Override the running bridge's internal model profiles. Restarting the bridge resets these overrides.
          </DialogDescription>
        </DialogHeader>

        {(error === "Dev model config is locked" || error?.startsWith("Dev mode is not unlocked")) && (
          <div className="rounded-lg border border-amber-300/70 bg-amber-500/5 p-3">
            <p className="text-sm font-medium">Dev config is locked</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Enter the server's STUD_DEV_MODE_TOKEN to unlock internal model controls in this browser.
            </p>
            <div className="mt-3 flex gap-2">
              <Input
                value={unlockToken}
                onChange={(event) => setUnlockToken(event.target.value)}
                placeholder="STUD_DEV_MODE_TOKEN"
                className="h-9 font-mono text-sm"
              />
              <Button type="button" onClick={unlock} disabled={!unlockToken.trim()}>
                Unlock
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="min-h-[420px] rounded-lg border">
            <div className="flex items-center justify-between border-b px-3 py-2">
              <div className="text-xs font-medium text-muted-foreground">Profiles</div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOverrides({})}>
                <RotateCcw className="h-3.5 w-3.5" />
                Reset all
              </Button>
            </div>
            <div className="max-h-[520px] overflow-y-auto p-3">
              {loading && (
                <div className="flex justify-center py-8">
                  <Loader variant="circular" size="sm" />
                </div>
              )}
              {!loading && groupedProfiles.map(([group, items]) => (
                <section key={group} className="mb-5 last:mb-0">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group}</h3>
                  <div className="space-y-2">
                    {items.map((profile) => {
                      const value = overrides[profile.profileId] ?? "";
                      const active = value || profile.defaultModel;
                      return (
                        <div
                          key={profile.profileId}
                          className={cn(
                            "rounded-lg border p-3",
                            activeProfile === profile.profileId && "border-amber-400/70 bg-amber-500/5"
                          )}
                        >
                          <button
                            type="button"
                            className="mb-2 flex w-full items-center justify-between gap-3 text-left"
                            onClick={() => setSelectedProfile(profile.profileId)}
                          >
                            <div className="min-w-0">
                              <div className="text-sm font-medium">{profileLabels[profile.profileId] ?? profile.profileId}</div>
                              <div className="truncate font-mono text-[11px] text-muted-foreground">{profile.profileId}</div>
                            </div>
                            {value && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-600">override</span>}
                          </button>
                          <div className="flex gap-2">
                            <Input
                              value={active}
                              onFocus={() => setSelectedProfile(profile.profileId)}
                              onChange={(event) => setOverride(profile.profileId, event.target.value)}
                              className="h-8 font-mono text-xs"
                            />
                            <Button type="button" variant="outline" size="sm" onClick={() => clearOverride(profile.profileId)}>
                              Default
                            </Button>
                          </div>
                          {profile.fallbackModels.length > 0 && !value && (
                            <p className="mt-1 text-[11px] text-muted-foreground">
                              Fallbacks: {profile.fallbackModels.join(", ")}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          </div>

          <div className="rounded-lg border">
            <div className="border-b p-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search OpenRouter models"
                  className="h-9 pl-8 text-sm"
                />
              </div>
            </div>
            <div className="max-h-[520px] overflow-y-auto p-2">
              {filteredModels.map((model) => (
                <button
                  key={model.id}
                  type="button"
                  className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left hover:bg-muted"
                  onClick={() => activeProfile && setOverride(activeProfile, model.id)}
                  disabled={!activeProfile}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">{model.name}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{model.id}</div>
                  </div>
                  {activeProfile && overrides[activeProfile] === model.id && <Check className="mt-0.5 h-3.5 w-3.5 text-primary" />}
                </button>
              ))}
              {!loading && filteredModels.length === 0 && (
                <p className="py-8 text-center text-xs text-muted-foreground">No models loaded</p>
              )}
            </div>
          </div>
        </div>

        {error && error !== "Dev model config is locked" && !error.startsWith("Dev mode is not unlocked") && (
          <p className="text-sm text-destructive">{error}</p>
        )}

        <div className="flex items-center justify-between border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Choose a profile on the left, then click a model or paste any OpenRouter model ID.
          </p>
          <Button type="button" onClick={save} disabled={saving || loading}>
            {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving..." : saved ? "Saved" : "Save overrides"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
