import { BookOpen, Globe, Play, FileText, Box } from "lucide-react";
import { cn } from "@/lib/utils";

export type ChipAction = "search-models" | "docs" | "web" | "run-code" | "plan" | "toolbox";

interface ContextChip {
  id: ChipAction;
  label: string;
  icon: React.ReactNode;
  description: string;
}

const chips: ContextChip[] = [
  {
    id: "search-models",
    label: "Models",
    icon: <Box className="w-3.5 h-3.5" />,
    description: "Search free models from Creator Store",
  },
  {
    id: "docs",
    label: "Docs",
    icon: <BookOpen className="w-3.5 h-3.5" />,
    description: "Search Roblox documentation",
  },
  {
    id: "web",
    label: "Web",
    icon: <Globe className="w-3.5 h-3.5" />,
    description: "Search the web",
  },
  {
    id: "run-code",
    label: "Run",
    icon: <Play className="w-3.5 h-3.5" />,
    description: "Execute Luau code in Studio",
  },
  {
    id: "plan",
    label: "Plan",
    icon: <FileText className="w-3.5 h-3.5" />,
    description: "Create a plan before building",
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
            className={cn("stud-suggestion-chip flex items-center gap-1.5 shrink-0", isActive && "border-[#1a1817]/25 bg-white text-[#1a1817]")}
            onClick={() => onChipClick(chip.id)}
            disabled={disabled}
            title={chip.description}
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
