# Roblox Corpus Indexing

This doc explains how to index purchased and open-source Roblox games for retrieval.

## 1. Roblox Project Formats

Common formats:

- `.rbxl`: binary Roblox place file.
- `.rbxlx`: XML Roblox place file.
- `.rbxm`: binary Roblox model file.
- `.rbxmx`: XML Roblox model file.
- Rojo project: filesystem tree plus `default.project.json`, with Luau files mapped into Roblox services/instances.

Scripts are stored as instances:

- `Script`
- `LocalScript`
- `ModuleScript`

Their code is stored in the script source property. In Rojo projects, this usually maps to `.lua` or `.luau` files.

## 2. Extracting Scripts With Full Game Tree Paths

Parsing strategy depends on source format:

- Rojo: parse `default.project.json`, walk mapped filesystem folders, resolve each `.lua`/`.luau` file into a Roblox instance path.
- `.rbxlx`/`.rbxmx`: parse XML, walk the instance tree, extract script instances and their source.
- `.rbxl`/`.rbxm`: use a Roblox-aware binary parser or open through Studio/plugin export path, then extract the DataModel.
- Live Studio: ask the Studio plugin/MCP server for the current tree and script sources.

For each script, store:

- full DataModel path, for example `game.ServerScriptService.Combat.DamageService`;
- class name;
- source text;
- parent/ancestor services;
- source file path if Rojo-backed;
- stable instance ID if available from the bridge.

## 3. Good Vs Bad Code Chunks

Good chunks:

- contain complete semantic units;
- include surrounding module/table context;
- include imports/requires;
- include remote names and service accesses;
- map to a full Roblox path;
- are small enough to fit with multiple neighbors;
- preserve line numbers or spans.

Bad chunks:

- fixed token windows with broken syntax;
- isolated helper body with no caller or module context;
- massive whole-framework files;
- duplicate boilerplate;
- generated minified code;
- code without source path;
- code from unknown/untrusted source mixed with project code.

## 4. Metadata For Accurate Retrieval

Extract:

- full instance path;
- script type;
- run side;
- service/container;
- symbols defined;
- symbols referenced;
- required module paths;
- RemoteEvents/RemoteFunctions used;
- Roblox services used;
- CollectionService tags;
- attributes;
- bindable events/functions;
- UI object names;
- datastores;
- physics/network ownership hints;
- public API comments;
- diagnostics;
- license/source;
- project/game genre;
- duplicate cluster;
- quality score.

For Roblox, run side is especially important. A server combat module and a client UI controller may both mention “damage,” but only one is valid for authoritative damage.

## 5. Duplicate And Near-Duplicate Handling

Purchased/open-source games often share frameworks, tutorials, admin scripts, and marketplace assets. Handle this explicitly:

- hash exact source for exact duplicates;
- normalize whitespace/comments for near-exact duplicates;
- use embeddings or AST-like signatures for near duplicates;
- cluster repeated framework code;
- keep one canonical copy per cluster;
- preserve per-game metadata, but avoid retrieving ten copies of the same chunk;
- downrank low-quality repeated marketplace boilerplate.

Duplicates are not always bad. A repeated pattern across high-quality games may be useful, but repeated vulnerable code should not become more authoritative just because it appears often.

## 6. Quality Ranking

Rank chunks by:

- source trust: current project > curated corpus > unknown marketplace dump;
- syntactic validity;
- diagnostics/lint cleanliness;
- clear module boundaries;
- meaningful names;
- security posture;
- modern Roblox APIs;
- low bug density;
- comments/docstrings that match behavior;
- usage frequency inside the game;
- recency/freshness;
- non-duplication;
- genre relevance.

Downrank:

- insecure remote handlers;
- client-authoritative currency/combat;
- deprecated APIs;
- scripts with obvious runtime errors;
- obfuscated/minified code;
- code with missing dependencies;
- copied tutorial boilerplate unrelated to the task.

## 7. Preventing Bad Code Pollution

Do not let the retrieval corpus act as an unquestioned teacher. Label source and quality in context. The model should know whether a chunk is:

- live project code,
- official Roblox docs,
- approved internal exemplar,
- open-source sample,
- low-trust purchased asset.

The system prompt should say: project code is authoritative for current architecture, official docs are authoritative for APIs, corpus examples are suggestions only.

