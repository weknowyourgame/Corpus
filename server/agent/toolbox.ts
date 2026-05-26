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

export type ToolboxAsset = {
  id: number;
  name: string;
  description: string;
  creator: string;
  verifiedCreator: boolean;
  favoriteCount: number;
  upVotes: number;
  downVotes: number;
  hasScripts: boolean;
  scriptCount: number;
  thumbnailUrl: string | null;
  query: string;
};

export type ToolboxSearchResult = {
  query: string;
  expandedQueries: string[];
  count: number;
  totalResults: number;
  nextPageCursor: string | null;
  pageSize: number;
  results: ToolboxAsset[];
  selectionQuestion: {
    question: string;
    type: "single";
    options: Array<{ label: string; value: string; imageUrl: string | null; description: string }>;
  };
};

const typeIds = { Model: 10, Decal: 13, Audio: 3, Plugin: 38, MeshPart: 40 } as const;

const STOPWORD = new Set([
  "a", "an", "the", "and", "or", "for", "with", "of", "to", "in", "on", "by", "from",
  "please", "find", "search", "show", "me", "some", "model", "models", "asset", "assets",
  "free", "good", "best", "any", "give", "give me",
]);

const stripFiller = (raw: string) => raw
  .toLowerCase()
  .replace(/[^a-z0-9\s-]/g, " ")
  .split(/\s+/)
  .filter((token) => token && !STOPWORD.has(token))
  .join(" ")
  .trim();

const SYNONYMS: Array<{ test: RegExp; extras: string[] }> = [
  { test: /minecraft|voxel|block/i, extras: ["voxel terrain", "blocky tree", "low poly block house"] },
  { test: /\btree\b|forest|wood/i, extras: ["low poly tree", "stylized tree"] },
  { test: /terrain|ground|landscape/i, extras: ["voxel terrain", "low poly terrain"] },
  { test: /car|vehicle|drive/i, extras: ["low poly car", "vehicle model"] },
  { test: /house|building|home/i, extras: ["low poly house", "starter house"] },
  { test: /weapon|sword|gun/i, extras: ["sword model", "low poly weapon"] },
];

const expansions = (raw: string) => {
  const base = stripFiller(raw) || raw.trim();
  const queries = new Set<string>([base]);
  for (const synonym of SYNONYMS) {
    if (synonym.test.test(raw)) for (const extra of synonym.extras) queries.add(extra);
  }
  return Array.from(queries).slice(0, 4);
};

const STANDARD_HEADERS = {
  accept: "application/json",
  "user-agent": "Stud/1.0 (+https://stud.dev)",
};

const fetchJson = async <T>(fetcher: Fetcher, url: string, signal: AbortSignal): Promise<T | null> => {
  const response = await fetcher(url, { signal, headers: STANDARD_HEADERS });
  if (!response.ok) return null;
  return (await response.json()) as T;
};

type SearchResponse = {
  data?: Array<{ id: number }>;
  nextPageCursor?: string | null;
  totalResults?: number;
};

type DetailsResponse = {
  data?: Array<{
    asset?: {
      id?: number;
      name?: string;
      description?: string;
      hasScripts?: boolean;
      modelTechnicalDetails?: { instanceCounts?: { script?: number } };
    };
    creator?: { name?: string; isVerifiedCreator?: boolean };
    voting?: { upVotes?: number; downVotes?: number };
  }>;
};

type ThumbnailResponse = {
  data?: Array<{ targetId: number; state?: string; imageUrl?: string }>;
};

export class ToolboxService {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async search(raw: Record<string, unknown>, signal: AbortSignal): Promise<JsonValue> {
    const input = toolboxSearchSchema.parse(raw);
    const queries = input.expand ? expansions(input.query) : [input.query];

    const groups = await Promise.all(queries.map((query, index) => this.searchIds(
      query,
      input.category,
      input.limit,
      index === 0 ? input.cursor : undefined,
      signal,
    )));

    const seen = new Set<number>();
    const order: Array<{ id: number; query: string }> = [];
    for (const group of groups) {
      for (const id of group.ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        order.push({ id, query: group.query });
      }
    }

    const limited = order.slice(0, input.limit);
    const ids = limited.map((item) => item.id);
    const [details, thumbnails] = await Promise.all([
      this.batchDetails(ids, signal),
      this.thumbnails(ids, signal),
    ]);

    const results: ToolboxAsset[] = limited.map((item) => {
      const detail = details.get(item.id);
      return {
        id: item.id,
        name: detail?.name ?? `Asset ${item.id}`,
        description: detail?.description ?? "",
        creator: detail?.creator ?? "Unknown",
        verifiedCreator: detail?.verifiedCreator ?? false,
        favoriteCount: detail?.favoriteCount ?? 0,
        upVotes: detail?.upVotes ?? 0,
        downVotes: detail?.downVotes ?? 0,
        hasScripts: detail?.hasScripts ?? false,
        scriptCount: detail?.scriptCount ?? 0,
        thumbnailUrl: thumbnails.get(item.id) ?? null,
        query: item.query,
      };
    });

    results.sort((left, right) => (right.upVotes - right.downVotes) - (left.upVotes - left.downVotes));

    const nextPageCursor = groups[0]?.nextPageCursor ?? null;
    const totalResults = groups[0]?.totalResults ?? results.length;
    const options: ToolboxSearchResult["selectionQuestion"]["options"] = results.map((asset) => ({
      label: asset.name,
      value: String(asset.id),
      imageUrl: asset.thumbnailUrl,
      description: `${asset.creator}${asset.verifiedCreator ? " (verified)" : ""} | ${asset.upVotes} upvotes${asset.hasScripts ? " | contains scripts" : ""}`,
    }));
    if (nextPageCursor) {
      options.push({
        label: "Load more results",
        value: "__load_more__",
        imageUrl: null,
        description: `Fetch the next ${input.limit} matches`,
      });
    }
    options.push({
      label: "Search again with a different query",
      value: "__search_again__",
      imageUrl: null,
      description: "Pick a refined keyword and run a fresh search",
    });

    const question = results.length
      ? "Which Creator Store asset should I prepare for safe insertion?"
      : "No Creator Store matches were found. Would you like to refine the search?";

    const payload: ToolboxSearchResult = {
      query: input.query,
      expandedQueries: queries,
      count: results.length,
      totalResults,
      nextPageCursor,
      pageSize: input.limit,
      results,
      selectionQuestion: {
        question,
        type: "single",
        options,
      },
    };
    return payload as unknown as JsonValue;
  }

  private async searchIds(
    query: string,
    category: keyof typeof typeIds,
    limit: number,
    cursor: string | undefined,
    signal: AbortSignal,
  ): Promise<{ ids: number[]; nextPageCursor: string | null; totalResults: number; query: string }> {
    const typeId = typeIds[category];
    const params = new URLSearchParams({
      category,
      keyword: query,
      sortType: "0",
      limit: String(limit),
    });
    if (cursor) params.set("cursor", cursor);
    const url = `https://apis.roblox.com/toolbox-service/v1/marketplace/${typeId}?${params}`;
    const body = await fetchJson<SearchResponse>(this.fetcher, url, signal);
    if (!body) throw new Error("Creator Store search failed. Roblox toolbox-service returned a non-OK response.");
    return {
      ids: (body.data ?? []).map((item) => Number(item.id)).filter((id) => Number.isFinite(id)),
      nextPageCursor: body.nextPageCursor ?? null,
      totalResults: body.totalResults ?? (body.data?.length ?? 0),
      query,
    };
  }

  private async batchDetails(ids: number[], signal: AbortSignal) {
    const out = new Map<number, {
      name: string;
      description: string;
      creator: string;
      verifiedCreator: boolean;
      favoriteCount: number;
      upVotes: number;
      downVotes: number;
      hasScripts: boolean;
      scriptCount: number;
    }>();
    if (!ids.length) return out;
    const params = new URLSearchParams({ assetIds: ids.join(",") });
    const url = `https://apis.roblox.com/toolbox-service/v1/items/details?${params}`;
    const body = await fetchJson<DetailsResponse>(this.fetcher, url, signal);
    for (const item of body?.data ?? []) {
      const id = Number(item.asset?.id);
      if (!Number.isFinite(id)) continue;
      const scripts = Number(item.asset?.modelTechnicalDetails?.instanceCounts?.script ?? 0);
      out.set(id, {
        name: item.asset?.name ?? `Asset ${id}`,
        description: item.asset?.description ?? "",
        creator: item.creator?.name ?? "Unknown",
        verifiedCreator: Boolean(item.creator?.isVerifiedCreator),
        favoriteCount: Number(item.voting?.upVotes ?? 0),
        upVotes: Number(item.voting?.upVotes ?? 0),
        downVotes: Number(item.voting?.downVotes ?? 0),
        hasScripts: Boolean(item.asset?.hasScripts ?? scripts > 0),
        scriptCount: scripts,
      });
    }
    return out;
  }

  private async thumbnails(ids: number[], signal: AbortSignal) {
    const out = new Map<number, string>();
    if (!ids.length) return out;
    const params = new URLSearchParams({
      assetIds: ids.join(","),
      size: "150x150",
      format: "Png",
      isCircular: "false",
    });
    const body = await fetchJson<ThumbnailResponse>(this.fetcher, `https://thumbnails.roblox.com/v1/assets?${params}`, signal);
    for (const item of body?.data ?? []) {
      if (item.imageUrl && (!item.state || item.state === "Completed")) {
        out.set(item.targetId, item.imageUrl);
      }
    }
    return out;
  }
}
