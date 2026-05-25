import { useState } from "react";
import { DiffView } from "./DiffView";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronRight, CheckCircle2 } from "lucide-react";

interface MutationDiffProps {
  toolName: string;
  path: string;
  before?: string;
  after?: string;
  transactionId: string;
  className?: string;
}

export function MutationDiff({ toolName, path, before, after, transactionId, className }: MutationDiffProps) {
  const [expanded, setExpanded] = useState(false);
  const hasDiff = before !== undefined && after !== undefined;
  const shortPath = path.split(".").slice(-2).join(".");
  const shortTool = toolName.replace(/^mcp__roblox_studio__/, "").replace(/_/g, " ");

  if (!hasDiff) {
    return (
      <div className={cn("flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-green-50 border border-green-200", className)}>
        <CheckCircle2 className="w-4 h-4 text-green-600 flex-shrink-0" />
        <span className="text-green-800 font-medium truncate">{shortPath}</span>
        <span className="text-green-600 text-xs ml-auto">{shortTool}</span>
      </div>
    );
  }

  return (
    <div className={cn("rounded-lg border border-border overflow-hidden text-sm", className)}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
        title={transactionId}
      >
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
        <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
        <span className="font-medium truncate flex-1">{shortPath}</span>
        <span className="text-muted-foreground text-xs">{shortTool}</span>
      </button>
      {expanded && (
        <DiffView
          oldCode={before}
          newCode={after}
          fileName={path}
          defaultExpanded={true}
        />
      )}
    </div>
  );
}
