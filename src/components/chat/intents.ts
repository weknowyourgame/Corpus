export type ChatChipAction = "toolbox" | "docs" | "run-code" | "plan";

const instructions: Record<ChatChipAction, string> = {
  toolbox: "Use roblox_toolbox_search to find relevant Creator Store assets, present thumbnail choices with roblox_ask_user, and do not insert an asset until I select one and approve its safety review.",
  docs: "Use the retrieved Roblox documentation context first and explain the relevant Roblox APIs or patterns before proposing changes.",
  "run-code": "This request may require high-risk Luau execution. Explain why it is needed and do not execute code in Studio without my explicit approval.",
  plan: "Produce a read-only implementation plan. Do not create, edit, insert, delete, or execute anything in Studio.",
};

export function buildChatSubmission(input: string, active: ChatChipAction[]) {
  const unique = [...new Set(active)];
  const context = unique.map((chip) => `[Mode: ${chip}] ${instructions[chip]}`).join("\n");
  return {
    message: context ? `${context}\n\n${input.trim()}` : input.trim(),
    mode: unique.includes("plan") ? "plan" as const : "execute" as const,
  };
}

export function classifyToolOutput(output: unknown) {
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const value = output as Record<string, unknown>;
    if (value.denied === true) {
      return { status: "denied" as const, error: String(value.reason ?? "Action was denied.") };
    }
    if (typeof value.error === "string") {
      return { status: "error" as const, error: value.error };
    }
  }
  return { status: "complete" as const };
}
