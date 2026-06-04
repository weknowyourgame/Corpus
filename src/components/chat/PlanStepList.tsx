import { CheckCircle2, Circle, ShieldAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PlanStep } from "@/lib/ai/server-agent";

export function PlanStepList({
  summary,
  steps,
  consumedStepIndices = [],
}: {
  summary: string;
  steps: PlanStep[];
  consumedStepIndices?: number[];
}) {
  return (
    <div className="stud-panel-soft space-y-3 p-4">
      <div>
        <p className="text-sm font-medium">Proposed plan</p>
        {summary && <p className="text-xs" style={{ color: "var(--stud-muted)" }}>{summary}</p>}
      </div>
      <div className="space-y-2">
        {steps.map((step, idx) => {
          const stepIndex = step.index ?? idx + 1;
          const done = consumedStepIndices.includes(idx) || consumedStepIndices.includes(stepIndex);
          return (
            <div key={`${stepIndex}-${step.title ?? step.summary ?? idx}`} className={cn("flex gap-3 rounded-md border p-3", done && "border-emerald-200 bg-emerald-500/5")}>
              <span className={cn("mt-0.5", done ? "text-emerald-600" : "text-muted-foreground")}>
                {done ? <CheckCircle2 className="h-4 w-4" /> : <Circle className="h-4 w-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium">{step.title || step.summary || "Plan step"}</p>
                  {step.risk !== "read" && <ShieldAlert className="h-3.5 w-3.5 text-amber-600" />}
                </div>
                <p className="text-xs" style={{ color: "var(--stud-muted)" }}>{step.description || step.summary}</p>
                <p className="mt-1 truncate text-[11px]" style={{ color: "var(--stud-muted)" }}>
                  {(step.toolNames?.length ? step.toolNames : step.toolName ? [step.toolName] : []).join(", ")} · {step.scope}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
