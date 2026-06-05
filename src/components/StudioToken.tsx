import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Copy, Check, RefreshCw, Wifi, WifiOff } from "lucide-react";
import QRCode from "react-qr-code";
import { useStudioTokenStore } from "@/stores/studio-token";
import { cn } from "@/lib/utils";

export function StudioToken({ className }: { className?: string }) {
  const { token, isGenerating, error, generate, clear, checkStudioConnected } = useStudioTokenStore();
  const [copied, setCopied] = useState(false);
  const [studioConnected, setStudioConnected] = useState(false);

  useEffect(() => {
    if (!token) return;
    checkStudioConnected().then(setStudioConnected);
    const interval = setInterval(async () => {
      setStudioConnected(await checkStudioConnected());
    }, 3000);
    return () => clearInterval(interval);
  }, [token]);

  const copy = async () => {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("corpus-panel-soft space-y-4", className)}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium" style={{ color: "var(--corpus-text)" }}>
          Studio Token
        </p>
        {token && (
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs px-2 py-0.5 rounded-full font-medium",
              studioConnected
                ? "bg-green-500/10 text-green-600"
                : "bg-red-500/10 text-red-500"
            )}
          >
            {studioConnected ? (
              <Wifi className="w-3 h-3" />
            ) : (
              <WifiOff className="w-3 h-3" />
            )}
            {studioConnected ? "Studio connected" : "Not connected"}
          </div>
        )}
      </div>

      <p className="text-xs" style={{ color: "var(--corpus-muted)" }}>
        Paste this token into the Corpus plugin in Roblox Studio. No session code needed — it connects automatically.
      </p>

      {token ? (
        <>
          {/* Token string */}
          <div
            className="flex items-start gap-2 rounded-lg px-3 py-2.5"
            style={{ background: "var(--corpus-bg-secondary, rgba(0,0,0,0.04))" }}
          >
            <code
              className="flex-1 text-xs break-all font-mono select-all leading-relaxed"
              style={{ color: "var(--corpus-text)" }}
            >
              {token}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="shrink-0 h-7 w-7 mt-0.5"
              onClick={copy}
              title="Copy token"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-green-600" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </Button>
          </div>

          {/* QR code */}
          <div
            className="flex justify-center p-4 rounded-lg"
            style={{ background: "var(--corpus-bg-secondary, rgba(0,0,0,0.04))" }}
          >
            <QRCode value={token} size={128} level="M" />
          </div>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-xs"
              onClick={() => generate()}
              disabled={isGenerating}
            >
              <RefreshCw className={cn("w-3 h-3 mr-1.5", isGenerating && "animate-spin")} />
              Regenerate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 text-xs text-red-500 hover:text-red-600"
              onClick={() => clear()}
            >
              Clear token
            </Button>
          </div>
        </>
      ) : (
        <Button className="w-full" onClick={() => generate()} disabled={isGenerating}>
          {isGenerating ? "Generating..." : "Generate token"}
        </Button>
      )}

      {error && (
        <p className="text-xs text-red-500">
          {error} — is the bridge server running?
        </p>
      )}
    </div>
  );
}
