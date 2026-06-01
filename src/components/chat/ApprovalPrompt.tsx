import { AlertTriangle, Database, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ApprovalDecision, ApprovalRequest } from "@/lib/ai/server-agent";

type DataStorePreview = {
  operation?: "write" | "delete" | "increment";
  environment?: "development" | "staging" | "production";
  universe?: string;
  store?: string;
  scope?: string;
  key?: string;
  oldValue?: string | null;
  oldBytes?: number;
  newValue?: string | null;
  newBytes?: number;
  delta?: number;
  elevated?: boolean;
  rollback?: string;
  error?: string;
  code?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDataStoreApproval = (approval: ApprovalRequest): boolean =>
  approval.toolName.startsWith("roblox_datastore__");

const renderValue = (value: string | null | undefined, bytes?: number) => {
  if (value === null || value === undefined) return <span className="stud-approval-empty">empty</span>;
  return (
    <code className="stud-approval-code">
      {value}
      {typeof bytes === "number" && bytes > 0 && (
        <span className="ml-2">({bytes} bytes)</span>
      )}
    </code>
  );
};

function DataStorePreviewCard({ preview }: { preview: DataStorePreview }) {
  if (preview.error) {
    return (
      <div className="stud-approval-preview is-error">
        <p className="font-medium">DataStore unavailable</p>
        <p>{preview.error}</p>
        {preview.code === "open_cloud_not_configured" && (
          <p>
            Add <code>ROBLOX_OPEN_CLOUD_API_KEY</code> and <code>ROBLOX_UNIVERSE_ID</code> to your bridge
            <code>.env</code> and restart <code>npm run dev:bridge</code>.
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="stud-approval-preview">
      <div className="stud-approval-preview-head">
        <Database className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wide">{preview.operation ?? "datastore"}</span>
        {preview.environment && (
          <span className={cn("stud-approval-env", `is-${preview.environment}`)}>
            {preview.environment}
          </span>
        )}
      </div>
      <div className="stud-approval-kv">
        {preview.universe && <><span>Universe</span><code>{preview.universe}</code></>}
        {preview.store && <><span>Store</span><code>{preview.store}</code></>}
        {preview.scope && <><span>Scope</span><code>{preview.scope}</code></>}
        {preview.key && <><span>Key</span><code>{preview.key}</code></>}
        {typeof preview.delta === "number" && (
          <><span>Delta</span><code>{preview.delta > 0 ? `+${preview.delta}` : preview.delta}</code></>
        )}
      </div>
      <div className="space-y-1">
        <p>Old value (redacted preview)</p>
        {renderValue(preview.oldValue ?? null, preview.oldBytes)}
      </div>
      {preview.operation !== "delete" && (
        <div className="space-y-1">
          <p>New value (redacted preview)</p>
          {renderValue(preview.newValue ?? null, preview.newBytes)}
        </div>
      )}
      {preview.rollback && (
        <p className="stud-approval-rollback">
          <span className="font-medium">Rollback:</span> {preview.rollback}
        </p>
      )}
    </div>
  );
}

export function ApprovalPrompt({
  approval,
  onDecision,
}: {
  approval: ApprovalRequest;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const dataStore = isDataStoreApproval(approval);
  const elevated = Boolean(approval.elevated);
  const highRisk = approval.risk !== "low_mutation";
  const preview = isRecord(approval.preview) ? (approval.preview as Record<string, unknown>) : null;
  const dsPreview: DataStorePreview | null = dataStore && preview ? (preview as DataStorePreview) : null;
  const scriptCount = !dataStore ? Number(preview?.scriptCount ?? 0) : 0;
  const scripts = !dataStore && Array.isArray(preview?.scripts) ? (preview.scripts as Array<Record<string, unknown>>) : [];
  const risky = !dataStore && Array.isArray(preview?.riskyDescendants) ? (preview.riskyDescendants as Array<Record<string, unknown>>) : [];

  const Icon = elevated ? ShieldAlert : highRisk ? AlertTriangle : ShieldCheck;

  return (
    <div
      className={cn(
        "stud-approval-card",
        elevated && "is-elevated",
        highRisk && !elevated && "is-risk"
      )}
    >
      <div className="stud-approval-head">
        <Icon className="h-4 w-4" />
        <span className="text-sm font-medium">
          {elevated ? "PRODUCTION approval required" : `Approval required: ${approval.risk.replace(/_/g, " ")}`}
        </span>
      </div>
      <p className="stud-approval-summary">{approval.summary}</p>
      <p className="stud-approval-scope">Scope: {approval.scope}</p>
      {!highRisk && approval.scopeDescription && (
        <p className="stud-approval-scope" style={{ opacity: 0.7 }}>
          Will remember: {approval.scopeDescription}
        </p>
      )}
      {dsPreview && <DataStorePreviewCard preview={dsPreview} />}
      {!dsPreview && preview && (
        <div className="stud-approval-preview">
          <p className="font-medium">Asset safety preview</p>
          <p>{scriptCount} script(s), {String(preview.riskyDescendantCount ?? 0)} risky descendant(s) detected.</p>
          {(scripts.length > 0 || risky.length > 0) && (
            <details className="pt-1">
              <summary className="cursor-pointer font-medium">Review flagged contents</summary>
              <div className="mt-2 space-y-1">
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
      <div className="stud-approval-actions">
        {approval.allowStripScripts && (
          <Button size="sm" onClick={() => onDecision("insert_without_scripts")}>
            Insert without scripts
          </Button>
        )}
        <Button
          variant={elevated ? "destructive" : "outline"}
          size="sm"
          onClick={() => onDecision("allow_once")}
          disabled={Boolean(dsPreview?.error)}
        >
          {elevated ? "Allow once (PRODUCTION)" : "Allow once"}
        </Button>
        {!highRisk && (
          <Button variant="outline" size="sm" onClick={() => onDecision("allow_scope")} title={approval.scopeDescription ? `Will remember: ${approval.scopeDescription}` : undefined}>
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
