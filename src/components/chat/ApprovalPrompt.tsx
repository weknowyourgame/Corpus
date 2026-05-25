import { AlertTriangle, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ApprovalDecision, ApprovalRequest } from "@/lib/ai/server-agent";

export function ApprovalPrompt({
  approval,
  onDecision,
}: {
  approval: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const highRisk = approval.risk !== "low_mutation";
  const preview = approval.preview && typeof approval.preview === "object"
    ? approval.preview as Record<string, unknown>
    : null;
  const scriptCount = Number(preview?.scriptCount ?? 0);
  const scripts = Array.isArray(preview?.scripts) ? preview.scripts as Array<Record<string, unknown>> : [];
  const risky = Array.isArray(preview?.riskyDescendants) ? preview.riskyDescendants as Array<Record<string, unknown>> : [];

  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50/70 p-4 space-y-3">
      <div className="flex items-center gap-2 text-amber-800">
        {highRisk ? <AlertTriangle className="h-4 w-4" /> : <ShieldCheck className="h-4 w-4" />}
        <span className="text-sm font-medium">Approval required: {approval.risk.replace(/_/g, " ")}</span>
      </div>
      <p className="text-sm font-medium">{approval.summary}</p>
      <p className="text-xs text-muted-foreground">Approved scope: {approval.scope}</p>
      {preview && (
        <div className="rounded-md border bg-white px-3 py-2 text-xs space-y-1">
          <p className="font-medium">Asset safety preview</p>
          <p>{scriptCount} script(s), {String(preview.riskyDescendantCount ?? 0)} risky descendant(s) detected.</p>
          {(scripts.length > 0 || risky.length > 0) && (
            <details className="pt-1">
              <summary className="cursor-pointer font-medium">Review flagged contents</summary>
              <div className="mt-2 space-y-1 text-muted-foreground">
                {scripts.map((script, index) => (
                  <p key={`script-${index}`}>Script: {String(script.name)} ({String(script.className)})</p>
                ))}
                {risky.map((item, index) => (
                  <p key={`risk-${index}`}>Object: {String(item.name)} ({String(item.className)})</p>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {approval.allowStripScripts && (
          <Button size="sm" onClick={() => onDecision("insert_without_scripts")}>
            Insert without scripts
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={() => onDecision("allow_once")}>
          Allow once
        </Button>
        {!highRisk && (
          <Button variant="outline" size="sm" onClick={() => onDecision("allow_scope")}>
            Approve this scope
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={() => onDecision("deny")}>
          Deny
        </Button>
      </div>
    </div>
  );
}
