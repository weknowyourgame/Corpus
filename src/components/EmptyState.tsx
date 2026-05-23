import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { StudLogo } from "@/stud-ui";

const CAPABILITIES = [
  "Write Luau scripts",
  "Create & modify instances",
  "Find free models",
  "Debug & optimize",
];

const TYPING_EXAMPLES = [
  "Create an NPC that follows players...",
  "Add a shop GUI with items...",
  "Make a gun that shoots projectiles...",
  "Design a currency system...",
];

export function EmptyState({ className }: { className?: string }) {
  const [typingText, setTypingText] = useState("");
  const [exampleIndex, setExampleIndex] = useState(0);
  const [charIndex, setCharIndex] = useState(0);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    const currentExample = TYPING_EXAMPLES[exampleIndex];

    if (isDeleting) {
      if (charIndex > 0) {
        const timer = setTimeout(() => {
          setTypingText(currentExample.slice(0, charIndex - 1));
          setCharIndex(charIndex - 1);
        }, 30);
        return () => clearTimeout(timer);
      }
      setIsDeleting(false);
      setExampleIndex((exampleIndex + 1) % TYPING_EXAMPLES.length);
      return;
    }

    if (charIndex < currentExample.length) {
      const timer = setTimeout(() => {
        setTypingText(currentExample.slice(0, charIndex + 1));
        setCharIndex(charIndex + 1);
      }, 50);
      return () => clearTimeout(timer);
    }

    const timer = setTimeout(() => setIsDeleting(true), 2000);
    return () => clearTimeout(timer);
  }, [charIndex, exampleIndex, isDeleting]);

  return (
    <div className={cn("flex flex-col items-center text-center py-10", className)}>
      <StudLogo large className="mb-6" />
      <h2 className="stud-display-title" style={{ fontSize: "2rem" }}>
        What would you like to build?
      </h2>
      <p className="stud-display-subtitle max-w-md">
        Stud can help you create, modify, and debug your Roblox game with AI-powered assistance.
      </p>
      <div className="flex flex-wrap justify-center gap-2 mt-8">
        {CAPABILITIES.map((cap) => (
          <span key={cap} className="stud-suggestion-chip">
            {cap}
          </span>
        ))}
      </div>
      <div className="stud-panel-soft mt-8 max-w-sm w-full text-left">
        <p className="text-xs uppercase tracking-wider" style={{ color: "var(--stud-muted)", fontFamily: "var(--stud-tech)" }}>
          Try asking
        </p>
        <p className="mt-2 text-[15px] min-h-[1.5rem]">
          {typingText}
          <span className="opacity-60">|</span>
        </p>
      </div>
    </div>
  );
}
