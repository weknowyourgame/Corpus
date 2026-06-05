import { CheckCircle2, Circle, Loader2, OctagonAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TaskUpdate } from "@/lib/ai/server-agent";

const iconFor = (status: TaskUpdate["status"]) => {
  if (status === "completed") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (status === "in_progress") return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
  if (status === "blocked") return <OctagonAlert className="h-4 w-4 text-amber-600" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
};

export function TaskProgress({ tasks }: { tasks: TaskUpdate[] }) {
  if (!tasks.length) return null;
  return (
    <div className="corpus-panel-soft mx-auto w-full max-w-2xl space-y-2 p-3">
      {tasks.map((task) => (
        <div key={task.taskId} className="flex items-start gap-2 text-sm">
          <span className="mt-0.5">{iconFor(task.status)}</span>
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate", task.status === "completed" && "text-muted-foreground line-through")}>
              {task.title}
            </span>
            {task.note && <span className="block truncate text-xs" style={{ color: "var(--corpus-muted)" }}>{task.note}</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
