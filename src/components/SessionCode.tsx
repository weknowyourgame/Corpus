import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { getSessionId, regenerateSessionId } from "@/lib/bridge/session";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

const PERIOD = 30; // seconds per code cycle

function getSecondsRemaining() {
  return PERIOD - (Math.floor(Date.now() / 1000) % PERIOD);
}

export function SessionCode({ className }: { className?: string }) {
  const [code, setCode] = useState(() => getSessionId());
  const [copied, setCopied] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(getSecondsRemaining);
  const [animating, setAnimating] = useState(false);
  const prevSeconds = useRef(secondsLeft);

  // Tick every second, regenerate when period resets
  useEffect(() => {
    const tick = () => {
      const s = getSecondsRemaining();
      if (s > prevSeconds.current) {
        // Period rolled over — regenerate
        setAnimating(true);
        setTimeout(() => {
          setCode(regenerateSessionId());
          setAnimating(false);
        }, 300);
      }
      prevSeconds.current = s;
      setSecondsLeft(s);
    };
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const progress = ((PERIOD - secondsLeft) / PERIOD) * 100;
  const isUrgent = secondsLeft <= 5;

  return (
    <div className={cn("stud-panel-soft", className)}>
      <p className="text-sm" style={{ color: "var(--stud-muted)" }}>
        Enter this code in the Stud plugin in Roblox Studio:
      </p>

      {/* Code display */}
      <div
        className={cn(
          "mt-3 flex items-center justify-between gap-3 rounded-lg px-4 py-3 transition-all duration-300",
          animating ? "opacity-0 scale-95" : "opacity-100 scale-100"
        )}
        style={{ background: "var(--stud-bg-secondary, rgba(0,0,0,0.04))" }}
      >
        <span
          className="font-mono text-2xl tracking-[0.3em] font-bold select-all"
          style={{ fontFamily: "var(--stud-tech)", color: isUrgent ? "#ef4444" : "var(--stud-text)" }}
        >
          {code}
        </span>
        <Button type="button" variant="ghost" size="icon" onClick={copy} title="Copy code">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </Button>
      </div>

      {/* Progress bar + countdown */}
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "var(--stud-border)" }}>
          <div
            className="h-full rounded-full transition-all duration-1000 ease-linear"
            style={{
              width: `${progress}%`,
              background: isUrgent ? "#ef4444" : "var(--stud-accent, #8b7cf6)",
            }}
          />
        </div>
        <span
          className="text-xs tabular-nums w-6 text-right"
          style={{ color: isUrgent ? "#ef4444" : "var(--stud-muted)" }}
        >
          {secondsLeft}s
        </span>
      </div>
    </div>
  );
}
