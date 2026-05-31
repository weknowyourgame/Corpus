--!strict
-- Extracts all Script/LocalScript/ModuleScript from an .rbxl file.
-- Usage: lune run scripts/extract-scripts <input.rbxl> <output-dir>
local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local process = require("@lune/process")

local inputFile: string = process.args[1]
local outputDir: string = process.args[2]

if not inputFile or not outputDir then
	print("Usage: lune run scripts/extract-scripts <input.rbxl> <output-dir>")
	process.exit(1)
end

local place = roblox.readPlaceFile(inputFile)

local function getPath(instance: Instance): string
	local parts: { string } = {}
	local current: Instance? = instance
	while current ~= nil and current.Parent ~= nil and current.Parent ~= place do
		table.insert(parts, 1, current.Name)
		current = current.Parent
	end
	if current and current.Parent == place then
		table.insert(parts, 1, current.Name)
	end
	return table.concat(parts, "/")
end

local function ensureDirs(path: string)
	local parts = string.split(path, "/")
	local built = ""
	for i, part in parts do
		built = if i == 1 then part else built .. "/" .. part
		if not fs.isDir(built) then
			fs.makeDir(built)
		end
	end
end

local manifest: { string } = {}
local count = 0

local function walk(parent: Instance)
	for _, child in parent:GetChildren() do
		local cn = child.ClassName
		if cn == "Script" or cn == "LocalScript" or cn == "ModuleScript" then
			local relPath = getPath(child)
			local ext = if cn == "LocalScript"
				then ".client.lua"
				elseif cn == "Script"
				then ".server.lua"
				else ".lua"

			local fileRel = "raw/" .. relPath .. ext
			local fileAbs = outputDir .. "/" .. fileRel
			local dir = string.match(fileAbs, "(.+)/[^/]+$")
			if dir then
				ensureDirs(dir)
			end

			local ok, source = pcall(function()
				return (child :: any).Source :: string
			end)
			if ok and source and source ~= "" then
				fs.writeFile(fileAbs, source)
				table.insert(manifest, fileRel)
				count += 1
			end
		end
		walk(child)
	end
end

if not fs.isDir(outputDir) then fs.makeDir(outputDir) end
if not fs.isDir(outputDir .. "/raw") then fs.makeDir(outputDir .. "/raw") end

walk(place)

local lines: { string } = {}
for _, p in manifest do
	table.insert(lines, string.format('  "%s"', p))
end
fs.writeFile(outputDir .. "/manifest.json", "[\n" .. table.concat(lines, ",\n") .. "\n]\n")

print(string.format("[extract] %s → %d scripts, manifest written", inputFile, count))
