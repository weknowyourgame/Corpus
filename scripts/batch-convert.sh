#!/usr/bin/env bash
# Batch extracts all .rbxl files in ~/stud/games using Lune (zero interaction).
# Usage: bash scripts/batch-convert.sh

set -e

GAMES_DIR="$HOME/stud/games"
CONVERTED_DIR="$GAMES_DIR/converted"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if ! command -v lune &>/dev/null; then
  echo "Lune not found. Install with:"
  echo "  cargo install lune"
  echo "Or grab a binary from: https://github.com/lune-org/lune/releases"
  exit 1
fi

mkdir -p "$CONVERTED_DIR"

shopt -s nullglob
FILES=("$GAMES_DIR"/*.rbxl "$GAMES_DIR"/*.rbxlx)

if [ ${#FILES[@]} -eq 0 ]; then
  echo "No .rbxl or .rbxlx files found in $GAMES_DIR"
  exit 0
fi

echo "Found ${#FILES[@]} game(s) to extract"
echo ""

DONE=0
SKIPPED=0
FAILED=0

for file in "${FILES[@]}"; do
  name=$(basename "$file")
  name="${name%.rbxl}"
  name="${name%.rbxlx}"
  output="$CONVERTED_DIR/$name"

  if [ -f "$output/manifest.json" ]; then
    echo "  skip  $name (already extracted)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  printf "  %-40s" "$name"
  if lune run "$SCRIPT_DIR/extract-scripts.luau" "$file" "$output" 2>&1; then
    DONE=$((DONE + 1))
  else
    echo " FAILED"
    FAILED=$((FAILED + 1))
  fi
done

echo ""
echo "Done: $DONE extracted, $SKIPPED skipped, $FAILED failed"
echo ""
echo "Next steps:"
echo "  1. bun run scripts/generate-manifests.ts   — review slugs + get SQL inserts"
echo "  2. bun run scripts/upload-game.ts <slug> <niche>   — upload each game to R2"
