import { StudLogo } from "./StudLogo";
import { StudStatusPill } from "./StudStatusPill";
import type { ConnectionStatus, StudioTransportStatus } from "@/stores/roblox";

function statusLabel(status: ConnectionStatus, transport?: StudioTransportStatus | null) {
  if (status === "connected" && transport?.pluginConnected) return "Studio plugin";
  if (status === "connected") return "Studio connected";
  if (status === "bridge_only") return "Waiting for Studio";
  return "Offline";
}

export function StudAppHeader({
  status,
  transport,
  trailing,
  compact = false,
}: {
  status?: ConnectionStatus;
  transport?: StudioTransportStatus | null;
  trailing?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <header className="stud-app-header">
      <div className="stud-brand-lockup">
        <StudLogo large={compact} />
        <span className="stud-brand-subtitle">Roblox Studio Agent</span>
      </div>
      <div className="stud-app-header-actions">
        {status !== undefined && (
          <StudStatusPill
            label={statusLabel(status, transport)}
            connected={status === "connected"}
            className={undefined}
          />
        )}
        {trailing}
      </div>
    </header>
  );
}
