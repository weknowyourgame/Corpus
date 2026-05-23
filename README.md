# Stud

**The AI Agent for Roblox Studio** - Build games with AI that actually *does* things.

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Web App](https://img.shields.io/badge/Web-App-61DAFB)](https://vitejs.dev)
[![React](https://img.shields.io/badge/React-19-61DAFB)](https://react.dev)

Stud connects AI models (GPT-4, Claude, ChatGPT Plus/Pro) directly to Roblox Studio, enabling real-time manipulation of instances, scripts, and properties through natural language. Think **Cursor AI, but for Roblox development**.

## Why Stud?

Most AI coding tools are built for text files. Roblox Studio is different - it's a visual tree of instances, properties, and Luau scripts. Stud bridges this gap by giving AI direct access to your Studio session.

**Before Stud**: Copy code from ChatGPT → Paste into Studio → Debug → Repeat

**With Stud**: "Create a car that players can drive" → AI creates the model, scripts, and configures everything → Done

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
│  Stud Web   │◄────────────►│   Bridge    │◄───────────────►│   Studio    │
│   (React)   │              │   (Node)    │   100ms         │  (Plugin)   │
└─────────────┘              └─────────────┘                 └─────────────┘
      │
      │ Vercel AI SDK
      ▼
┌─────────────┐
│  AI Models  │
│ GPT/Claude  │
└─────────────┘
```

1. You open Stud in your browser and copy your **session code**
2. Paste the code into the Stud plugin in Roblox Studio and click Connect
3. You type a message in Stud — AI decides which tools to use
4. The bridge server queues requests; the plugin polls and executes them in Studio
5. Results flow back to the AI

*Roblox Studio can only make outgoing HTTP requests, so the plugin polls the bridge.*

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Roblox Studio](https://create.roblox.com/)

### Quick Start

```bash
git clone https://github.com/madebyshaurya/stud.git
cd stud
npm install
npm run dev
```

This starts:
- **Web app** at http://localhost:5173
- **Bridge server** at http://localhost:3001

### Connect Roblox Studio

1. Download the plugin from the web app (or copy `studio-plugin/stud-bridge.server.lua` to your Roblox Plugins folder)
2. Open Roblox Studio → enable **HTTP requests** in Game Settings → Security
3. Copy your **session code** from the Stud web app
4. Open the Stud plugin widget, paste the code, and click **Connect**

## Configuration

### AI Providers

| Provider | Setup | Models |
|----------|-------|--------|
| **Codex** | Sign in with ChatGPT Plus/Pro in Settings | GPT-5, o3, Codex models |
| **Claude** | Add Anthropic API key (`sk-ant-...`) | All Claude models from the API |
| **OpenRouter** | Add OpenRouter API key (`sk-or-...`) | 300+ models (Claude, GPT, Gemini, Llama, …) |

**Recommended**: If you have ChatGPT Plus/Pro, use the OAuth sign-in. No API key needed, and it works with GPT-4, GPT-5, o3, and more.

### Roblox Cloud API (Optional)

For DataStore access and game publishing:
1. Go to [Creator Hub > API Keys](https://create.roblox.com/dashboard/credentials)
2. Create a key with required permissions
3. Add to Settings in Stud

## AI Tools

### Instance Manipulation
| Tool | What it does |
|------|-------------|
| `roblox_create` | Create new instances (Parts, Models, Scripts, etc.) |
| `roblox_delete` | Remove instances from the game |
| `roblox_clone` | Duplicate instances |
| `roblox_move` | Reparent instances to new locations |
| `roblox_set_property` | Change any property (Position, Color, Name, etc.) |
| `roblox_get_properties` | Read all properties of an instance |
| `roblox_get_children` | List children (with recursive option) |
| `roblox_search` | Find instances by name or class |
| `roblox_get_selection` | Get what you have selected in Studio |

### Script Editing
| Tool | What it does |
|------|-------------|
| `roblox_get_script` | Read script source code |
| `roblox_set_script` | Replace entire script content |
| `roblox_edit_script` | Find/replace within scripts |
| `roblox_run_code` | Execute Luau code immediately |

### Bulk Operations
| Tool | What it does |
|------|-------------|
| `roblox_bulk_create` | Create many instances at once |
| `roblox_bulk_delete` | Delete multiple instances |
| `roblox_bulk_set_property` | Update properties across many instances |

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
npx tsc --noEmit
npm run build        # Production web build
npm run start:bridge # Run bridge in production
```

### Project Structure

```
stud/
├── src/                      # React frontend
│   ├── components/           # UI components (shadcn/ui + prompt-kit)
│   ├── lib/
│   │   ├── ai/              # AI providers and chat logic
│   │   └── roblox/          # Roblox tools (Zod schemas)
│   └── stores/              # Zustand state management
├── server/                  # Node.js bridge server
│   └── index.js
└── studio-plugin/           # Roblox Studio plugin
    └── stud-bridge.server.lua
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

- [ ] **Toolbox Search** - Visual asset picker from Creator Store
- [ ] **Auto-Planning** - AI plans before executing complex tasks
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

- Report bugs via [GitHub Issues](https://github.com/madebyshaurya/stud/issues)
- Feature requests welcome!
- Star the repo if you find it useful

## License

MIT License - see [LICENSE](./LICENSE) for details.

---

**Made for Roblox developers who want to build faster.**

*Not affiliated with Roblox Corporation.*
