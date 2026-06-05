import { type ReactNode } from "react";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
} from "@/components/ui/prompt-input";
import { cn } from "@/lib/utils";

export function CorpusComposer({
  value,
  onValueChange,
  onSubmit,
  isLoading,
  isImproving,
  placeholder,
  disabled,
  children,
  className,
  textareaClassName,
}: {
  value: string;
  onValueChange: (v: string) => void;
  onSubmit: () => void;
  isLoading?: boolean;
  isImproving?: boolean;
  placeholder: string;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  textareaClassName?: string;
}) {
  return (
    <div className={cn("corpus-composer-card", className)}>
      <PromptInput
        value={value}
        onValueChange={onValueChange}
        onSubmit={onSubmit}
        isLoading={isLoading}
        maxHeight={160}
        className={cn("border-0 shadow-none bg-transparent rounded-none", isImproving && "relative corpus-shimmer")}
      >
        <div className="corpus-composer-inner">
          <PromptInputTextarea
            placeholder={placeholder}
            disabled={disabled || isImproving}
            className={cn(
              "min-h-[52px] resize-none border-0 bg-transparent p-0 text-[15px] shadow-none focus-visible:ring-0",
              textareaClassName,
              isImproving && "opacity-60"
            )}
          />
        </div>
        <PromptInputActions className="corpus-composer-actions">{children}</PromptInputActions>
      </PromptInput>
    </div>
  );
}
