import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type StudButtonVariant = "metal" | "dark" | "nav" | "ghost";

export interface StudButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: StudButtonVariant;
}

export const StudButton = forwardRef<HTMLButtonElement, StudButtonProps>(
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

StudButton.displayName = "StudButton";
