import { z } from "zod";
import { generateUtilityText, parseJsonFromText } from "./utility-llm.ts";

const suggestionsSchema = z.array(z.string().min(1).max(80)).min(1).max(3);

export async function generateSuggestions(
  lastText: string,
  toolNames: string[],
  signal: AbortSignal,
): Promise<string[]> {
  try {
    const text = await generateUtilityText({
      profileId: "summarizer",
      signal,
      temperature: 0.4,
      system: "Based on this Roblox Studio agent response, suggest 3 short follow-up actions. Output only a JSON array of strings. Max 8 words each.",
      user: JSON.stringify({
        lastText: lastText.slice(-6_000),
        toolNames: toolNames.slice(-30),
      }),
    });
    const parsed = suggestionsSchema.safeParse(parseJsonFromText<unknown>(text, []));
    return parsed.success ? parsed.data.slice(0, 3) : [];
  } catch {
    return [];
  }
}
