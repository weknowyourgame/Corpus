# Phase 4 Safe Toolbox Vertical Slice

Date: 2026-05-25

## Implemented Flow

1. The model calls `roblox_toolbox_search`, implemented server-side in `server/agent/toolbox.ts`.
2. Search expands Minecraft/voxel queries, requests Creator Store result pages, deduplicates IDs, ranks by available favorites, preserves the first query cursor, and attaches thumbnail URLs.
3. The model uses `roblox_ask_user` with the returned options. Existing `src/components/chat/QuestionPrompt.tsx` displays the thumbnail cards and sends the selected asset back into the server-owned run.
4. The model requests `mcp__roblox_studio__insert_asset` for the selected ID.
5. Before approval, `server/agent/tools.ts` invokes plugin `/asset/inspect`; `studio-plugin/stud-bridge.server.lua` loads the asset detached from the place and reports contained scripts and risky descendants.
6. `src/components/chat/ApprovalPrompt.tsx` shows a review disclosure for flagged script/risky descendant names and offers safe insertion without scripts when scripts are detected, allow once, or deny.
7. Only an approved request invokes `/asset/insert`; when selected, `stripScripts` destroys contained `LuaSourceContainer` descendants before the asset is parented into the target instance.

## Demo Path

Run the app with a server provider and connected Stud Studio plugin:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
npm run dev
```

In chat, enable **Plan** first and submit:

```text
Make a Minecraft-style starter world. Find suitable block terrain and tree assets, then propose a small starter layout.
```

Review the read-only proposal, then run an execution message without the Plan chip:

```text
Execute the starter-world plan. Search Creator Store assets, let me choose from thumbnail options, and insert only my approved choices safely.
```

Expected visible path: thumbnail selection card -> asset safety approval card -> **Insert without scripts** when needed -> approved Studio insertion with an undo waypoint and a final change summary.

## Tests and Limits

`server/agent/toolbox.test.ts` mocks Creator Store/thumbnail results, verifies expansion/deduplication/pagination output, and verifies inspected script-bearing insertion receives `stripScripts: true` only after approval. A live Creator Store fetch and live Studio insertion were intentionally not executed by automated validation because they would require network/model credentials and alter a creator's place.

The legacy browser file `src/lib/roblox/toolbox.ts` is preserved for migration compatibility, but the active agent chat trust path uses `server/agent/toolbox.ts`.
