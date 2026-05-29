import { Plug, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/stores/roblox";

function Badge({
  label,
  active,
  warning,
  icon,
}: {
  label: string;
  active?: boolean;
  warning?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <span className={cn("stud-route-pill", active && "is-live", warning && "is-warning")}>
      {icon}
      {label}
    </span>
  );
}

export function ConnectionBadges({
  status,
  className,
}: {
  status: ConnectionStatus;
  className?: string;
}) {
  const bridge = status !== "disconnected";
  const studio = status === "connected";

  return (
    <div className={cn("stud-route-row", className)} aria-label="Connection routes">
      <Badge label={bridge ? "Bridge online" : "Bridge offline"} active={bridge} icon={<Server />} />
      <Badge label={studio ? "Studio connected" : "Studio waiting"} active={studio} icon={<Plug />} />
    </div>
  );
}
