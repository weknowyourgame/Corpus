import { AlertTriangle, Database, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  if (value === null || value === undefined) return <span className="text-muted-foreground italic">empty</span>;
  return (
    <code className="block max-h-32 overflow-auto rounded bg-zinc-100 p-1.5 text-xs whitespace-pre-wrap break-all">
      {value}
      {typeof bytes === "number" && bytes > 0 && (
        <span className="ml-2 text-muted-foreground">({bytes} bytes)</span>
      )}
    </code>
  );
};

function DataStorePreviewCard({ preview }: { preview: DataStorePreview }) {
  if (preview.error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs space-y-1">
        <p className="font-medium text-red-900">DataStore unavailable</p>
        <p className="text-red-800">{preview.error}</p>
        {preview.code === "open_cloud_not_configured" && (
          <p className="text-red-700">
            Add <code>ROBLOX_OPEN_CLOUD_API_KEY</code> and <code>ROBLOX_UNIVERSE_ID</code> to your bridge
            <code>.env</code> and restart <code>npm run dev:bridge</code>.
          </p>
        )}
      </div>
    );
  }
  const envColor = preview.environment === "production"
    ? "bg-red-100 text-red-900 border-red-300"
    : preview.environment === "staging"
      ? "bg-amber-100 text-amber-900 border-amber-300"
      : "bg-emerald-100 text-emerald-900 border-emerald-300";
  return (
    <div className="rounded-md border bg-white px-3 py-2 text-xs space-y-2">
      <div className="flex items-center gap-2">
        <Database className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wide">{preview.operation ?? "datastore"}</span>
        {preview.environment && (
          <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${envColor}`}>
            {preview.environment}
          </span>
        )}
      </div>
      <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
        {preview.universe && <><span className="text-muted-foreground">Universe</span><code>{preview.universe}</code></>}
        {preview.store && <><span className="text-muted-foreground">Store</span><code>{preview.store}</code></>}
        {preview.scope && <><span className="text-muted-foreground">Scope</span><code>{preview.scope}</code></>}
        {preview.key && <><span className="text-muted-foreground">Key</span><code>{preview.key}</code></>}
        {typeof preview.delta === "number" && (
          <><span className="text-muted-foreground">Delta</span><code>{preview.delta > 0 ? `+${preview.delta}` : preview.delta}</code></>
        )}
      </div>
      <div className="space-y-1">
        <p className="text-muted-foreground">Old value (redacted preview)</p>
        {renderValue(preview.oldValue ?? null, preview.oldBytes)}
      </div>
      {preview.operation !== "delete" && (
        <div className="space-y-1">
          <p className="text-muted-foreground">New value (redacted preview)</p>
          {renderValue(preview.newValue ?? null, preview.newBytes)}
        </div>
      )}
      {preview.rollback && (
        <p className="text-[11px] text-muted-foreground border-t pt-2">
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
  const tone = elevated
    ? "border-red-400 bg-red-50/80 text-red-900"
    : highRisk
      ? "border-amber-300 bg-amber-50/70 text-amber-900"
      : "border-emerald-300 bg-emerald-50/70 text-emerald-900";

  return (
    <div className={`rounded-xl border p-4 space-y-3 ${tone}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4" />
        <span className="text-sm font-medium">
          {elevated ? "PRODUCTION approval required" : `Approval required: ${approval.risk.replace(/_/g, " ")}`}
        </span>
      </div>
      <p className="text-sm font-medium">{approval.summary}</p>
      <p className="text-xs text-muted-foreground">Approved scope: {approval.scope}</p>
      {dsPreview && <DataStorePreviewCard preview={dsPreview} />}
      {!dsPreview && preview && (
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
        <Button
          variant={elevated ? "destructive" : "outline"}
          size="sm"
          onClick={() => onDecision("allow_once")}
          disabled={Boolean(dsPreview?.error)}
        >
          {elevated ? "Allow once (PRODUCTION)" : "Allow once"}
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
