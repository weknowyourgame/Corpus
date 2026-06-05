import * as React from "react";
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, FileCode, HelpCircle, ListTree, Search, ShieldX, TableProperties, Wrench, X } from "lucide-react";
import { DiffView } from "@/components/chat/DiffView";
import { cn } from "@/lib/utils";
import { Loader } from "./loader";

export interface ToolCallProps {
  name: string;
  input?: Record<string, unknown>;
  output?: unknown;
  status: "pending" | "running" | "complete" | "error" | "denied" | "waiting";
  error?: string;
  className?: string;
}

type JsonRecord = Record<string, unknown>;

const SCRIPT_TOOLS = new Set(["write_script", "edit_script", "set_script", "read_script"]);

function baseToolName(name: string): string {
  return name.replace(/^mcp__roblox_studio__/, "").replace(/^roblox_/, "");
}

function formatToolName(name: string): string {
  return baseToolName(name)
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function pathFrom(input?: JsonRecord, output?: unknown) {
  const out = asRecord(output);
  return stringValue(out?.path) ?? stringValue(input?.path) ?? stringValue(out?.deleted) ?? "";
}

function sourceLineCount(source: string) {
  if (!source) return 0;
  return source.endsWith("\n") ? source.slice(0, -1).split("\n").length : source.split("\n").length;
}

function hasScriptDiff(name: string, input?: JsonRecord, output?: unknown) {
  const tool = baseToolName(name);
  const out = asRecord(output);
  if (!out) return false;
  const before = stringValue(out.beforeSource) ?? stringValue(out.before);
  const after = stringValue(out.afterSource) ?? stringValue(out.after) ?? (tool === "write_script" ? stringValue(input?.source) : undefined);
  return SCRIPT_TOOLS.has(tool) && (before !== undefined || after !== undefined);
}

function mutationTitle(name: string, before: string, after: string, output?: unknown) {
  const out = asRecord(output);
  if (out?.created === true || (!before && after)) return "Created Script";
  if (out?.deleted === true || (before && !after)) return "Deleted Script";
  return baseToolName(name) === "write_script" ? "Wrote Script" : "Edited Script";
}

function summarizeTool(name: string, input?: JsonRecord, output?: unknown) {
  const tool = baseToolName(name);
  const out = asRecord(output);
  const path = pathFrom(input, output);

  if (tool === "read_script") {
    const source = stringValue(out?.source) ?? "";
    return {
      icon: FileCode,
      title: "Read Script",
      subtitle: path,
      body: (
        <SourcePreview
          source={source}
          meta={[
            out?.revision ? `revision ${String(out.revision)}` : null,
            `${sourceLineCount(source)} lines`,
          ].filter(Boolean).join(" · ")}
        />
      ),
    };
  }

  if (tool === "list_children" || tool === "get_children") {
    const children = Array.isArray(output) ? output : Array.isArray(out?.children) ? out.children : [];
    return {
      icon: ListTree,
      title: "Children",
      subtitle: path || stringValue(input?.path) || "game",
      body: <SimpleTable rows={children.slice(0, 80)} columns={["name", "className", "path"]} empty="No children found." />,
    };
  }

  if (tool === "get_properties") {
    return {
      icon: TableProperties,
      title: "Properties",
      subtitle: path,
      body: <PropertyTable value={out ?? {}} />,
    };
  }

  if (tool === "search_instances" || tool === "search") {
    const rows = Array.isArray(output) ? output : Array.isArray(out?.results) ? out.results : [];
    return {
      icon: Search,
      title: "Search Results",
      subtitle: `${rows.length} match${rows.length === 1 ? "" : "es"}`,
      body: <SimpleTable rows={rows.slice(0, 80)} columns={["name", "className", "path"]} empty="No matches found." />,
    };
  }

  if (tool === "get_selection") {
    const rows = Array.isArray(output) ? output : Array.isArray(out?.selection) ? out.selection : [];
    return {
      icon: ListTree,
      title: "Selection",
      subtitle: `${rows.length} selected`,
      body: <PathList rows={rows} empty="Nothing selected." />,
    };
  }

  if (tool === "create_instance") {
    const className = stringValue(input?.className) ?? "Instance";
    const pathParts = path.split(".");
    const nameValue = stringValue(input?.name) ?? pathParts[pathParts.length - 1] ?? className;
    const parent = stringValue(input?.parent) ?? "";
    return { icon: Check, title: `Created ${className} ${nameValue}`, subtitle: parent ? `in ${parent}` : path, body: null };
  }

  if (tool === "delete_instance" || tool === "delete") {
    return { icon: Check, title: `Deleted ${path || stringValue(input?.path) || "instance"}`, subtitle: "", body: null };
  }

  if (tool === "set_property") {
    return { icon: Check, title: `Changed ${String(input?.property ?? "property")}`, subtitle: path || stringValue(input?.path) || "", body: <ValueLine label="New value" value={input?.value} /> };
  }

  if (tool === "move_instance" || tool === "clone_instance") {
    const from = stringValue(input?.path) ?? "";
    const to = stringValue(input?.newParent) ?? stringValue(input?.parent) ?? path;
    return { icon: Check, title: tool === "move_instance" ? "Moved Instance" : "Cloned Instance", subtitle: `${from} -> ${to}`, body: null };
  }

  if (tool.startsWith("bulk_")) {
    const count = Array.isArray(input?.instances) ? input.instances.length : Array.isArray(input?.paths) ? input.paths.length : Array.isArray(input?.operations) ? input.operations.length : 0;
    return { icon: Check, title: `${formatToolName(name)} (${count})`, subtitle: "", body: <BulkPreview input={input} /> };
  }

  return { icon: Check, title: formatToolName(name), subtitle: path, body: null };
}

export function ToolCall({ name, input, output, status, error, className }: ToolCallProps) {
  const [expanded, setExpanded] = React.useState(status === "complete" || status === "error" || status === "denied");
  React.useEffect(() => {
    if (status === "complete" || status === "error" || status === "denied") setExpanded(true);
  }, [status]);
  const toolInput = input ?? {};
  const out = asRecord(output);
  const tool = baseToolName(name);
  const statusConfig = {
    pending: { icon: <Loader variant="circular" size="sm" />, label: "Waiting", color: "text-muted-foreground", bgColor: "bg-muted/50" },
    running: { icon: <Loader variant="circular" size="sm" />, label: "Running", color: "text-primary", bgColor: "bg-primary/5" },
    waiting: { icon: <HelpCircle className="h-4 w-4" />, label: "Waiting", color: "text-amber-600", bgColor: "bg-amber-50" },
    complete: { icon: <Check className="h-4 w-4" />, label: "Done", color: "text-emerald-600", bgColor: "corpus-tool-success" },
    error: { icon: <X className="h-4 w-4" />, label: "Failed", color: "text-red-600", bgColor: "corpus-tool-error" },
    denied: { icon: <ShieldX className="h-4 w-4" />, label: "Denied", color: "text-amber-700", bgColor: "corpus-tool-denied" },
  }[status];
  const summary = status === "complete" ? summarizeTool(name, toolInput, output) : null;
  const SummaryIcon = summary?.icon ?? Wrench;

  const before = stringValue(out?.beforeSource) ?? stringValue(out?.before) ?? "";
  const after = stringValue(out?.afterSource) ?? stringValue(out?.after) ?? (tool === "write_script" ? stringValue(toolInput.source) ?? "" : "");
  const diffPath = pathFrom(toolInput, output) || "Script";
  const showDiff = status === "complete" && hasScriptDiff(name, toolInput, output);

  return (
    <div className={cn("corpus-tool-call rounded-xl border transition-all", statusConfig.bgColor, className)}>
      <button
        onClick={() => setExpanded((value) => !value)}
        className="corpus-tool-call-header flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <span className="text-muted-foreground">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </span>
        <span className={cn("shrink-0", statusConfig.color)}>
          <SummaryIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            {summary?.title ?? formatToolName(name)}
          </span>
          {summary?.subtitle && <span className="block truncate text-xs text-muted-foreground">{summary.subtitle}</span>}
        </span>
        <span className={cn("flex items-center gap-1.5 text-xs", statusConfig.color)}>
          {statusConfig.icon}
          {statusConfig.label}
        </span>
      </button>

      {expanded && (
        <div className="corpus-tool-call-body space-y-3 px-4 pb-4 pt-0">
          {showDiff && (
            <DiffView
              oldCode={before}
              newCode={after}
              fileName={diffPath}
              title={mutationTitle(name, before, after, output)}
            />
          )}

          {!showDiff && status === "complete" && summary?.body}

          {(status === "error" || status === "denied") && (
            <div className={cn("rounded-lg border p-3 text-sm", status === "denied" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-900")}>
              <div className="mb-1 flex items-center gap-2 font-medium">
                <AlertTriangle className="h-4 w-4" />
                {status === "denied" ? "Action denied" : "Tool failed"}
              </div>
              <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
            </div>
          )}

          <RawDetails input={toolInput} output={output} />
        </div>
      )}
    </div>
  );
}

function SourcePreview({ source, meta }: { source: string; meta: string }) {
  const [full, setFull] = React.useState(false);
  const lines = source.split("\n");
  const preview = full ? lines : lines.slice(0, 24);
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <span className="flex-1">{meta}</span>
        <button type="button" className="corpus-icon-btn h-7 w-7" title="Copy source" onClick={() => void navigator.clipboard?.writeText(source)}>
          <Copy className="h-3.5 w-3.5" />
        </button>
        {lines.length > preview.length && (
          <button type="button" className="text-xs font-medium text-primary" onClick={() => setFull(true)}>
            Show all
          </button>
        )}
      </div>
      <pre className="max-h-72 overflow-auto p-3 font-mono text-xs leading-5">{preview.join("\n") || "(empty)"}</pre>
    </div>
  );
}

function RawDetails({ input, output }: { input?: JsonRecord; output?: unknown }) {
  const [open, setOpen] = React.useState(false);
  return (
    <details className="rounded-lg border bg-background/70" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">Raw details</summary>
      <div className="space-y-3 border-t p-3">
        {input && Object.keys(input).length > 0 && <JsonBlock title="Input" value={input} />}
        {output !== undefined && <JsonBlock title="Output" value={output} />}
      </div>
    </details>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <pre className="corpus-tool-code max-h-64 overflow-auto rounded-lg border bg-muted/30 p-3 text-xs">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function SimpleTable({ rows, columns, empty }: { rows: unknown[]; columns: string[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="max-h-72 overflow-auto rounded-lg border">
      <table className="w-full text-sm">
        <tbody>
          {rows.map((row, index) => {
            const record = asRecord(row) ?? {};
            return (
              <tr key={index} className="border-b last:border-b-0">
                {columns.map((column) => (
                  <td key={column} className="px-3 py-2">
                    <span className={cn(column === "path" && "font-mono text-xs text-muted-foreground")}>{String(record[column] ?? "")}</span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PropertyTable({ value }: { value: JsonRecord }) {
  const properties = asRecord(value.properties) ?? value;
  const rows = Object.entries(properties).filter(([key]) => !["path", "transactionId", "undoWaypoint"].includes(key));
  if (!rows.length) return <p className="text-sm text-muted-foreground">No properties returned.</p>;
  return (
    <div className="max-h-72 overflow-auto rounded-lg border">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(([key, val]) => (
            <tr key={key} className="border-b last:border-b-0">
              <td className="w-44 px-3 py-2 font-medium">{key}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{typeof val === "object" ? JSON.stringify(val) : String(val)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PathList({ rows, empty }: { rows: unknown[]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="space-y-1 rounded-lg border p-2">
      {rows.map((row, index) => {
        const record = asRecord(row);
        const path = record ? stringValue(record.path) ?? stringValue(record.name) : String(row);
        return <div key={index} className="truncate font-mono text-xs text-muted-foreground">{path}</div>;
      })}
    </div>
  );
}

function ValueLine({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="rounded-lg border bg-background px-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-mono text-xs">{typeof value === "object" ? JSON.stringify(value) : String(value ?? "")}</span>
    </div>
  );
}

function BulkPreview({ input }: { input?: JsonRecord }) {
  const items = Array.isArray(input?.instances) ? input.instances : Array.isArray(input?.paths) ? input.paths : Array.isArray(input?.operations) ? input.operations : [];
  if (!items.length) return null;
  return <PathList rows={items.slice(0, 40)} empty="" />;
}

export interface ToolCallsProps {
  toolCalls: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
    result?: unknown;
    status: "pending" | "running" | "complete" | "error" | "denied" | "waiting";
    error?: string;
  }>;
  className?: string;
}

export function ToolCalls({ toolCalls, className }: ToolCallsProps) {
  if (!toolCalls?.length) return null;

  return (
    <div className={cn("space-y-2", className)}>
      {toolCalls.map((tc) => (
        <ToolCall
          key={tc.id}
          name={tc.name}
          input={tc.args}
          output={tc.result}
          status={tc.status}
          error={tc.error}
        />
      ))}
    </div>
  );
}
