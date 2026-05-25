import { z } from "zod";
import type { JsonValue } from "./types.ts";

export const toolboxSearchSchema = z.object({
  query: z.string().min(1),
  category: z.enum(["Model", "Decal", "Audio", "Plugin", "MeshPart"]).default("Model"),
  limit: z.number().int().min(1).max(30).default(10),
  cursor: z.string().optional(),
  expand: z.boolean().default(true),
});

type Fetcher = typeof fetch;
type Asset = {
  id: number;
  name: string;
  description: string;
  creator: string;
  favoriteCount: number;
  thumbnailUrl: string | null;
  query: string;
};

const typeIds = { Model: 10, Decal: 13, Audio: 3, Plugin: 38, MeshPart: 40 };

const expansions = (query: string) => {
  const base = query.trim();
  const related = /minecraft|voxel|block/i.test(base)
    ? ["voxel terrain", "block tree", "low poly block house"]
    : [];
  return [...new Set([base, ...related])].slice(0, 4);
};

export class ToolboxService {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async search(raw: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
    const input = toolboxSearchSchema.parse(raw);
    const queries = input.expand ? expansions(input.query) : [input.query];
    const groups = await Promise.all(queries.map((query, index) => this.searchQuery(
      query,
      input.category,
      input.limit,
      index === 0 ? input.cursor : undefined,
      signal,
    )));
    const unique = new Map<number, Omit<Asset, "thumbnailUrl">>();
    for (const group of groups) {
      for (const item of group.assets) {
        if (!unique.has(item.id)) unique.set(item.id, item);
      }
    }
    const ranked = [...unique.values()]
      .sort((left, right) => right.favoriteCount - left.favoriteCount)
      .slice(0, input.limit);
    const thumbnails = await this.thumbnails(ranked.map((item) => item.id), signal);
    const results: Asset[] = ranked.map((item) => ({ ...item, thumbnailUrl: thumbnails.get(item.id) ?? null }));
    return {
      query: input.query,
      expandedQueries: queries,
      count: results.length,
      nextPageCursor: groups[0]?.nextPageCursor ?? null,
      results,
      selectionQuestion: {
        question: "Which Creator Store asset should I prepare for safe insertion?",
        type: "single",
        options: results.map((asset) => ({
          label: asset.name,
          value: String(asset.id),
          imageUrl: asset.thumbnailUrl,
          description: `${asset.creator} | ${asset.favoriteCount} favorites`,
        })),
      },
    };
  }

  private async searchQuery(
    query: string,
    category: keyof typeof typeIds,
    limit: number,
    cursor: string | undefined,
    signal: AbortSignal,
  ) {
    const params = new URLSearchParams({
      Category: "1",
      Keyword: query,
      AssetType: String(typeIds[category]),
      Limit: String(limit),
      SortType: "0",
      SortAggregation: "3",
      SortOrder: "2",
      IncludeNotForSale: "false",
    });
    if (cursor) params.set("Cursor", cursor);
    const response = await this.fetcher(`https://catalog.roblox.com/v1/search/items/details?${params}`, { signal });
    if (!response.ok) throw new Error(`Creator Store search failed: ${response.status}`);
    const body = await response.json() as {
      data?: Array<{
        id: number;
        name?: string;
        description?: string;
        creatorName?: string;
        favoriteCount?: number;
      }>;
      nextPageCursor?: string;
    };
    return {
      assets: (body.data ?? []).map((item) => ({
        id: Number(item.id),
        name: item.name ?? `Asset ${item.id}`,
        description: item.description ?? "",
        creator: item.creatorName ?? "Unknown",
        favoriteCount: item.favoriteCount ?? 0,
        query,
      })),
      nextPageCursor: body.nextPageCursor,
    };
  }

  private async thumbnails(ids: number[], signal: AbortSignal) {
    if (!ids.length) return new Map<number, string>();
    const params = new URLSearchParams({
      assetIds: ids.join(","),
      size: "150x150",
      format: "Png",
      isCircular: "false",
    });
    const response = await this.fetcher(`https://thumbnails.roblox.com/v1/assets?${params}`, { signal });
    if (!response.ok) return new Map<number, string>();
    const body = await response.json() as { data?: Array<{ targetId: number; imageUrl: string; state?: string }> };
    return new Map((body.data ?? [])
      .filter((item) => !item.state || item.state === "Completed")
      .map((item) => [item.targetId, item.imageUrl]));
  }
}
