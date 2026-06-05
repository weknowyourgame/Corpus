import { BookOpen, Box, FileCode2, ShieldAlert } from "lucide-react";
import type { ChatChipAction } from "./intents";

const content: Record<ChatChipAction, { title: string; body: string; icon: React.ReactNode }> = {
  plan: {
    title: "Plan mode is on",
    body: "Read-only run. Studio changes and code execution are blocked.",
    icon: <ShieldAlert />,
  },
  toolbox: {
    title: "Toolbox search",
    body: "Corpus will show Creator Store choices before any reviewed insertion.",
    icon: <Box />,
  },
  docs: {
    title: "Roblox docs context",
    body: "Corpus will retrieve its Roblox API reference context for this answer.",
    icon: <BookOpen />,
  },
  "run-code": {
    title: "High-risk execution",
    body: "Running Luau requires an approval card before Studio executes it.",
    icon: <FileCode2 />,
  },
};

export function RunContextNotice({ active }: { active: ChatChipAction[] }) {
  if (!active.length) return null;
  return (
    <div className="corpus-mode-notices" aria-live="polite">
      {active.map((chip) => (
        <div key={chip} className={`corpus-mode-notice is-${chip}`}>
          {content[chip].icon}
          <div>
            <p>{content[chip].title}</p>
            <span>{content[chip].body}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
