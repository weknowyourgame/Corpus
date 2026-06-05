import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type CorpusButtonVariant = "metal" | "dark" | "nav" | "ghost";

export interface CorpusButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: CorpusButtonVariant;
}

export const CorpusButton = forwardRef<HTMLButtonElement, CorpusButtonProps>(
  ({ className, variant = "metal", type = "button", children, ...props }, ref) => {
    const variantClass =
      variant === "dark"
        ? "btn btn-dark"
        : variant === "nav"
          ? "nav-button"
          : variant === "ghost"
            ? "nav-button"
            : "btn btn-metal";

    return (
      <button ref={ref} type={type} className={cn(variantClass, className)} {...props}>
        {children}
      </button>
    );
  }
);

CorpusButton.displayName = "CorpusButton";
