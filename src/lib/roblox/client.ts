/**
 * HTTP Client for Roblox Studio communication via Bridge Server
 *
 * Web app posts requests; Studio plugin polls and responds.
 */

import { bridgeUrl } from "@/lib/bridge/config";

const TIMEOUT_MS = 15000;

export type StudioResponse<T> = { success: true; data: T } | { success: false; error: string };

const ENDPOINT_TO_TOOL: Record<string, string> = {
  "/script/get": "read_script",
  "/script/set": "write_script",
  "/script/edit": "edit_script",
  "/instance/children": "list_children",
  "/instance/properties": "get_properties",
  "/instance/set": "set_property",
  "/instance/create": "create_instance",
  "/instance/delete": "delete_instance",
  "/instance/clone": "clone_instance",
  "/instance/move": "move_instance",
  "/instance/search": "search_instances",
  "/selection/get": "get_selection",
  "/code/run": "execute_luau",
  "/instance/bulk-create": "bulk_create",
  "/instance/bulk-delete": "bulk_delete",
  "/instance/bulk-set": "bulk_set_property",
  "/asset/insert": "insert_asset",
};

const getStudioToken = (): string | null => {
  try {
    const raw = localStorage.getItem("stud-studio-token");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { token?: string | null } };
    return parsed.state?.token ?? null;
  } catch {
    return null;
  }
};

/**
 * Send a request to Roblox Studio via the bridge server
 */
export async function studioRequest<T>(endpoint: string, data?: object): Promise<StudioResponse<T>> {
  const token = getStudioToken();
  if (!token) return { success: false, error: "Generate a Studio token and connect the Stud plugin first" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(bridgeUrl("/studio/request"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tool: ENDPOINT_TO_TOOL[endpoint] ?? endpoint,
        arguments: data ?? {},
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        return { success: false, error: json.error || `Error ${response.status}` };
      } catch {
        return { success: false, error: `Studio error ${response.status}: ${text}` };
      }
    }

    const result = await response.json();
    if (result.error) {
      return { success: false, error: result.error };
    }
    return { success: true, data: result as T };
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      return { success: false, error: "Request timed out waiting for Studio response" };
    }
    return { success: false, error: `Failed to connect: ${e}` };
  } finally {
    clearTimeout(timeout);
  }
}

export type StudioTransportStatus = {
  connected: boolean;
  pluginConnected: boolean;
  /** Internal: whether an MCP server is also connected. Always false in current builds. */
  mcpConnected: boolean;
  /** Internal: which transport adapter is configured. */
  configuredTransport: "mcp" | "plugin" | "auto";
  preferredTransport: "studio_plugin" | "unknown";
  effectiveTransport: "studio_plugin" | "unknown";
  lastUsedTransport: "studio_plugin" | "unknown";
  mcpTools?: string[];
  mcpServer?: { name?: string; version?: string; title?: string } | null;
  mcpError?: string | null;
};

/**
 * Returns rich Studio status including which transport is currently active
 * for the bridge-to-Studio command path.
 */
export async function getStudioStatus(): Promise<StudioTransportStatus | null> {
  const token = getStudioToken();
  if (!token) return null;
  try {
    const response = await fetch(bridgeUrl("/studio/status"), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return (await response.json()) as StudioTransportStatus;
  } catch {
    return null;
  }
}

export async function isStudioConnected(): Promise<boolean> {
  return (await getStudioStatus())?.connected === true;
}

/**
 * Check if the bridge server is reachable
 */
export async function isBridgeRunning(): Promise<boolean> {
  try {
    const response = await fetch(bridgeUrl("/health"), {
      method: "GET",
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    try {
      const token = getStudioToken();
      if (!token) return false;
      const response = await fetch(bridgeUrl("/studio/status"), {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

export function notConnectedError(): string {
  return `Roblox Studio is not connected.

To use Roblox Studio tools:
1. Open Stud and generate a Studio token
2. Install the Stud plugin in Roblox Studio
3. Paste your Studio token in the plugin and click Connect
4. Enable HTTP requests in Game Settings → Security`;
}

export { getSessionId } from "@/lib/bridge/session";
