import { cn } from "@/lib/utils";

export function CorpusStatusPill({
  label,
  connected = false,
  className,
}: {
  label: string;
  connected?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("status-pill", className)}>
      <span
        style={
          connected
            ? { background: "#2f9c63" }
            : undefined
        }
      />
      {label}
    </span>
  );
}
