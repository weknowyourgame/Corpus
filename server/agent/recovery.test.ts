// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  isFailedToolResult,
  classifyFailure,
  isObligation,
  repairPropertyValue,
  toLuauAssignment,
  toLuauExpression,
  buildRecoveryCandidates,
  verificationFor,
} from "./recovery.ts";
import { normalizePath } from "./tools.ts";
import type { AgentToolCall } from "./types.ts";

describe("isFailedToolResult", () => {
  it("detects the failure shapes", () => {
    expect(isFailedToolResult({ success: false, error: "x" })).toBe(true);
    expect(isFailedToolResult({ error: "boom" })).toBe(true);
    expect(isFailedToolResult({ conflict: true })).toBe(true);
    expect(isFailedToolResult({ denied: true })).toBe(true);
    expect(isFailedToolResult({ cancelled: true })).toBe(true);
  });

  it("treats successful payloads as not failed", () => {
    expect(isFailedToolResult({ path: "game.Workspace.Part" })).toBe(false);
    expect(isFailedToolResult({ success: true })).toBe(false);
    expect(isFailedToolResult({ error: "" })).toBe(false);
    expect(isFailedToolResult("ok")).toBe(false);
    expect(isFailedToolResult(null)).toBe(false);
  });
});

describe("classifyFailure", () => {
  it("classifies typed Roblox value mismatches", () => {
    expect(classifyFailure({ success: false, error: "Color3 expected, got string" })).toBe("type_mismatch");
    expect(classifyFailure({ success: false, error: "Vector3 expected" })).toBe("type_mismatch");
    expect(classifyFailure({ success: false, error: "EnumItem expected, got string" })).toBe("type_mismatch");
  });

  it("classifies missing instances and decided outcomes", () => {
    expect(classifyFailure({ success: false, error: "Instance not found: game.X" })).toBe("not_found");
    expect(classifyFailure({ denied: true })).toBe("denied");
    expect(classifyFailure({ cancelled: true })).toBe("cancelled");
    expect(classifyFailure({ conflict: true })).toBe("conflict");
    expect(classifyFailure({ success: false, error: "weird" })).toBe("generic");
  });

  it("marks only outstanding work as an obligation", () => {
    expect(isObligation("type_mismatch")).toBe(true);
    expect(isObligation("not_found")).toBe(true);
    expect(isObligation("generic")).toBe(true);
    expect(isObligation("conflict")).toBe(true);
    expect(isObligation("denied")).toBe(false);
    expect(isObligation("cancelled")).toBe(false);
    expect(isObligation("none")).toBe(false);
  });
});

describe("repairPropertyValue", () => {
  it("converts Color3.fromRGB on a Color property to plugin format", () => {
    expect(repairPropertyValue("FogColor", "Color3.fromRGB(40, 40, 50)")).toBe("40, 40, 50");
    expect(repairPropertyValue("BackgroundColor3", "Color3.fromRGB(255,0,0)")).toBe("255, 0, 0");
  });

  it("converts Color3.new floats to 0-255 RGB", () => {
    expect(repairPropertyValue("BackgroundColor3", "Color3.new(1, 0, 0)")).toBe("255, 0, 0");
  });

  it("converts integer Vector3.new on non-color properties", () => {
    expect(repairPropertyValue("Size", "Vector3.new(1, 2, 3)")).toBe("1, 2, 3");
  });

  it("returns null for values the plugin cannot parse from a string", () => {
    // Color3 on a property without "Color" in the name → must use execute_luau
    expect(repairPropertyValue("Ambient", "Color3.fromRGB(40, 40, 50)")).toBeNull();
    // Float Vector3 → plugin only parses integer triples
    expect(repairPropertyValue("Size", "Vector3.new(1.5, 2, 3)")).toBeNull();
    // Unsupported types
    expect(repairPropertyValue("CFrame", "CFrame.new(0, 5, 0)")).toBeNull();
    expect(repairPropertyValue("Position", "UDim2.new(0, 10, 0, 20)")).toBeNull();
    expect(repairPropertyValue("Anchored", "true")).toBeNull();
  });
});

describe("toLuauAssignment", () => {
  it("builds a scoped assignment for the canonical example", () => {
    expect(toLuauAssignment("game.Lighting", "FogColor", "Color3.fromRGB(40, 40, 50)")).toBe(
      "game.Lighting.FogColor = Color3.fromRGB(40, 40, 50)",
    );
  });

  it("handles types the plugin string parser cannot", () => {
    expect(toLuauAssignment("game.Workspace.Part", "CFrame", "CFrame.new(0, 5, 0)")).toBe(
      "game.Workspace.Part.CFrame = CFrame.new(0, 5, 0)",
    );
    expect(toLuauAssignment("game.StarterGui.Gui.Frame", "Size", "UDim2.new(0, 100, 0, 50)")).toBe(
      "game.StarterGui.Gui.Frame.Size = UDim2.new(0, 100, 0, 50)",
    );
    expect(toLuauAssignment("game.Lighting", "Ambient", "Color3.fromRGB(40, 40, 50)")).toBe(
      "game.Lighting.Ambient = Color3.fromRGB(40, 40, 50)",
    );
  });

  it("normalizes bare and primitive values", () => {
    expect(toLuauExpression("FogColor", "40, 40, 50")).toBe("Color3.fromRGB(40, 40, 50)");
    expect(toLuauExpression("Size", "1, 2, 3")).toBe("Vector3.new(1, 2, 3)");
    expect(toLuauExpression("Anchored", "true")).toBe("true");
    expect(toLuauExpression("Transparency", "0.5")).toBe("0.5");
    expect(toLuauExpression("Material", "Enum.Material.Neon")).toBe("Enum.Material.Neon");
  });

  it("refuses to smuggle arbitrary code through the value", () => {
    expect(toLuauAssignment("game.Lighting", "FogColor", "Color3.fromRGB(1,2,3); game:Destroy()")).toBeNull();
    expect(toLuauExpression("FogColor", 'workspace:Destroy()')).toBeNull();
    expect(toLuauAssignment("game.Lighting", "FogColor; evil", "Color3.fromRGB(1,2,3)")).toBeNull();
  });
});

describe("buildRecoveryCandidates", () => {
  const call = (input: Record<string, unknown>): AgentToolCall => ({
    id: "c1",
    name: "mcp__roblox_studio__set_property",
    input,
  });

  it("offers a repaired retry then an execute_luau fallback for a type mismatch", () => {
    const candidates = buildRecoveryCandidates(
      call({ path: "game.Lighting", property: "FogColor", value: "Color3.fromRGB(40, 40, 50)" }),
      { success: false, error: "Color3 expected, got string" },
      normalizePath,
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      name: "mcp__roblox_studio__set_property",
      input: { value: "40, 40, 50" },
    });
    expect(candidates[1]).toMatchObject({
      name: "mcp__roblox_studio__execute_luau",
      input: { code: "game.Lighting.FogColor = Color3.fromRGB(40, 40, 50)" },
    });
  });

  it("offers only the execute_luau fallback when no plugin-native repair exists", () => {
    const candidates = buildRecoveryCandidates(
      call({ path: "game.Workspace.Part", property: "CFrame", value: "CFrame.new(0, 5, 0)" }),
      { success: false, error: "CFrame expected, got string" },
      normalizePath,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].name).toBe("mcp__roblox_studio__execute_luau");
  });

  it("returns nothing for decided outcomes", () => {
    expect(
      buildRecoveryCandidates(call({ path: "game", property: "X", value: "y" }), { denied: true }, normalizePath),
    ).toEqual([]);
  });

  it("repairs each operation in a bulk_set_property failure", () => {
    const candidates = buildRecoveryCandidates(
      {
        id: "b1",
        name: "mcp__roblox_studio__bulk_set_property",
        input: {
          operations: [
            { path: "game.Workspace.A", property: "Color", value: "Color3.fromRGB(1,2,3)" },
            { path: "game.Workspace.B", property: "Anchored", value: "true" },
          ],
        },
      },
      { success: false, error: "Color3 expected, got string" },
      normalizePath,
    );
    expect(candidates).toHaveLength(1);
    const ops = candidates[0].input.operations as Array<Record<string, unknown>>;
    expect(ops[0].value).toBe("1, 2, 3");
    expect(ops[1].value).toBe("true");
  });
});

describe("verificationFor", () => {
  it("reads the property back after a set_property", () => {
    expect(
      verificationFor(
        { id: "c", name: "mcp__roblox_studio__set_property", input: { path: "Lighting", property: "FogColor", value: "x" } },
        normalizePath,
      ),
    ).toEqual({ name: "mcp__roblox_studio__get_properties", input: { path: "game.Lighting" } });
  });

  it("reads the source back after a write_script", () => {
    expect(
      verificationFor(
        { id: "c", name: "mcp__roblox_studio__write_script", input: { path: "game.ServerScriptService.Main", source: "x" } },
        normalizePath,
      ),
    ).toEqual({ name: "mcp__roblox_studio__read_script", input: { path: "game.ServerScriptService.Main" } });
  });

  it("has no read-back for non-verifiable tools", () => {
    expect(
      verificationFor({ id: "c", name: "mcp__roblox_studio__delete_instance", input: { path: "game.X" } }, normalizePath),
    ).toBeNull();
  });
});
