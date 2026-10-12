/**
 * Prompt improver — delegates to the bridge server's /agent/improve endpoint.
 * No direct provider calls from the browser.
 */

import { bridgeUrl } from "@/lib/bridge/config";

export interface ImproveResult {
  improved: string;
  error?: string;
}

export async function improvePrompt(prompt: string): Promise<ImproveResult> {
  if (!prompt.trim()) return { improved: prompt, error: "Empty prompt" };
  try {
    const response = await fetch(bridgeUrl("/agent/improve-prompt"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!response.ok) return { improved: prompt, error: "Server error" };
    const data = await response.json() as { improved?: string; error?: string };
    return { improved: data.improved ?? prompt, error: data.error };
  } catch {
    return { improved: prompt, error: "Could not connect to bridge server" };
  }
}

export function canImprovePrompt(): boolean {
  return true;
}
