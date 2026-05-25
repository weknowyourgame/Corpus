import type { JsonValue } from "./types.ts";

type StudioRelay = (
  sessionId: string,
  path: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
  operationId: string,
) => Promise<JsonValue>;

export function parseAtMentions(message: string): string[] {
  const matches = message.match(/@([A-Za-z][A-Za-z0-9.]*)/g);
  if (!matches) return [];
  return [...new Set(matches.map((m) => m.slice(1)))];
}

export async function resolveAtMentions(
  paths: string[],
  relay: StudioRelay,
  sessionId: string,
  signal: AbortSignal,
): Promise<Array<{ path: string; summary: string }>> {
  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const result = await relay(sessionId, "/instance/children", { path: p }, signal, `ctx:${p}`);
      const children = Array.isArray(result) ? result : [];
      return { path: p, summary: `${children.length} children` };
    }),
  );
  return results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
}

export function buildContextBlock(
  studioConnected: boolean,
  selectedPaths: string[],
  mentions: Array<{ path: string; summary: string }>,
): string {
  const lines: string[] = ["[Live Studio Context]"];
  lines.push(`Connected: ${studioConnected}`);
  if (selectedPaths.length > 0) {
    lines.push(`Selected: ${selectedPaths.join(", ")}`);
  }
  for (const m of mentions) {
    lines.push(`@${m.path}: ${m.summary}`);
  }
  return lines.join("\n");
}
