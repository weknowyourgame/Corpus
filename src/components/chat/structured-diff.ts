import { diffWordsWithSpace, structuredPatch } from "diff";

export type DiffLineType = "context" | "added" | "removed";

export interface DiffRange {
  start: number;
  end: number;
}

export interface StructuredDiffLine {
  type: DiffLineType;
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  wordRanges?: DiffRange[];
}

export interface StructuredDiffHunk {
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  lines: StructuredDiffLine[];
}

export interface StructuredDiffStats {
  addedLines: number;
  removedLines: number;
  changedLines: number;
}

export interface StructuredDiff {
  path: string;
  language: string;
  hunks: StructuredDiffHunk[];
  stats: StructuredDiffStats;
  beforeSource: string;
  afterSource: string;
}

interface BuildStructuredDiffOptions {
  beforeSource?: string;
  afterSource?: string;
  path: string;
  language?: string;
  contextLines?: number;
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function lineCount(value: string) {
  if (!value) return 0;
  return value.endsWith("\n") ? value.slice(0, -1).split("\n").length : value.split("\n").length;
}

function rangesForChangedWords(oldLine: string, newLine: string): [DiffRange[], DiffRange[]] {
  const oldRanges: DiffRange[] = [];
  const newRanges: DiffRange[] = [];
  let oldOffset = 0;
  let newOffset = 0;

  for (const part of diffWordsWithSpace(oldLine, newLine)) {
    const text = part.value;
    if (part.removed) {
      oldRanges.push({ start: oldOffset, end: oldOffset + text.length });
      oldOffset += text.length;
    } else if (part.added) {
      newRanges.push({ start: newOffset, end: newOffset + text.length });
      newOffset += text.length;
    } else {
      oldOffset += text.length;
      newOffset += text.length;
    }
  }

  return [oldRanges, newRanges];
}

function annotateWordRanges(lines: StructuredDiffLine[]) {
  let index = 0;
  while (index < lines.length) {
    if (lines[index]?.type === "context") {
      index += 1;
      continue;
    }

    const removed: StructuredDiffLine[] = [];
    const added: StructuredDiffLine[] = [];
    while (index < lines.length && lines[index]?.type !== "context") {
      const line = lines[index];
      if (line?.type === "removed") removed.push(line);
      if (line?.type === "added") added.push(line);
      index += 1;
    }

    const pairs = Math.min(removed.length, added.length);
    for (let pair = 0; pair < pairs; pair += 1) {
      const removedLine = removed[pair]!;
      const addedLine = added[pair]!;
      const [oldRanges, newRanges] = rangesForChangedWords(removedLine.content, addedLine.content);
      removedLine.wordRanges = oldRanges;
      addedLine.wordRanges = newRanges;
    }
  }
}

export function buildStructuredDiff({
  beforeSource = "",
  afterSource = "",
  path,
  language = "luau",
  contextLines = 3,
}: BuildStructuredDiffOptions): StructuredDiff {
  const beforeLines = lineCount(beforeSource);
  const afterLines = lineCount(afterSource);
  const patch = structuredPatch(path, path, beforeSource, afterSource, "", "", { context: contextLines });
  let addedLines = 0;
  let removedLines = 0;
  let changedLines = 0;

  const hunks = patch.hunks.map((hunk) => {
    let oldLineNumber = hunk.oldStart;
    let newLineNumber = hunk.newStart;
    let hunkRemoved = 0;
    let hunkAdded = 0;
    const lines: StructuredDiffLine[] = [];

    for (const rawLine of hunk.lines) {
      if (rawLine === NO_NEWLINE_MARKER) continue;

      const marker = rawLine[0];
      const content = rawLine.slice(1);
      if (marker === "+") {
        lines.push({ type: "added", content, newLineNumber });
        newLineNumber += 1;
        addedLines += 1;
        hunkAdded += 1;
      } else if (marker === "-") {
        lines.push({ type: "removed", content, oldLineNumber });
        oldLineNumber += 1;
        removedLines += 1;
        hunkRemoved += 1;
      } else {
        lines.push({ type: "context", content, oldLineNumber, newLineNumber });
        oldLineNumber += 1;
        newLineNumber += 1;
      }
    }

    changedLines += Math.min(hunkRemoved, hunkAdded);
    annotateWordRanges(lines);

    return {
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      oldLines: hunk.oldLines,
      newLines: hunk.newLines,
      lines,
    };
  });

  if (!beforeSource && afterSource && hunks.length === 0 && afterLines > 0) {
    const lines = afterSource.split("\n").map((content, index) => ({
      type: "added" as const,
      content,
      newLineNumber: index + 1,
    }));
    addedLines = lines.length;
    hunks.push({ oldStart: 0, newStart: 1, oldLines: 0, newLines: afterLines, lines });
  }

  if (beforeSource && !afterSource && hunks.length === 0 && beforeLines > 0) {
    const lines = beforeSource.split("\n").map((content, index) => ({
      type: "removed" as const,
      content,
      oldLineNumber: index + 1,
    }));
    removedLines = lines.length;
    hunks.push({ oldStart: 1, newStart: 0, oldLines: beforeLines, newLines: 0, lines });
  }

  return {
    path,
    language,
    hunks,
    stats: { addedLines, removedLines, changedLines },
    beforeSource,
    afterSource,
  };
}
