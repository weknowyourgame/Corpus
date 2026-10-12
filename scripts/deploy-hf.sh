#!/usr/bin/env bash
# Deploy the Corpus bridge + UI to a free Hugging Face Docker Space.
#
#   HF_TOKEN=hf_xxx SECRETS_FILE=path/to/prod.env scripts/deploy-hf.sh
#
# SECRETS_FILE is a KEY=VALUE file (DATABASE_URL, OPENROUTER_API_KEY, CLOUDFLARE_*, ...).
set -euo pipefail

: "${HF_TOKEN:?set HF_TOKEN (write token from huggingface.co/settings/tokens)}"
: "${SECRETS_FILE:?set SECRETS_FILE to a KEY=VALUE env file}"
SPACE_NAME="${SPACE_NAME:-corpus}"
API=https://huggingface.co/api
AUTH=(-H "Authorization: Bearer $HF_TOKEN")

USER_NAME=$(curl -fsS "${AUTH[@]}" $API/whoami-v2 | python3 -c 'import sys,json;print(json.load(sys.stdin)["name"])')
REPO="$USER_NAME/$SPACE_NAME"
HOST="$(echo "$USER_NAME-$SPACE_NAME" | tr '[:upper:]_' '[:lower:]-').hf.space"
URL="https://$HOST"
echo "space: $REPO -> $URL"

curl -sS "${AUTH[@]}" -H 'content-type: application/json' $API/repos/create \
  -d "{\"type\":\"space\",\"name\":\"$SPACE_NAME\",\"sdk\":\"docker\",\"private\":false}" >/dev/null || true

set_secret() {
  python3 - "$1" "$2" <<'PY' | curl -fsS "${AUTH[@]}" -H 'content-type: application/json' -X POST "$API/spaces/$REPO/secrets" -d @- >/dev/null
import json,sys
print(json.dumps({"key":sys.argv[1],"value":sys.argv[2]}))
PY
}
while IFS='=' read -r k v; do
  [[ -z "$k" || "$k" == \#* ]] && continue
  set_secret "$k" "$v"
done < "$SECRETS_FILE"
set_secret GOOGLE_REDIRECT_URI "$URL/"
set_secret PORT 7860

WORK=$(mktemp -d)
git archive HEAD | tar -x -C "$WORK"
rm -rf "$WORK/RobloxLandingPage" "$WORK/open-game-eval" "$WORK/src-tauri" "$WORK/studio-rust-mcp-server" "$WORK/games"
find "$WORK" -type f -size +9M -delete
cat > "$WORK/README.md" <<README
---
title: Corpus
emoji: 🧱
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
---
Corpus - AI agent for Roblox Studio.
README
(
  cd "$WORK"
  git init -q -b main
  git add -A
  git -c user.name=corpus -c user.email=corpus@users.noreply.huggingface.co commit -q -m "Deploy Corpus"
  git push -q --force "https://$USER_NAME:$HF_TOKEN@huggingface.co/spaces/$REPO" main
)
rm -rf "$WORK"

echo "waiting for build..."
for i in $(seq 1 60); do
  stage=$(curl -fsS "${AUTH[@]}" "$API/spaces/$REPO/runtime" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("stage",""))')
  echo "  stage: $stage"
  [[ "$stage" == "RUNNING" ]] && break
  [[ "$stage" == *ERROR* ]] && { echo "build failed; see $URL logs"; exit 1; }
  sleep 20
done
curl -fsS "$URL/health" && echo
echo "APP_URL=$URL"
echo "Add this Authorized redirect URI in Google Cloud: $URL/"
