# Corpus

**The AI Agent for Roblox Studio** - Build games with AI that actually *does* things.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Web App](https://img.shields.io/badge/Web-App-61DAFB)](https://vitejs.dev)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev)

Corpus connects AI models (GPT-4, Claude, ChatGPT Plus/Pro) directly to Roblox Studio, enabling real-time manipulation of instances, scripts, and properties through natural language. Think **Cursor AI, but for Roblox development**.

## Why Corpus?

Most AI coding tools are built for text files. Roblox Studio is different - it's a visual tree of instances, properties, and Luau scripts. Corpus bridges this gap by giving AI direct access to your Studio session.

**Before Corpus**: Copy code from ChatGPT → Paste into Studio → Debug → Repeat

**With Corpus**: "Create a car that players can drive" → AI creates the model, scripts, and configures everything → Done

## Features

- **Direct Studio Control** - AI creates, modifies, and deletes instances in real-time
- **Script Editing** - Read, write, and edit Luau scripts with intelligent diff
- **15+ AI Tools** - Complete toolkit for any Roblox development task
- **Multi-Provider** - OpenAI API, Anthropic API, or ChatGPT Plus/Pro (no API key needed!)
- **Live Feedback** - See exactly what the AI is doing in your game
- **Undo Support** - Every AI change creates an undo waypoint
- **Modern UI** - Built with React 19 and [prompt-kit](https://prompt-kit.com)

## Demo

> *"Set up a basic obby with 5 platforms that get progressively harder"*

The AI will:
1. Create a folder structure for the obby
2. Generate 5 platforms with increasing gaps
3. Add spawn and finish checkpoints
4. Create a respawn script for falling players
5. Test the configuration

All while you watch it happen in real-time.

## How It Works

```
┌─────────────┐     HTTP      ┌─────────────┐     Polling     ┌─────────────┐
│  Corpus Web   │◄────────────►│ Bridge +    │◄───────────────►│   Studio    │
│   (React)   │  SSE / HTTP  │ Agent (Node)│   100ms         │  (Plugin)   │
└─────────────┘              └─────────────┘                 └─────────────┘
                                   │
                                   │ Vercel AI SDK / server credentials
                                   ▼
                              ┌─────────────┐
                              │  AI Models  │
                              │ GPT/Claude  │
                              └─────────────┘
```

1. You open Corpus in your browser and copy your **session code**
2. Paste the code into the Corpus plugin in Roblox Studio and click Connect
3. You type a message in Corpus; the server-owned agent streams run events to the UI
4. The server policy pauses mutations for approval and routes authorized `mcp__roblox_studio__*` operations through the Studio gateway
5. The compatible plugin transport polls and executes approved work; results return to the server loop

*Roblox Studio can only make outgoing HTTP requests, so the plugin polls the bridge.*

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Roblox Studio](https://create.roblox.com/)

### Quick Start

```bash
git clone https://github.com/madebyshaurya/corpus.git
cd corpus
npm install
export ANTHROPIC_API_KEY="sk-ant-..." # or OPENROUTER_API_KEY / CORPUS_CODEX_ACCESS_TOKEN
npm run dev
```

This starts:
- **Web app** at http://localhost:5173
- **Bridge server** at http://localhost:3001

### Connect Roblox Studio

1. Download the plugin from the web app (or copy `studio-plugin/corpus-bridge.server.lua` to your Roblox Plugins folder)
2. Open Roblox Studio → enable **HTTP requests** in Game Settings → Security
3. Copy your **session code** from the Corpus web app
4. Open the Corpus plugin widget, paste the code, and click **Connect**

## Configuration

### AI Providers

Phase 1 chat runs on the server. Configure credentials on the bridge process, never as `VITE_` browser variables:

| Provider | Setup | Models |
|----------|-------|--------|
| **Codex** | `CORPUS_CODEX_ACCESS_TOKEN` and optional `CORPUS_CODEX_ACCOUNT_ID` | Codex-compatible models |
| **Claude** | `ANTHROPIC_API_KEY` | Claude models |
| **OpenRouter** | `OPENROUTER_API_KEY` | OpenRouter tool-capable models |

The older Settings key/OAuth code remains in source during migration, but the active chat path does not execute with browser-stored credentials. See `docs/phase-1/server-agent-runtime.md` for the run protocol and local validation notes.

DataStore and publishing tools are not yet enabled in the server policy surface.

## AI Tools

### Instance Manipulation
| Tool | What it does |
|------|-------------|
| `mcp__roblox_studio__create_instance` | Create instances after approval |
| `mcp__roblox_studio__delete_instance` | Remove instances after high-risk approval |
| `mcp__roblox_studio__clone_instance` | Duplicate instances after approval |
| `mcp__roblox_studio__move_instance` | Reparent instances after high-risk approval |
| `mcp__roblox_studio__set_property` | Change one property after approval |
| `mcp__roblox_studio__get_properties` | Read supported instance properties |
| `mcp__roblox_studio__list_children` | List children, optionally recursively |
| `mcp__roblox_studio__search_instances` | Find instances by name or class |
| `mcp__roblox_studio__get_selection` | Get current Studio selection |

### Script Editing
| Tool | What it does |
|------|-------------|
| `mcp__roblox_studio__read_script` | Read script source code |
| `mcp__roblox_studio__write_script` | Replace script content after approval |
| `mcp__roblox_studio__edit_script` | Find/replace within scripts after approval |
| `mcp__roblox_studio__execute_luau` | Execute Luau only after high-risk approval |

### Bulk Operations
| Tool | What it does |
|------|-------------|
| `mcp__roblox_studio__bulk_create` | Create many instances after high-risk approval |
| `mcp__roblox_studio__bulk_delete` | Delete multiple instances after high-risk approval |
| `mcp__roblox_studio__bulk_set_property` | Update properties after high-risk approval |

### Creator Store
| Tool | What it does |
|------|-------------|
| `roblox_toolbox_search` | Server-side paginated/deduplicated search with thumbnails |
| `roblox_ask_user` | Displays interactive thumbnail choices in chat |
| `mcp__roblox_studio__insert_asset` | Inspects selected assets and inserts only after approval, with script stripping available |

## Example Prompts

**Creating things:**
> "Create a red neon part at position 0, 10, 0 that slowly rotates"

**Editing scripts:**
> "Add a debounce to the touch handler in game.Workspace.Coin.Script"

**Bulk operations:**
> "Find all parts named 'Coin' and make them spin using TweenService"

**Game systems:**
> "Set up a basic shop system with a GUI and DataStore for saving purchases"

**Debugging:**
> "Why isn't my script in ServerScriptService working? Read it and help me fix it"

## Development

```bash
npm run dev          # Web + bridge (recommended)
npm run dev:web      # Frontend only
npm run dev:bridge   # Bridge server only
npm run typecheck     # Frontend and server runtime type checks
npm run test:run
npm run build        # Production web build
npm run start:bridge # Run bridge in production
```

Implemented phase notes and the safe starter-world demo are in:

- [`docs/phase-1/server-agent-runtime.md`](docs/phase-1/server-agent-runtime.md)
- [`docs/phase-2/roblox-studio-mcp-gateway.md`](docs/phase-2/roblox-studio-mcp-gateway.md)
- [`docs/phase-3/permission-plan-audit.md`](docs/phase-3/permission-plan-audit.md)
- [`docs/phase-4/toolbox-demo.md`](docs/phase-4/toolbox-demo.md)

### Project Structure

```
corpus/
├── src/                      # React frontend
│   ├── components/           # UI components (shadcn/ui + prompt-kit)
│   ├── lib/
│   │   ├── ai/              # AI providers and chat logic
│   │   └── roblox/          # Roblox tools (Zod schemas)
│   └── stores/              # Zustand state management
├── server/                  # Node.js bridge server
│   └── index.js
└── studio-plugin/           # Roblox Studio plugin
    └── corpus-bridge.server.lua
```

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Frontend** | React 19, Vite 7, Tailwind CSS 4, shadcn/ui |
| **UI Components** | [prompt-kit](https://prompt-kit.com) |
| **AI** | Vercel AI SDK v6, OpenAI, Anthropic |
| **Bridge** | Node.js (Express) |
| **State** | Zustand |
| **Validation** | Zod |

## Roadmap

- [x] **Safe Toolbox Slice** - Server search, visual asset picker, inspection, and approved insertion
- [x] **Plan and Permissions** - Read-only plan runs and server-gated Studio mutations
- [ ] **@ Mentions** - Reference instances with `@game.Workspace.Part`
- [ ] **Diff View** - See script changes before/after
- [ ] **One-Click Games** - Templates for Obby, Tycoon, FPS, etc.
- [ ] **Roblox Docs RAG** - AI that knows the Roblox API deeply
- [ ] **Sub-Agents** - Parallel AI workers for complex tasks

## Contributing

Contributions are welcome!

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing`)
5. Open a Pull Request

See [CLAUDE.md](./CLAUDE.md) for code style guidelines and architecture details.

## Community

- Report bugs via [GitHub Issues](https://github.com/madebyshaurya/corpus/issues)
- Feature requests welcome!
- Star the repo if you find it useful

## License

MIT License - see [LICENSE](./LICENSE) for details.

---

**Made for Roblox developers who want to build faster.**

*Not affiliated with Roblox Corporation.*
