export interface DocChunk {
  id: string;
  service: string;
  topic: string;
  keywords: string[];
  content: string;
}

const DOCS: DocChunk[] = [
  {
    id: "remoteevent",
    service: "RemoteEvent",
    topic: "Client-server communication via RemoteEvent",
    keywords: ["remoteevent", "fireserver", "fireclient", "fireallclients", "onserverevent", "onclientevent", "remote", "network", "replication"],
    content: `RemoteEvent (place in ReplicatedStorage):
  Server→all clients: remote:FireAllClients(data)
  Server→one client:  remote:FireClient(player, data)
  Client→server:      remote:FireServer(data)
  Server receives:    remote.OnServerEvent:Connect(function(player, ...) end)
  Client receives:    remote.OnClientEvent:Connect(function(...) end)
  SECURITY: Validate ALL data server-side. Never trust client values for gameplay state.`,
  },
  {
    id: "remotefunction",
    service: "RemoteFunction",
    topic: "Client-server RPC with return value",
    keywords: ["remotefunction", "invokeserver", "invokeclient", "onserverinvoke", "onclientinvoke", "rpc", "yield"],
    content: `RemoteFunction (place in ReplicatedStorage):
  Client invokes server: local result = remote:InvokeServer(args)
  Server callback:       remote.OnServerInvoke = function(player, args) return value end
  WARNING: InvokeClient can yield indefinitely if client disconnects. Prefer RemoteEvent for fire-and-forget.`,
  },
  {
    id: "services",
    service: "Services",
    topic: "Core Roblox services and their containers",
    keywords: ["getservice", "players", "runservice", "replicatedstorage", "serverscriptservice", "serverstorage", "startergui", "starterplayer", "workspace"],
    content: `Common services (via game:GetService("Name")):
  Players          — player lifecycle; LocalPlayer available on client only
  RunService       — Heartbeat/Stepped/RenderStepped; IsServer()/IsClient()
  ReplicatedStorage — shared: accessible by both server and client scripts
  ServerScriptService — server-only scripts/modules (not replicated)
  ServerStorage    — server-only assets (not replicated)
  StarterGui       — UI templates, cloned to PlayerGui on join
  StarterPlayer.StarterPlayerScripts — LocalScripts run per player
  Workspace        — 3D world instances`,
  },
  {
    id: "task",
    service: "task",
    topic: "Modern task scheduling (use instead of deprecated wait/spawn/delay)",
    keywords: ["task.wait", "task.spawn", "task.delay", "task.defer", "task.cancel", "wait", "spawn", "delay", "schedule"],
    content: `task library (replaces deprecated globals):
  task.wait(t)        — yield current thread for t seconds
  task.spawn(fn, ...) — run fn in new thread immediately
  task.delay(t, fn)   — run fn after t seconds
  task.defer(fn, ...) — run fn on next frame
  task.cancel(thread) — cancel a deferred/delayed thread
  Avoid: wait(), spawn(), delay() — deprecated, prefer task equivalents`,
  },
  {
    id: "modulescript",
    service: "ModuleScript",
    topic: "ModuleScript require pattern and VM caching",
    keywords: ["require", "modulescript", "module", "return", "shared", "library", "cache"],
    content: `ModuleScript: returns a value when required.
  local M = require(game.ReplicatedStorage.MyModule)
  Caching: require() caches per VM — server and client each have separate caches.
  Server-only: place in ServerScriptService or ServerStorage.
  Shared: place in ReplicatedStorage.
  Standard pattern:
    local M = {}
    function M.DoThing() ... end
    return M`,
  },
  {
    id: "instance",
    service: "Instance",
    topic: "Instance hierarchy traversal and safe access",
    keywords: ["findfirstchild", "waitforchild", "getchildren", "getdescendants", "parent", "destroy", "clone", "instance"],
    content: `Instance traversal:
  :FindFirstChild("Name")     — returns child or nil, non-blocking
  :WaitForChild("Name", t)    — yields until child exists (use in LocalScripts)
  :GetChildren()              — direct children array
  :GetDescendants()           — all descendants recursively
  :Destroy()                  — removes instance and disconnects all connections
  :Clone()                    — deep copy, Parent=nil until assigned
  Common pitfall: use WaitForChild in LocalScripts for server-replicated objects`,
  },
  {
    id: "runservice",
    service: "RunService",
    topic: "RunService connections and cleanup",
    keywords: ["heartbeat", "stepped", "renderstepped", "connection", "disconnect", "loop", "runservice", "update"],
    content: `RunService connections (always :Disconnect() when object is destroyed):
  Heartbeat  — every frame, post-physics, server+client
  Stepped    — every frame, pre-physics, server+client
  RenderStepped — pre-render, client only
  Pattern: local conn = RunService.Heartbeat:Connect(function(dt) ... end)
  Cleanup:  conn:Disconnect()  (call in part.Destroying, player removal, etc.)
  RunService:IsServer() / :IsClient() — runtime side detection`,
  },
  {
    id: "player",
    service: "Players",
    topic: "Player join/leave and character lifecycle",
    keywords: ["playeradded", "playerremoving", "characteradded", "characterremoving", "humanoid", "localplayer", "character"],
    content: `Player lifecycle:
  Players.PlayerAdded:Connect(function(player) end)
  Players.PlayerRemoving:Connect(function(player) end)
  player.CharacterAdded:Connect(function(character) end)
  player.CharacterRemoving:Connect(function(character) end)
  Client: game.Players.LocalPlayer
  Character: player.Character or player.CharacterAdded:Wait()
  Humanoid: character:FindFirstChild("Humanoid")
  HumanoidRootPart: character:FindFirstChild("HumanoidRootPart")`,
  },
  {
    id: "datastore",
    service: "DataStoreService",
    topic: "DataStore read/write patterns (in-game Luau)",
    keywords: ["datastore", "datastoreservice", "getasync", "setasync", "updateasync", "removeasync", "persist", "save", "load"],
    content: `DataStoreService (server-side Luau only, API must be enabled in game settings):
  local ds = game:GetService("DataStoreService"):GetDataStore("StoreName")
  Read:   local v = ds:GetAsync(key)           -- returns nil if not found
  Write:  ds:SetAsync(key, value)
  Atomic: ds:UpdateAsync(key, function(old) return new end)
  Delete: ds:RemoveAsync(key)
  Always wrap in pcall — calls can fail. Rate: 60+numPlayers*10 req/min.
  From the Corpus agent: use roblox_datastore__ tools instead of in-game Luau.`,
  },
  {
    id: "luau-typing",
    service: "Luau",
    topic: "Luau strict mode and type annotations",
    keywords: ["strict", "--!strict", "type", "typeof", "annotation", "typed", "luau", "typecheck", "types"],
    content: `Luau strict mode (--!strict at file top):
  local x: number = 5
  local function f(x: number): string ... end
  Optional:  local x: number? = nil
  Union:     local x: string | number
  Type alias: type Point = {x: number, y: number}
  Cast:      local y = (value :: Type)
  Generics:  local function map<T, U>(arr: {T}, fn: (T) -> U): {U}
  Avoid 'any' — defeats type checking.`,
  },
  {
    id: "collectionservice",
    service: "CollectionService",
    topic: "CollectionService tags for grouping instances",
    keywords: ["collectionservice", "tag", "addtag", "removetag", "gettags", "gettagged", "hastag"],
    content: `CollectionService: group instances by string tags.
  local CS = game:GetService("CollectionService")
  CS:AddTag(instance, "TagName")
  CS:RemoveTag(instance, "TagName")
  CS:HasTag(instance, "TagName")
  CS:GetTagged("TagName")  -- returns array of all tagged instances
  CS.GetInstanceAddedSignal("TagName"):Connect(function(inst) end)
  Useful for: spawning points, interactables, zones, damageable objects.`,
  },
  {
    id: "tweenservice",
    service: "TweenService",
    topic: "TweenService for smooth property animation",
    keywords: ["tweenservice", "tween", "tweeninfo", "tweenstyle", "play", "cancel", "pause", "animate"],
    content: `TweenService: animate instance properties over time.
  local TS = game:GetService("TweenService")
  local info = TweenInfo.new(duration, Enum.EasingStyle.Quad, Enum.EasingDirection.Out)
  local tween = TS:Create(instance, info, {Property = targetValue})
  tween:Play()
  tween.Completed:Connect(function(state) end)
  tween:Cancel() / tween:Pause()
  Works on: number, CFrame, Vector3, Color3, UDim2, etc.`,
  },
];

export function retrieveDocs(query: string, limit = 3): DocChunk[] {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (!terms.length) return [];
  const scored = DOCS.map((doc) => {
    let score = 0;
    for (const term of terms) {
      if (doc.keywords.some((k) => k.includes(term) || term.includes(k))) score += 3;
      if (doc.topic.toLowerCase().includes(term)) score += 2;
      if (doc.content.toLowerCase().includes(term)) score += 1;
    }
    return { doc, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.doc);
}
