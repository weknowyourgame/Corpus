// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import { ScriptIndexer } from "./retrieval.ts";

describe("ScriptIndexer", () => {
  let indexer: ScriptIndexer;

  beforeEach(() => {
    indexer = new ScriptIndexer();
  });

  it("retrieves indexed script by path term", () => {
    indexer.index("s1", "game.ServerScriptService.Combat.DamageService", "local function ApplyDamage() end");
    const results = indexer.retrieve("s1", "DamageService");
    expect(results).toHaveLength(1);
    expect(results[0].path).toBe("game.ServerScriptService.Combat.DamageService");
  });

  it("retrieves script by symbol name with higher score than content match", () => {
    indexer.index("s1", "game.ServerScriptService.Weapons.WeaponCore", "local function FireWeapon() end\nlocal x = 1");
    indexer.index("s1", "game.ServerScriptService.Other.Misc", "-- FireWeapon is called here");
    const results = indexer.retrieve("s1", "FireWeapon", 2);
    // WeaponCore should score higher (symbol match > content match)
    expect(results[0].path).toBe("game.ServerScriptService.Weapons.WeaponCore");
  });

  it("infers run_side correctly from path and className", () => {
    indexer.index("s1", "game.StarterGui.HUD.HealthBar", "local hp = 100", "LocalScript");
    indexer.index("s1", "game.ServerScriptService.Main", "print('server')", "Script");
    indexer.index("s1", "game.ReplicatedStorage.Shared.Utils", "return {}", "ModuleScript");

    const results = indexer.retrieve("s1", "HealthBar HUD Main Utils", 3);
    const byPath = Object.fromEntries(results.map((r) => [r.path.split(".").pop()!, r.runSide]));
    expect(byPath["HealthBar"]).toBe("client");
    expect(byPath["Main"]).toBe("server");
    expect(byPath["Utils"]).toBe("shared");
  });

  it("isolates sessions — session1 results do not appear for session2", () => {
    indexer.index("session1", "game.ServerScriptService.Secret", "secret code");
    const results = indexer.retrieve("session2", "secret");
    expect(results).toHaveLength(0);
  });

  it("updates existing entry when re-indexed after mutation", () => {
    indexer.index("s1", "game.ServerScriptService.Main", "local v = 1");
    indexer.index("s1", "game.ServerScriptService.Main", "local v = 999");
    const results = indexer.retrieve("s1", "Main");
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("local v = 999");
  });

  it("returns empty when nothing indexed", () => {
    expect(indexer.retrieve("empty", "anything")).toHaveLength(0);
    expect(indexer.has("empty")).toBe(false);
    expect(indexer.size("empty")).toBe(0);
  });

  it("respects the limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      indexer.index("s1", `game.ServerScriptService.Script${i}`, `local x${i} = ${i}`);
    }
    const results = indexer.retrieve("s1", "x local", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("extracts symbols from function definitions", () => {
    indexer.index("s1", "game.ServerScriptService.Module", `
local function HandleDamage(player, amount) end
local function Respawn() end
local IsAlive = function() return true end
`);
    const results = indexer.retrieve("s1", "HandleDamage");
    expect(results[0].symbols).toContain("HandleDamage");
    expect(results[0].symbols).toContain("Respawn");
  });
});
