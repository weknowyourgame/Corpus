/**
 * Prerequisite Wizard
 *
 * Shows on app startup when prerequisites are not met.
 * Only displays items that need attention.
 */

import { useEffect } from "react";
import { usePrereqStore, type PrereqCheck } from "@/stores/prereq";
import { Loader } from "@/components/ui/loader";
import { cn } from "@/lib/utils";
import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { CorpusLogo } from "@/corpus-ui";
import { Button } from "@/components/ui/button";
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  ExternalLink,
  Download,
  Plug,
  Server,
  Monitor,
} from "lucide-react";

const iconMap: Record<string, React.ElementType> = {
  "roblox-studio": Monitor,
  "corpus-plugin": Plug,
  "bridge-server": Server,
  "studio-connection": Plug,
};

function StatusIcon({ status }: { status: PrereqCheck["status"] }) {
  switch (status) {
    case "pending":
      return <div className="w-5 h-5 rounded-full border-2 border-neutral-300" />;
    case "checking":
      return <Loader2 className="w-5 h-5 animate-spin text-neutral-500" />;
    case "passed":
      return <CheckCircle className="w-5 h-5 text-green-500" />;
    case "failed":
      return <XCircle className="w-5 h-5 text-red-500" />;
    case "warning":
      return <AlertTriangle className="w-5 h-5 text-amber-500" />;
  }
}

function CheckItem({
  check,
  onAction,
}: {
  check: PrereqCheck;
  onAction: (handler: string) => void;
}) {
  const Icon = iconMap[check.id] || Plug;
  const isIssue = check.status === "failed" || check.status === "warning";

  return (
    <div className="corpus-prereq-check corpus-panel flex items-start gap-4 p-4">
      <div
        className={cn(
          "corpus-prereq-check-icon p-2 rounded-lg",
          check.status === "failed" && "is-failed",
          check.status === "warning" && "is-warning",
          check.status === "passed" && "is-passed",
          (check.status === "pending" || check.status === "checking") && "is-pending"
        )}
      >
        <Icon className="w-5 h-5" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h3 className="font-medium">{check.name}</h3>
          <StatusIcon status={check.status} />
        </div>
        <p className="text-sm text-neutral-600 mt-0.5">{check.description}</p>
        {check.message && (
          <p
            className={cn(
              "text-sm mt-1",
              check.status === "failed" && "text-red-600",
              check.status === "warning" && "text-amber-600",
              check.status === "passed" && "text-green-600"
            )}
          >
            {check.message}
          </p>
        )}
        {isIssue && check.action && (
          <div className="mt-3">
            {check.action.handler === "open-settings" ? (
              <SettingsDialog>
                <Button variant="dark" size="sm">{check.action.label}</Button>
              </SettingsDialog>
            ) : (
              <Button variant="dark" size="sm" onClick={() => onAction(check.action!.handler)}>
                {check.action.handler === "download-studio" && <Download className="w-4 h-4" />}
                {check.action.handler === "install-plugin" && <Plug className="w-4 h-4" />}
                {check.action.label}
                {check.action.handler === "download-studio" && <ExternalLink className="w-3 h-3" />}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function PrereqWizard() {
  const { checks, isChecking, showWizard, runAllChecks, dismissWizard, getFailedChecks, getWarningChecks } =
    usePrereqStore();

  useEffect(() => {
    runAllChecks();
  }, [runAllChecks]);

  const handleAction = async (handler: string) => {
    switch (handler) {
      case "download-studio":
        window.open("https://create.roblox.com/", "_blank", "noopener,noreferrer");
        break;
      case "install-plugin": {
        const a = document.createElement("a");
        a.href = "/studio-plugin/corpus-bridge.server.lua";
        a.download = "corpus-bridge.server.lua";
        a.click();
        runAllChecks();
        break;
      }
      case "restart-app":
        window.location.reload();
        break;
      case "show-connection-help":
        // Will be handled by dismissing and showing connection screen
        dismissWizard();
        break;
    }
  };

  const failedChecks = getFailedChecks();
  const warningChecks = getWarningChecks();
  const hasIssues = failedChecks.length > 0;

  // Don't render if no wizard needed
  if (!showWizard && !isChecking) {
    return null;
  }

  // Show loading state while checking
  if (isChecking) {
    return (
      <div className="corpus-prereq-screen fixed inset-0 z-50 flex items-center justify-center">
        <div className="text-center">
          <Loader variant="wave" size="lg" />
          <p className="mt-4" style={{ color: "var(--corpus-muted)" }}>Checking prerequisites...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="corpus-prereq-screen fixed inset-0 z-50 overflow-auto">
      <div className="corpus-prereq-content max-w-2xl mx-auto px-6 py-12">
        <div className="corpus-prereq-heading text-center mb-8">
          <CorpusLogo className="justify-center mb-6" />
          <h1 className="corpus-display-title" style={{ fontSize: "2.25rem" }}>Setup Required</h1>
          <p className="corpus-display-subtitle">
            {hasIssues
              ? "Some prerequisites need your attention before using Corpus."
              : "Almost ready! Just a few optional items to review."}
          </p>
        </div>

        {/* Failed checks (required) */}
        {failedChecks.length > 0 && (
          <div className="mb-6">
            <h2 className="corpus-prereq-section-title is-required text-sm font-medium uppercase tracking-wide mb-3">
              Required
            </h2>
            <div className="space-y-3">
              {failedChecks.map((check) => (
                <CheckItem key={check.id} check={check} onAction={handleAction} />
              ))}
            </div>
          </div>
        )}

        {/* Warning checks (optional) */}
        {warningChecks.length > 0 && (
          <div className="mb-6">
            <h2 className="corpus-prereq-section-title is-recommended text-sm font-medium uppercase tracking-wide mb-3">
              Recommended
            </h2>
            <div className="space-y-3">
              {warningChecks.map((check) => (
                <CheckItem key={check.id} check={check} onAction={handleAction} />
              ))}
            </div>
          </div>
        )}

        {/* Passed checks (collapsed) */}
        <details className="mb-8">
          <summary className="text-sm font-medium text-neutral-500 cursor-pointer hover:text-neutral-700">
            Show all checks ({checks.filter((c) => c.status === "passed").length} passed)
          </summary>
          <div className="mt-3 space-y-3">
            {checks
              .filter((c) => c.status === "passed")
              .map((check) => (
                <CheckItem key={check.id} check={check} onAction={handleAction} />
              ))}
          </div>
        </details>

        {/* Actions */}
        <div className="corpus-prereq-actions flex items-center justify-center gap-4">
          <Button variant="outline" onClick={() => runAllChecks()}>Re-check</Button>
          {!hasIssues && (
            <Button variant="dark" onClick={dismissWizard}>Continue to Corpus</Button>
          )}
          {hasIssues && (
            <Button variant="ghost" onClick={dismissWizard}>Skip for now</Button>
          )}
        </div>

        {hasIssues && (
          <p className="text-center text-xs text-neutral-500 mt-4">
            Some features may not work without completing the required setup.
          </p>
        )}
      </div>
    </div>
  );
}
