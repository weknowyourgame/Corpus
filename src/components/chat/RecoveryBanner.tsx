import { AlertTriangle, Info, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function recoveryCopy(error: string) {
  const provider = /provider|credential|api[_ ]?key|set (anthropic|openrouter|stud_codex)/i.test(error);
  const plugin = /instance not found:\s*game|studio request|plugin|waiting for studio/i.test(error);
  const cancelled = /cancel/i.test(error);

  if (provider) {
    return {
      title: "Model access is not available",
      detail: "Stud-managed model access is unavailable on this server. Retry later or contact the workspace admin.",
    };
  }
  if (plugin) {
    return {
      title: "Studio connection needs attention",
      detail: "If Studio says connected but tools fail, download and reload the latest Stud plugin, then reconnect your session code.",
    };
  }
  if (cancelled) {
    return {
      title: "Run cancelled",
      detail: "Nothing else will execute from that run. Edit your request and send again when ready.",
    };
  }
  return {
    title: "The run stopped before completion",
    detail: "Check the Studio connection badges, then retry your message.",
  };
}

export function RecoveryBanner({
  error,
  onDismiss,
  onRetry,
}: {
  error: string;
  onDismiss?: () => void;
  onRetry?: () => void;
}) {
  const copy = recoveryCopy(error);
  return (
    <section className="stud-recovery-banner" role="alert">
      <AlertTriangle className="stud-recovery-icon" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{copy.title}</p>
        <p className="mt-1 text-sm">{copy.detail}</p>
        <p className="stud-recovery-detail">{error}</p>
      </div>
      <div className="stud-recovery-actions">
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCcw />
            Retry
          </Button>
        )}
        {onDismiss && (
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            <Info />
            Dismiss
          </Button>
        )}
      </div>
    </section>
  );
}
