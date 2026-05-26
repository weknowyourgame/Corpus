import { BookOpen, Play, FileText, Box } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ChatChipAction } from "./intents";

export type ChipAction = ChatChipAction;

interface ContextChip {
  id: ChipAction;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const chips: ContextChip[] = [
  {
    id: "toolbox",
    label: "Toolbox",
    icon: <Box className="w-3.5 h-3.5" />,
    description: "Search Creator Store assets and review before inserting",
  },
  {
    id: "docs",
    label: "Docs",
    icon: <BookOpen className="w-3.5 h-3.5" />,
    description: "Search Roblox documentation",
  },
  {
    id: "run-code",
    label: "Run Code",
    icon: <Play className="w-3.5 h-3.5" />,
    description: "High risk: execute Luau only after explicit approval",
  },
  {
    id: "plan",
    label: "Plan",
    icon: <FileText className="w-3.5 h-3.5" />,
    description: "Read-only plan mode; changes are blocked",
  },
];

export function ContextChips({
  onChipClick,
  activeChips = [],
  disabled = false,
}: {
  onChipClick: (chipId: ChipAction) => void;
  activeChips?: ChipAction[];
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {chips.map((chip) => {
        const isActive = activeChips.includes(chip.id);
        return (
          <button
            key={chip.id}
            type="button"
            className={cn("stud-action-chip flex items-center gap-1.5 shrink-0", isActive && "is-active")}
            onClick={() => onChipClick(chip.id)}
            disabled={disabled}
            title={chip.description}
            aria-pressed={isActive}
          >
            {chip.icon}
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

export { chips };
export type { ContextChip };
