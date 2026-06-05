import { useEffect, useState } from "react";
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
import { bridgeUrl } from "@/lib/bridge/config";
import { cn } from "@/lib/utils";
import { Check, Gauge, RotateCcw, Save } from "lucide-react";

type Tier = "free" | "pro" | "hyper" | "super";

type RateLimitConfig = {
  maxConcurrentRuns: number;
  rpm: Record<Tier, number>;
};

const defaultConfig: RateLimitConfig = {
  maxConcurrentRuns: 2,
  rpm: { free: 5, pro: 20, hyper: 10, super: 10 },
};

const devHeaders = () => {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = localStorage.getItem("corpus_dev_mode_token") || "";
  if (token) headers.set("X-Corpus-Dev-Token", token);
  return headers;
};

async function fetchRateLimits(): Promise<RateLimitConfig> {
  const res = await fetch(bridgeUrl("/agent/dev/rate-limits"), {
    credentials: "include",
    headers: devHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res) || "Rate limit config is locked");
  const data = await res.json() as { config: RateLimitConfig };
  return data.config;
}

async function saveRateLimits(config: RateLimitConfig): Promise<RateLimitConfig> {
  const res = await fetch(bridgeUrl("/agent/dev/rate-limits"), {
    method: "PATCH",
    credentials: "include",
    headers: devHeaders(),
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(await readError(res) || "Could not save rate limits");
  const data = await res.json() as { config: RateLimitConfig };
  return data.config;
}

async function resetRateLimits(): Promise<RateLimitConfig> {
  const res = await fetch(bridgeUrl("/agent/dev/rate-limits/reset"), {
    method: "POST",
    credentials: "include",
    headers: devHeaders(),
    body: "{}",
  });
  if (!res.ok) throw new Error(await readError(res) || "Could not reset rate limits");
  const data = await res.json() as { config: RateLimitConfig };
  return data.config;
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

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        type="number"
        min={1}
        value={value}
        onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))}
        className="h-9"
      />
    </label>
  );
}

export function DevRateLimitsDialog({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<RateLimitConfig>(defaultConfig);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlockToken, setUnlockToken] = useState("");

  const load = () => {
    setLoading(true);
    setError(null);
    fetchRateLimits()
      .then(setConfig)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open) load();
  }, [open]);

  const unlock = () => {
    localStorage.setItem("corpus_dev_mode_token", unlockToken.trim());
    load();
  };

  const patchRpm = (tier: Tier, value: number) => {
    setConfig((current) => ({ ...current, rpm: { ...current.rpm, [tier]: value } }));
    setSaved(false);
  };

  const save = () => {
    setSaving(true);
    setError(null);
    saveRateLimits(config)
      .then((next) => {
        setConfig(next);
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  const reset = () => {
    setSaving(true);
    setError(null);
    resetRateLimits()
      .then((next) => {
        setConfig(next);
        setSaved(true);
        setTimeout(() => setSaved(false), 1800);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn("corpus-icon-btn nav-button", className)}
          aria-label="Dev rate limits"
          title="Dev rate limits"
        >
          <Gauge className="h-4 w-4" />
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-amber-500" />
            Dev Rate Limits
          </DialogTitle>
          <DialogDescription>
            Adjust the running bridge's per-conversation run limits. Restarting the bridge resets these values.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {(error === "Rate limit config is locked" || error?.startsWith("Dev mode is not unlocked")) && (
            <div className="rounded-lg border border-amber-300/70 bg-amber-500/5 p-3">
              <p className="text-sm font-medium">Dev rate limits are locked</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Enter the server's CORPUS_DEV_MODE_TOKEN to unlock runtime rate-limit controls in this browser.
              </p>
              <div className="mt-3 flex gap-2">
                <Input
                  value={unlockToken}
                  onChange={(event) => setUnlockToken(event.target.value)}
                  placeholder="CORPUS_DEV_MODE_TOKEN"
                  className="h-9 font-mono text-sm"
                />
                <Button type="button" onClick={unlock} disabled={!unlockToken.trim()}>
                  Unlock
                </Button>
              </div>
            </div>
          )}

          <NumberField
            label="Max concurrent runs"
            value={config.maxConcurrentRuns}
            onChange={(value) => {
              setConfig((current) => ({ ...current, maxConcurrentRuns: value }));
              setSaved(false);
            }}
          />

          <div className="grid grid-cols-2 gap-3">
            {(["free", "pro", "hyper", "super"] as Tier[]).map((tier) => (
              <NumberField
                key={tier}
                label={`${tier.toUpperCase()} runs/min`}
                value={config.rpm[tier]}
                onChange={(value) => patchRpm(tier, value)}
              />
            ))}
          </div>

          {error && error !== "Rate limit config is locked" && !error.startsWith("Dev mode is not unlocked") && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="flex items-center justify-between border-t pt-3">
            <Button type="button" variant="ghost" onClick={reset} disabled={saving || loading}>
              <RotateCcw className="h-4 w-4" />
              Reset
            </Button>
            <Button type="button" onClick={save} disabled={saving || loading}>
              {saved ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              {saving ? "Saving..." : saved ? "Saved" : "Save limits"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
