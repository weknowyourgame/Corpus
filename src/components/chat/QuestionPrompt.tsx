import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Check, HelpCircle, BadgeCheck, FileCode, Loader2, RefreshCw, ImageOff } from "lucide-react";
import type { Question, QuestionOption } from "@/stores/chat";

const META_LOAD_MORE = "__load_more__";
const META_SEARCH_AGAIN = "__search_again__";
const isMetaOption = (value?: string) => value === META_LOAD_MORE || value === META_SEARCH_AGAIN;

interface QuestionPromptProps {
  questions: Question[];
  onSubmit: (answers: (string | string[])[]) => void;
  disabled?: boolean;
}

// Helper to normalize options
function normalizeOption(opt: string | QuestionOption): QuestionOption {
  if (typeof opt === "string") {
    return { label: opt, value: opt };
  }
  return { ...opt, value: opt.value ?? opt.label };
}

// Check if any option has an image
function hasImageOptions(options: (string | QuestionOption)[]): boolean {
  return options.some((opt) => typeof opt !== "string" && opt.imageUrl);
}

// Get the value to return for an option
function getOptionValue(opt: string | QuestionOption): string {
  if (typeof opt === "string") return opt;
  return opt.value ?? opt.label;
}

export function QuestionPrompt({ questions, onSubmit, disabled = false }: QuestionPromptProps) {
  const [answers, setAnswers] = useState<(string | string[])[]>(
    questions.map((q) => (q.type === "multi" ? [] : ""))
  );

  const updateAnswer = (index: number, value: string | string[]) => {
    setAnswers((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const toggleMultiOption = (questionIndex: number, option: string) => {
    setAnswers((prev) => {
      const next = [...prev];
      const current = next[questionIndex] as string[];
      next[questionIndex] = current.includes(option)
        ? current.filter((o) => o !== option)
        : [...current, option];
      return next;
    });
  };

  const isComplete = answers.every((a, i) => {
    const q = questions[i];
    if (q.type === "multi") return (a as string[]).length > 0;
    return (a as string).trim().length > 0;
  });

  const handleSubmit = () => {
    if (isComplete && !disabled) {
      onSubmit(answers);
    }
  };

  return (
    <div className="corpus-question-card space-y-4">
      <div className="corpus-question-head">
        <HelpCircle className="w-4 h-4" />
        <span className="text-sm font-medium">AI needs your input</span>
      </div>

      <div className="space-y-4">
        {questions.map((q, qIndex) => (
          <div key={qIndex} className="space-y-2">
            <p className="text-sm font-medium text-foreground">{q.question}</p>

            {q.type === "text" && (
              <Input
                placeholder="Type your answer..."
                value={answers[qIndex] as string}
                onChange={(e) => updateAnswer(qIndex, e.target.value)}
                disabled={disabled}
                className="corpus-question-input bg-white"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && isComplete) {
                    handleSubmit();
                  }
                }}
              />
            )}

            {/* Single choice with images - grid layout */}
            {q.type === "single" && q.options && hasImageOptions(q.options) && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-[480px] overflow-y-auto p-1" data-testid="thumb-grid">
                {q.options.map((opt) => {
                  const normalized = normalizeOption(opt);
                  const isSelected = answers[qIndex] === normalized.value;
                  const verified = normalized.description?.includes("(verified)");
                  const hasScripts = normalized.description?.includes("contains scripts");
                  const meta = isMetaOption(normalized.value);
                  return (
                    <button
                      key={normalized.value}
                      className={cn(
                        "corpus-option-card",
                        "relative flex flex-col rounded-lg border-2 overflow-hidden transition-all text-left",
                        "hover:border-primary/50 hover:shadow-md",
                        isSelected ? "border-primary ring-2 ring-primary/20" : "border-border",
                        meta && "bg-amber-50/40"
                      )}
                      data-testid={meta ? `meta-${normalized.value}` : `asset-${normalized.value}`}
                      onClick={() => updateAnswer(qIndex, normalized.value!)}
                      disabled={disabled}
                    >
                      <div className="aspect-square bg-muted relative flex items-center justify-center">
                        {normalized.imageUrl ? (
                          <img
                            src={normalized.imageUrl}
                            alt={normalized.label}
                            className="w-full h-full object-cover"
                            loading="lazy"
                            onError={(event) => {
                              const target = event.currentTarget;
                              target.style.display = "none";
                              const sibling = target.nextElementSibling as HTMLElement | null;
                              if (sibling) sibling.style.display = "flex";
                            }}
                          />
                        ) : null}
                        <div
                          className="w-full h-full flex flex-col items-center justify-center gap-1 text-muted-foreground"
                          style={{ display: normalized.imageUrl ? "none" : "flex" }}
                        >
                          {normalized.value === META_LOAD_MORE ? (
                            <Loader2 className="w-7 h-7" />
                          ) : normalized.value === META_SEARCH_AGAIN ? (
                            <RefreshCw className="w-7 h-7" />
                          ) : (
                            <>
                              <ImageOff className="w-6 h-6" />
                              <span className="text-[10px]">No preview</span>
                            </>
                          )}
                        </div>
                        {hasScripts && (
                          <div className="absolute top-2 left-2 bg-amber-500 text-white rounded-full px-1.5 py-0.5 text-[9px] font-medium flex items-center gap-0.5" title="Asset contains scripts">
                            <FileCode className="w-2.5 h-2.5" />
                            scripts
                          </div>
                        )}
                        {isSelected && (
                          <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-1">
                            <Check className="w-3 h-3" />
                          </div>
                        )}
                      </div>
                      <div className="p-2">
                        <div className="flex items-center gap-1">
                          <p className="text-xs font-medium truncate flex-1">{normalized.label}</p>
                          {verified && <BadgeCheck className="w-3 h-3 text-blue-500 shrink-0" />}
                        </div>
                        {normalized.description && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {normalized.description}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Single choice without images - button layout */}
            {q.type === "single" && q.options && !hasImageOptions(q.options) && (
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => {
                  const value = getOptionValue(opt);
                  const label = typeof opt === "string" ? opt : opt.label;
                  return (
                    <Button
                      key={value}
                      variant={answers[qIndex] === value ? "default" : "outline"}
                      size="sm"
                      className="h-8"
                      onClick={() => updateAnswer(qIndex, value)}
                      disabled={disabled}
                    >
                      {label}
                    </Button>
                  );
                })}
              </div>
            )}

            {/* Multi choice with images */}
            {q.type === "multi" && q.options && hasImageOptions(q.options) && (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 max-h-[400px] overflow-y-auto p-1">
                {q.options.map((opt) => {
                  const normalized = normalizeOption(opt);
                  const isSelected = (answers[qIndex] as string[]).includes(normalized.value!);
                  return (
                    <button
                      key={normalized.value}
                      className={cn(
                        "corpus-option-card",
                        "relative flex flex-col rounded-lg border-2 overflow-hidden transition-all",
                        "hover:border-primary/50 hover:shadow-md",
                        isSelected
                          ? "border-primary ring-2 ring-primary/20"
                          : "border-border"
                      )}
                      onClick={() => toggleMultiOption(qIndex, normalized.value!)}
                      disabled={disabled}
                    >
                      {normalized.imageUrl ? (
                        <div className="aspect-square bg-muted relative">
                          <img
                            src={normalized.imageUrl}
                            alt={normalized.label}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                          {isSelected && (
                            <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-1">
                              <Check className="w-3 h-3" />
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="aspect-square bg-muted flex items-center justify-center">
                          <span className="text-2xl">📦</span>
                        </div>
                      )}
                      <div className="p-2 text-left">
                        <p className="text-xs font-medium truncate">{normalized.label}</p>
                        {normalized.description && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {normalized.description}
                          </p>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Multi choice without images */}
            {q.type === "multi" && q.options && !hasImageOptions(q.options) && (
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => {
                  const value = getOptionValue(opt);
                  const label = typeof opt === "string" ? opt : opt.label;
                  const selected = (answers[qIndex] as string[]).includes(value);
                  return (
                    <Button
                      key={value}
                      variant={selected ? "default" : "outline"}
                      size="sm"
                      className={cn("h-8 gap-1", selected && "pr-2")}
                      onClick={() => toggleMultiOption(qIndex, value)}
                      disabled={disabled}
                    >
                      {selected && <Check className="w-3 h-3" />}
                      {label}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      <Button
        onClick={handleSubmit}
        disabled={!isComplete || disabled}
        className="w-full"
      >
        Submit Answers
      </Button>
    </div>
  );
}
