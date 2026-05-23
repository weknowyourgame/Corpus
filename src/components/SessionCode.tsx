import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getSessionId, regenerateSessionId, setSessionId } from "@/lib/bridge/session";
import { Copy, RefreshCw, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function SessionCode({ className }: { className?: string }) {
  const [code, setCode] = useState(() => getSessionId());
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const refresh = () => {
    const next = regenerateSessionId();
    setCode(next);
  };

  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-sm text-muted-foreground">
        Enter this code in the Stud plugin in Roblox Studio:
      </p>
      <div className="flex gap-2">
        <Input
          value={code}
          onChange={(e) => {
            const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
            setCode(v);
            if (v.length >= 6) setSessionId(v);
          }}
          className="font-mono text-lg tracking-widest text-center"
          placeholder="SESSION"
        />
        <Button type="button" variant="outline" size="icon" onClick={copy} title="Copy">
          {copied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
        </Button>
        <Button type="button" variant="outline" size="icon" onClick={refresh} title="New code">
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
