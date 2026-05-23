import { StudLogo } from "./StudLogo";
import { StudStatusPill } from "./StudStatusPill";
import type { ConnectionStatus } from "@/stores/roblox";

function statusLabel(status: ConnectionStatus) {
  if (status === "connected") return "Connected";
  if (status === "bridge_only") return "Waiting for Studio";
  return "Offline";
}

export function StudAppHeader({
  status,
  trailing,
  compact = false,
}: {
  status?: ConnectionStatus;
  trailing?: React.ReactNode;
  compact?: boolean;
}) {
  return (
    <header className="stud-app-header">
      <StudLogo large={compact} />
      <div className="stud-app-header-actions">
        {status !== undefined && (
          <StudStatusPill label={statusLabel(status)} connected={status === "connected"} />
        )}
        {trailing}
      </div>
    </header>
  );
}
