# Stud AI Setup

## How it works

```
User picks tier (Free/Pro/Hyper/Super)
  → resolves to profile (planner-pro, coder-pro, …)
  → profile has a primary model + fallbacks
  → GatewayDriver → Cloudflare AI Gateway → OpenRouter → model
```

No model names are ever shown to the user. No API keys ever touch the browser.

---

## Keys — where to put them

Create a `.env` file at the project root:

```env
# REQUIRED — only thing you actually need
OPENROUTER_API_KEY=sk-or-...

# OPTIONAL — Cloudflare AI Gateway (analytics/caching/rate limiting)
# If not set, requests go directly to OpenRouter. That is fine.
# AI_GATEWAY_URL=https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}
# Only add this if your CF gateway has "Require authentication" turned on:
# CLOUDFLARE_API_TOKEN=
```

Then restart: `npm run dev`

> **Getting a 401 error?** Either remove `AI_GATEWAY_URL` to go direct to OpenRouter, or add `CLOUDFLARE_API_TOKEN` if your gateway requires auth.

---

## Getting the keys

**Cloudflare AI Gateway** (free tier available)
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → AI → AI Gateway
2. Create a gateway, copy the URL: `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}`
3. Get an API token: Profile → API Tokens → Create Token → "AI Gateway" permissions

**OpenRouter** (primary model provider)
1. Go to [openrouter.ai/keys](https://openrouter.ai/keys)
2. Create a key, fund your account (pay-as-you-go)

**Anthropic** (optional, for direct fallback)
- [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)

---

## Changing models

Open **one file**: `server/agent/ai-config.ts`

```ts
const profiles = {
  "planner-pro":   { primary: { model: "anthropic/claude-sonnet-4-5" } },
  "coder-pro":     { primary: { model: "anthropic/claude-sonnet-4-5" } },
  "embeddings":    { primary: { model: "workers-ai-bge" } },
  // ... etc
};
```

- Change a model → edit that line, restart the server.
- Add a fallback → add `fallbacks: ["google/gemini-2.5-pro"]` to any profile.
- Model IDs are OpenRouter format: `provider/model-name` — browse at [openrouter.ai/models](https://openrouter.ai/models)

---

## Tiers explained

| Tier  | Planner profile   | Coder profile   |
|-------|------------------|----------------|
| Free  | planner-free     | coder-free     |
| Pro   | planner-pro      | coder-pro      |
| Hyper | planner-hyper    | coder-hyper    |
| Super | planner-super    | coder-super    |

Users select a tier in the UI. What model that maps to is entirely internal.

---

## Profiles

| Profile        | Used for                         | Default model                    |
|----------------|----------------------------------|----------------------------------|
| planner-*      | Architecture, reasoning, plans   | claude-sonnet-4-5 / opus-4-1     |
| coder-*        | Code gen, edits, debugging       | claude-sonnet-4-5 / opus-4-1     |
| classifier     | Cheap routing decisions          | deepseek/deepseek-v3             |
| summarizer     | Conversation compression         | gemini-2.5-flash-lite            |
| title-generator| Chat titles                      | gemini-2.5-flash-lite            |
| embeddings     | RAG / semantic search            | Cloudflare Workers AI BGE        |

---

## Running

```bash
npm run dev          # web (5173) + bridge (3001)
npm run dev:bridge   # bridge only
npm run build        # production web build
```
