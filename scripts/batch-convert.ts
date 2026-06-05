/**
 * Batch converts all .rbxl files in ~/corpus/games/ to ~/corpus/games/converted/
 * Pure Bun TypeScript — no Lune, no external tools, no interaction needed.
 *
 * Usage: bun run scripts/batch-convert.ts
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── LZ4 block decompressor ────────────────────────────────────────────────────

function decompressLZ4(src: Buffer, dstSize: number): Buffer {
  const dst = Buffer.allocUnsafe(dstSize);
  let s = 0, d = 0;
  while (s < src.length) {
    const token = src[s++];
    let litLen = token >>> 4;
    if (litLen === 15) { let b: number; do { b = src[s++]; litLen += b; } while (b === 255); }
    src.copy(dst, d, s, s + litLen); s += litLen; d += litLen;
    if (s >= src.length) break;
    const offset = src[s] | (src[s + 1] << 8); s += 2;
    let matchLen = (token & 0xf) + 4;
    if ((token & 0xf) === 15) { let b: number; do { b = src[s++]; matchLen += b; } while (b === 255); }
    const mStart = d - offset;
    for (let i = 0; i < matchLen; i++) dst[d++] = dst[mStart + i];
  }
  return dst;
}

// ── Interleaved + zigzag + delta referent array decoder ──────────────────────

function decodeRefs(data: Buffer, count: number, off = 0): number[] {
  const out: number[] = new Array(count);
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const raw = (
      (data[off + i] << 24) |
      (data[off + count + i] << 16) |
      (data[off + 2 * count + i] << 8) |
      data[off + 3 * count + i]
    ) >>> 0;
    acc = (acc + (((raw >>> 1) ^ -(raw & 1)) | 0)) | 0;
    out[i] = acc;
  }
  return out;
}

// ── Length-prefixed UTF-8 string reader ──────────────────────────────────────

function readStr(buf: Buffer, pos: number): [string, number] {
  const len = buf.readUInt32LE(pos);
  return [buf.toString("utf8", pos + 4, pos + 4 + len), pos + 4 + len];
}

// ── Chunk reader ─────────────────────────────────────────────────────────────

type Chunk = { type: string; data: Buffer };

function readChunks(buf: Buffer): Chunk[] {
  let pos = 32; // skip 32-byte header
  const chunks: Chunk[] = [];
  while (pos < buf.length) {
    const type = buf.toString("ascii", pos, pos + 4); pos += 4;
    const compLen = buf.readUInt32LE(pos); pos += 4;
    const rawLen  = buf.readUInt32LE(pos); pos += 4;
    pos += 4; // reserved
    let data: Buffer;
    if (compLen === 0) { data = buf.slice(pos, pos + rawLen); pos += rawLen; }
    else { data = decompressLZ4(buf.slice(pos, pos + compLen), rawLen); pos += compLen; }
    chunks.push({ type, data });
    if (type === "END\0") break;
  }
  return chunks;
}

// ── .rbxl script extractor ───────────────────────────────────────────────────

const SCRIPT_CLASSES = new Set(["Script", "LocalScript", "ModuleScript"]);
const STRING_TYPE = 0x01;

function extractScripts(buf: Buffer): Map<string, string> {
  if (buf.toString("ascii", 0, 8) !== "<roblox!") throw new Error("Not a valid .rbxl file");

  const chunks = readChunks(buf);

  // INST: build typeId → { className, referents[] }
  const types = new Map<number, { cls: string; refs: number[] }>();
  const refToType = new Map<number, number>();

  for (const { type, data } of chunks) {
    if (type !== "INST") continue;
    let p = 0;
    const typeId = data.readUInt32LE(p); p += 4;
    const [cls, p2] = readStr(data, p); p = p2;
    p += 1; // is_service
    const count = data.readUInt32LE(p); p += 4;
    const refs = decodeRefs(data, count, p);
    types.set(typeId, { cls, refs });
    for (const r of refs) refToType.set(r, typeId);
  }

  // PROP: collect Name (all instances) and Source (script instances)
  const names   = new Map<number, string>();
  const sources = new Map<number, string>();

  for (const { type, data } of chunks) {
    if (type !== "PROP") continue;
    let p = 0;
    const typeId = data.readUInt32LE(p); p += 4;
    const [propName, p2] = readStr(data, p); p = p2;
    const propType = data[p]; p += 1;
    if (propType !== STRING_TYPE) continue;
    const inst = types.get(typeId);
    if (!inst) continue;
    const isScript = SCRIPT_CLASSES.has(inst.cls);
    if (propName !== "Name" && !(isScript && propName === "Source")) continue;

    for (const ref of inst.refs) {
      const [val, p3] = readStr(data, p); p = p3;
      if (propName === "Name") names.set(ref, val);
      else if (val.trim()) sources.set(ref, val);
    }
  }

  // PRNT: build child → parent map
  const parents = new Map<number, number>();

  for (const { type, data } of chunks) {
    if (type !== "PRNT") continue;
    let p = 1; // skip version byte
    const count = data.readUInt32LE(p); p += 4;
    const children  = decodeRefs(data, count, p);
    const parentArr = decodeRefs(data, count, p + count * 4);
    for (let i = 0; i < count; i++) parents.set(children[i], parentArr[i]);
    break;
  }

  // Build Roblox path from referent
  function buildPath(ref: number): string {
    const parts: string[] = [];
    let cur = ref;
    while (true) {
      const parent = parents.get(cur);
      if (parent === undefined || parent === -1) break;
      parts.unshift(names.get(cur) ?? `Instance_${cur}`);
      cur = parent;
    }
    return parts.join("/");
  }

  const result = new Map<string, string>();
  for (const [ref, source] of Array.from(sources)) {
    const typeId = refToType.get(ref);
    if (typeId === undefined) continue;
    const inst = types.get(typeId);
    if (!inst) continue;
    const path = buildPath(ref);
    if (!path) continue;
    const ext = inst.cls === "LocalScript" ? ".client.lua"
      : inst.cls === "Script" ? ".server.lua"
      : ".lua";
    result.set(`raw/${path}${ext}`, source);
  }
  return result;
}

// ── Batch runner ─────────────────────────────────────────────────────────────

const GAMES_DIR = join(homedir(), "corpus", "games");
const CONVERTED = join(GAMES_DIR, "converted");

const ensure = (p: string) => { if (!existsSync(p)) mkdirSync(p, { recursive: true }); };

ensure(CONVERTED);

const files = readdirSync(GAMES_DIR).filter((f) => f.endsWith(".rbxl"));

if (!files.length) {
  console.log(`No .rbxl files found in ${GAMES_DIR}`);
  process.exit(0);
}

console.log(`Found ${files.length} game(s)\n`);
let done = 0, skipped = 0, failed = 0;

for (const file of files) {
  const slug = file.replace(/\.rbxl$/, "");
  const outDir = join(CONVERTED, slug);
  const manifestPath = join(outDir, "manifest.json");

  if (existsSync(manifestPath)) {
    console.log(`  skip   ${slug}`);
    skipped++;
    continue;
  }

  try {
    const buf = readFileSync(join(GAMES_DIR, file));
    const scripts = extractScripts(buf);

    if (!scripts.size) {
      console.log(`  ⚠      ${slug}: no scripts found`);
      failed++;
      continue;
    }

    ensure(outDir);
    const manifest: string[] = [];

    for (const [relPath, source] of Array.from(scripts)) {
      const abs = join(outDir, relPath);
      ensure(dirname(abs));
      writeFileSync(abs, source, "utf8");
      manifest.push(relPath);
    }

    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`  ✓      ${slug}: ${scripts.size} scripts`);
    done++;
  } catch (err) {
    console.error(`  ✗      ${slug}: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

console.log(`\nDone: ${done} converted, ${skipped} skipped, ${failed} failed`);
if (done > 0) {
  console.log("\nNext:");
  console.log("  bun run scripts/generate-manifests.ts");
  console.log("  bun run scripts/upload-game.ts <slug> <niche>");
}
