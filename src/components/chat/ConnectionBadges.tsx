import { useCallback, useEffect, useState } from "react";
import { Blocks, Check, Copy, Plug, RefreshCw, Search, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ConnectionStatus } from "@/stores/roblox";
import { bridgeUrl } from "@/lib/bridge/config";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type McpServerStatus = {
  name: string;
  url: string;
  connected: boolean;
  tools: string[];
  lastError?: string;
};

type McpStatusResponse = {
  configuredCount: number;
  connectedCount: number;
  totalToolCount: number;
  lastLoadedAt: string | null;
  servers: McpServerStatus[];
};

const emptyStatus: McpStatusResponse = {
  configuredCount: 0,
  connectedCount: 0,
  totalToolCount: 0,
  lastLoadedAt: null,
  servers: [],
};

function Badge({
  label,
  active,
  warning,
  icon,
  asButton,
}: {
  label: string;
  active?: boolean;
  warning?: boolean;
  icon: React.ReactNode;
  asButton?: boolean;
}) {
  const Comp = asButton ? "button" : "span";
  return (
    <Comp type={asButton ? "button" : undefined} className={cn("stud-route-pill", active && "is-live", warning && "is-warning")}>
      {icon}
      {label}
    </Comp>
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
  const [mcpStatus, setMcpStatus] = useState<McpStatusResponse>(emptyStatus);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [copied, setCopied] = useState(false);

  const loadStatus = useCallback(() => {
    setIsRefreshing(true);
    fetch(bridgeUrl("/agent/mcp/status"), { credentials: "include" })
      .then((res) => (res.ok ? res.json() : emptyStatus))
      .then((body: McpStatusResponse) => setMcpStatus(body))
      .catch(() => {})
      .finally(() => setIsRefreshing(false));
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  const hasMcpErrors = mcpStatus.servers.some((s) => s.lastError);

  const envSnippet = mcpStatus.servers.length > 0
    ? `STUD_MCP_SERVERS=${mcpStatus.servers.map((s) => `${s.name}:${s.url}`).join(",")}`
    : "";

  const handleCopy = () => {
    void navigator.clipboard.writeText(envSnippet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const lastLoaded = mcpStatus.lastLoadedAt
    ? new Date(mcpStatus.lastLoadedAt).toLocaleTimeString()
    : null;

  const filteredServers = mcpStatus.servers.map((s) => ({
    ...s,
    filteredTools: searchQuery
      ? s.tools.filter((t) => t.toLowerCase().includes(searchQuery.toLowerCase()))
      : s.tools,
  }));

  return (
    <div className={cn("stud-route-row", className)} aria-label="Connection routes">
      <Badge label={bridge ? "Bridge online" : "Bridge offline"} active={bridge} icon={<Server />} />
      <Badge label={studio ? "Studio connected" : "Studio waiting"} active={studio} icon={<Plug />} />
      <Dialog onOpenChange={(open) => { if (open) loadStatus(); }}>
        <DialogTrigger asChild>
          <Badge
            asButton
            label={mcpStatus.connectedCount ? `${mcpStatus.connectedCount} MCP` : hasMcpErrors ? "MCP error" : "MCP none"}
            active={mcpStatus.connectedCount > 0}
            warning={hasMcpErrors}
            icon={<Blocks />}
          />
        </DialogTrigger>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>MCP servers</DialogTitle>
            <DialogDescription>
              External MCP tools configured with STUD_MCP_SERVERS load when the bridge starts.
            </DialogDescription>
          </DialogHeader>

          {/* Summary counts + refresh */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs" style={{ color: "var(--stud-muted)" }}>
              <span>{mcpStatus.configuredCount} configured</span>
              <span className="opacity-40">·</span>
              <span>{mcpStatus.connectedCount} connected</span>
              <span className="opacity-40">·</span>
              <span>{mcpStatus.totalToolCount} tool{mcpStatus.totalToolCount !== 1 ? "s" : ""}</span>
              {lastLoaded && (
                <>
                  <span className="opacity-40">·</span>
                  <span>loaded {lastLoaded}</span>
                </>
              )}
            </div>
            <button
              onClick={loadStatus}
              disabled={isRefreshing}
              title="Refresh MCP status"
              className="rounded p-1 hover:bg-accent disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")} style={{ color: "var(--stud-muted)" }} />
            </button>
          </div>

          {/* Tool search */}
          {mcpStatus.totalToolCount > 0 && (
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5" style={{ color: "var(--stud-muted)" }} />
              <input
                placeholder="Filter tools…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full rounded-md border bg-transparent py-2 pl-8 pr-3 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          )}

          <div className="max-h-72 space-y-3 overflow-y-auto">
            {mcpStatus.servers.length === 0 ? (
              <div className="stud-panel-soft p-3 text-sm" style={{ color: "var(--stud-muted)" }}>
                No external MCP servers configured. Add entries like <code>docs:https://mcp.example.com/mcp</code> to <code>STUD_MCP_SERVERS</code>.
              </div>
            ) : (
              filteredServers.map((server) => (
                <div key={`${server.name}-${server.url}`} className="rounded-lg border p-3 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium">{server.name}</p>
                      <p className="truncate text-xs" style={{ color: "var(--stud-muted)" }}>{server.url}</p>
                    </div>
                    <span className={cn("status-pill", server.connected && "is-live")}>
                      <span style={{ background: server.connected ? "#2f9c63" : "#d28c2f" }} />
                      {server.connected ? "Connected" : "Error"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs" style={{ color: "var(--stud-muted)" }}>
                    {searchQuery && server.filteredTools.length !== server.tools.length
                      ? `${server.filteredTools.length} of ${server.tools.length} tool${server.tools.length !== 1 ? "s" : ""} match`
                      : `${server.tools.length} tool${server.tools.length !== 1 ? "s" : ""}`}
                  </p>
                  {server.filteredTools.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {server.filteredTools.map((tool) => (
                        <span key={tool} className="stud-suggestion-chip text-[11px] py-1">
                          {tool.replace(`mcp__${server.name}__`, "") || tool}
                        </span>
                      ))}
                    </div>
                  )}
                  {server.lastError && (
                    <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-900">
                      {server.lastError}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>

          {/* Copyable env snippet */}
          {envSnippet && (
            <div className="rounded-md border p-3 text-xs">
              <div className="mb-1.5 flex items-center justify-between">
                <span className="font-medium" style={{ color: "var(--stud-muted)" }}>Config snippet</span>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent"
                  style={{ color: "var(--stud-muted)" }}
                >
                  {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                  <span>{copied ? "Copied" : "Copy"}</span>
                </button>
              </div>
              <code className="block break-all font-mono text-[11px]" style={{ color: "var(--stud-muted)" }}>
                {envSnippet}
              </code>
            </div>
          )}

          <p className="text-xs" style={{ color: "var(--stud-muted)" }}>
            Authentication is handled by the upstream MCP URL or gateway configuration; restart the bridge after changing server entries.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
