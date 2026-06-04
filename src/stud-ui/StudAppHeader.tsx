import { StudLogo } from "./StudLogo";
import { StudStatusPill } from "./StudStatusPill";
import type { ConnectionStatus, StudioTransportStatus } from "@/stores/roblox";
import { useAuthStore } from "@/stores/auth";

function statusLabel(status: ConnectionStatus, transport?: StudioTransportStatus | null) {
  if (status === "connected" && transport?.pluginConnected) return "Studio plugin";
  if (status === "connected") return "Studio connected";
  if (status === "bridge_only") return "Waiting for Studio";
  return "Offline";
}

function UserBadge() {
  const { user, logout } = useAuthStore();
  if (!user || user.anonymous) return null;
  const label = user.displayName ?? user.email ?? "Account";
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs hover:bg-muted/50 transition-colors"
      title={`Signed in as ${label} — click to sign out`}
      onClick={() => void logout()}
    >
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" referrerPolicy="no-referrer" />
      ) : (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-semibold uppercase text-primary">
          {(label[0] ?? "?").toUpperCase()}
        </span>
      )}
      <span className="max-w-[96px] truncate" style={{ color: "var(--stud-muted)" }}>{label}</span>
    </button>
  );
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
        <UserBadge />
        {trailing}
      </div>
    </header>
  );
}
