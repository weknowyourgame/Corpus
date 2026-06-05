import { useMemo, useState, type ReactNode } from "react";
import { Copy, FileCode, Maximize2, Minus, Plus } from "lucide-react";
import { buildStructuredDiff, type DiffRange, type StructuredDiffLine } from "./structured-diff";
import { cn } from "@/lib/utils";

interface DiffViewProps {
  oldCode: string;
  newCode: string;
  fileName?: string;
  language?: string;
  className?: string;
  title?: string;
  defaultExpanded?: boolean;
}

const MAX_FULL_DIFF_LINES = 2500;

function renderSegments(content: string, ranges?: DiffRange[]) {
  if (!ranges?.length) return content || " ";
  const segments: ReactNode[] = [];
  let cursor = 0;

  ranges.forEach((range, index) => {
    if (range.start > cursor) segments.push(content.slice(cursor, range.start));
    segments.push(
      <span key={`${range.start}-${range.end}-${index}`} className="rounded-[3px] bg-current/15 px-0.5">
        {content.slice(range.start, range.end)}
      </span>
    );
    cursor = range.end;
  });

  if (cursor < content.length) segments.push(content.slice(cursor));
  return segments.length ? segments : " ";
}

function lineClassName(line: StructuredDiffLine) {
  if (line.type === "added") return "bg-emerald-500/10 text-emerald-950 dark:text-emerald-100";
  if (line.type === "removed") return "bg-red-500/10 text-red-950 dark:text-red-100";
  return "text-muted-foreground/90";
}

function marker(line: StructuredDiffLine) {
  if (line.type === "added") return "+";
  if (line.type === "removed") return "-";
  return " ";
}

function actionTitle(title: string | undefined, oldCode: string, newCode: string) {
  if (title) return title;
  if (!oldCode && newCode) return "Created Script";
  if (oldCode && !newCode) return "Deleted Script";
  return "Edited Script";
}

async function copyText(value: string) {
  await navigator.clipboard?.writeText(value);
}

export function DiffView({
  oldCode,
  newCode,
  fileName = "Script",
  language = "luau",
  className,
  title,
}: DiffViewProps) {
  const [fullDiff, setFullDiff] = useState(false);
  const diff = useMemo(
    () => buildStructuredDiff({
      beforeSource: oldCode,
      afterSource: newCode,
      path: fileName,
      language,
      contextLines: fullDiff ? MAX_FULL_DIFF_LINES : 3,
    }),
    [oldCode, newCode, fileName, language, fullDiff]
  );

  const totalRenderedLines = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  const canExpand = !fullDiff && totalRenderedLines < MAX_FULL_DIFF_LINES && (oldCode || newCode);
  const heading = actionTitle(title, oldCode, newCode);

  return (
    <div className={cn("overflow-hidden rounded-lg border bg-background text-sm", className)}>
      <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
        <FileCode className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{heading}</span>
            <span className="truncate text-xs text-muted-foreground">{diff.path}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs font-medium">
          <span className="inline-flex items-center gap-0.5 text-emerald-600"><Plus className="h-3 w-3" />{diff.stats.addedLines}</span>
          <span className="inline-flex items-center gap-0.5 text-red-600"><Minus className="h-3 w-3" />{diff.stats.removedLines}</span>
        </div>
        <button
          type="button"
          className="corpus-icon-btn h-7 w-7"
          aria-label="Copy after source"
          title="Copy after source"
          onClick={() => void copyText(newCode)}
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
        {canExpand && (
          <button
            type="button"
            className="corpus-icon-btn h-7 w-7"
            aria-label="Expand full diff"
            title="Expand full diff"
            onClick={() => setFullDiff(true)}
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="max-h-[520px] overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] leading-5">
          <tbody>
            {diff.hunks.map((hunk, hunkIndex) => (
              <FragmentedHunk key={`${hunk.oldStart}-${hunk.newStart}-${hunkIndex}`} hunkIndex={hunkIndex} lines={hunk.lines} oldStart={hunk.oldStart} newStart={hunk.newStart} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentedHunk({
  hunkIndex,
  oldStart,
  newStart,
  lines,
}: {
  hunkIndex: number;
  oldStart: number;
  newStart: number;
  lines: StructuredDiffLine[];
}) {
  return (
    <>
      {hunkIndex > 0 && (
        <tr className="bg-muted/30 text-muted-foreground">
          <td className="w-12 border-r px-2 py-1 text-right select-none">...</td>
          <td className="w-12 border-r px-2 py-1 text-right select-none">...</td>
          <td colSpan={2} className="px-2 py-1 text-xs">unchanged lines collapsed</td>
        </tr>
      )}
      <tr className="bg-muted/50 text-muted-foreground">
        <td colSpan={4} className="px-3 py-1 text-xs">
          @@ -{oldStart} +{newStart} @@
        </td>
      </tr>
      {lines.map((line, index) => (
        <tr key={`${line.oldLineNumber ?? ""}-${line.newLineNumber ?? ""}-${index}`} className={cn("border-b border-border/30 last:border-b-0", lineClassName(line))}>
          <td className="w-12 border-r border-border/40 px-2 py-0.5 text-right text-muted-foreground select-none">
            {line.oldLineNumber ?? ""}
          </td>
          <td className="w-12 border-r border-border/40 px-2 py-0.5 text-right text-muted-foreground select-none">
            {line.newLineNumber ?? ""}
          </td>
          <td className={cn("w-7 px-2 py-0.5 text-center font-semibold select-none", line.type === "added" && "text-emerald-600", line.type === "removed" && "text-red-600")}>
            {marker(line)}
          </td>
          <td className="min-w-[36rem] whitespace-pre px-2 py-0.5">
            {renderSegments(line.content, line.wordRanges)}
          </td>
        </tr>
      ))}
    </>
  );
}

interface DiffSummaryProps {
  additions: number;
  deletions: number;
  fileName?: string;
}

export function DiffSummary({ additions, deletions, fileName }: DiffSummaryProps) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <FileCode className="h-4 w-4 text-primary" />
      {fileName && <span className="truncate text-muted-foreground">{fileName}</span>}
      <span className="text-xs text-emerald-600">+{additions}</span>
      <span className="text-xs text-red-600">-{deletions}</span>
    </div>
  );
}
