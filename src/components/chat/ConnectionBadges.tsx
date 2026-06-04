import { useEffect, useState } from "react";
import { Blocks, Plug, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/stores/roblox";
import { bridgeUrl } from "@/lib/bridge/config";

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
  const [mcpCount, setMcpCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch(bridgeUrl("/agent/mcp/status"), { credentials: "include" })
      .then((res) => res.ok ? res.json() : { servers: [] })
      .then((body: { servers?: Array<{ connected?: boolean }> }) => {
        if (!cancelled) setMcpCount((body.servers ?? []).filter((server) => server.connected).length);
      })
      .catch(() => {
        if (!cancelled) setMcpCount(0);
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className={cn("stud-route-row", className)} aria-label="Connection routes">
      <Badge label={bridge ? "Bridge online" : "Bridge offline"} active={bridge} icon={<Server />} />
      <Badge label={studio ? "Studio connected" : "Studio waiting"} active={studio} icon={<Plug />} />
      <Badge label={mcpCount ? `${mcpCount} MCP` : "MCP none"} active={mcpCount > 0} icon={<Blocks />} />
    </div>
  );
}
