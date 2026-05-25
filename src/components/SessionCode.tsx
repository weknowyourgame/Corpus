import { useState } from "react";
import { Button } from "@/components/ui/button";
import { getSessionId } from "@/lib/bridge/session";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function SessionCode({ className }: { className?: string }) {
  const [code] = useState(() => getSessionId());
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("stud-panel-soft", className)}>
      <p className="text-sm" style={{ color: "var(--stud-muted)" }}>
        Enter this code in the Stud plugin in Roblox Studio:
      </p>

      {/* Code display */}
      <div
        className={cn(
          "mt-3 flex items-center justify-between gap-3 rounded-lg px-4 py-3 transition-all duration-300"
        )}
        style={{ background: "var(--stud-bg-secondary, rgba(0,0,0,0.04))" }}
      >
        <span
          className="font-mono text-2xl tracking-[0.3em] font-bold select-all"
          style={{ fontFamily: "var(--stud-tech)", color: "var(--stud-text)" }}
        >
          {code}
        </span>
        <Button type="button" variant="ghost" size="icon" onClick={copy} title="Copy code">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>

      <p className="mt-2 text-xs" style={{ color: "var(--stud-muted)" }}>
        This pairing code stays active while you work in this browser.
      </p>
    </div>
  );
}
