"use client";

/* eslint-disable @next/next/no-img-element */

import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  Blocks,
  Box,
  ChevronRight,
  Code,
  Database,
  Eye,
  FileSearch,
  History,
  Layers,
  Lock,
  Plug,
  Search,
  Settings,
  Shield,
  Terminal,
  TriangleAlert,
  Wrench,
} from "lucide-react";

const logo = "/stud/assets/logo_transparent_bg.png";

function rowStyle(index: number) {
  return {
    "--row": index,
    "--row-delay": `${index * 85}ms`,
  } as CSSProperties;
}

const featureTabs = [
  {
    label: "AI Assistant",
    icon: Terminal,
    title: "Stud Terminal",
    body: "Ask Stud to read your world, edit code, run checks, and explain each step before it touches anything.",
    mode: "assistant",
  },
  {
    label: "Roblox Studio",
    icon: Blocks,
    title: "Studio Tools",
    body: "Search assets, edit instances, and pipe Roblox Studio work through one focused terminal interface.",
    mode: "studio",
  },
  {
    label: "Smart Tools",
    icon: Wrench,
    title: "Smart Tools",
    body: "Route jobs through purpose-built tools for scripts, DataStores, files, shell commands, and project context.",
    mode: "smart",
  },
  {
    label: "Permission System",
    icon: Shield,
    title: "Permissions",
    body: "Approve the exact file writes and Studio changes you want, one action at a time or by rule.",
    mode: "permissions",
  },
  {
    label: "Open Source",
    icon: Code,
    note: "Community Driven",
    title: "Open Source",
    body: "Inspect the workflow, customize the agent, and extend Stud with your own Roblox tools.",
    mode: "source",
  },
];

const toolTabs = [
  {
    label: "Read & Write",
    icon: FileSearch,
    title: "Read & Write",
    body: "Read any file, write new code, and make precise edits with full context awareness.",
    rows: [
      ["→ Read src/server/PlayerData.lua", "847 lines"],
      ["→ Read src/shared/Config.lua", "124 lines"],
      ["← Write src/server/DataManager.lua", "256 lines"],
      ["~ Editing file...", ""],
    ],
    bg: "/stud/assets/cliff.png",
  },
  {
    label: "Glob & Grep",
    icon: Search,
    title: "Glob & Grep",
    body: "Find scripts, assets, symbols, and patterns across a project without losing the thread.",
    rows: [
      ["$ rg DataStore src/", "18 matches"],
      ["$ find src -name '*.lua'", "42 files"],
      ["→ Open server/DataManager.lua", "ready"],
      ["~ Searching workspace...", ""],
    ],
    bg: "/stud/assets/redwoods-2.png",
  },
  {
    label: "Bash Execution",
    icon: Terminal,
    title: "Bash Execution",
    body: "Run any shell command with intelligent output handling and permission controls.",
    rows: [
      ["$ rojo build -o game.rbxl", "exit 0"],
      ["$ selene src/", "0 warnings"],
      ["$ npm run build", "exit 0"],
      ["~ Running...", ""],
    ],
    bg: "/stud/assets/cliff.png",
  },
  {
    label: "Subagent Delegation",
    icon: Layers,
    title: "Subagent Delegation",
    body: "Split complex Roblox work into background agents that report back with focused patches.",
    rows: [
      ["agent: balance combat tuning", "working"],
      ["agent: audit permissions", "done"],
      ["agent: write test plan", "queued"],
      ["~ Coordinating tasks...", ""],
    ],
    bg: "/stud/assets/redwoods-dark.png",
  },
];

const robloxTools = [
  {
    title: "Script Editing",
    body: "Read, write, and edit Luau scripts directly in Roblox Studio instances.",
    icon: Code,
    mode: "script",
  },
  {
    title: "Instance Manipulation",
    body: "Create, move, delete, and modify any instance in the game hierarchy.",
    icon: Box,
    mode: "instance",
  },
  {
    title: "DataStore Access",
    body: "Query and update DataStores for testing and debugging player data.",
    icon: Database,
    mode: "datastore",
  },
  {
    title: "Toolbox Search",
    body: "Find and insert models, plugins, and assets from the Roblox Toolbox.",
    icon: Search,
    mode: "toolbox",
  },
];

const capabilities = [
  {
    title: "LSP Integration",
    body: "Full language server support for intelligent code navigation and diagnostics.",
    icon: Code,
  },
  {
    title: "MCP Protocol",
    body: "Extensible Model Context Protocol support for custom tool integrations.",
    icon: Plug,
  },
  {
    title: "Session Management",
    body: "Resume sessions, track token usage, and manage conversation history.",
    icon: History,
  },
  {
    title: "Subagent System",
    body: "Delegate complex tasks to background agents that work in parallel.",
    icon: Layers,
  },
  {
    title: "Smart File Handling",
    body: "Glob patterns, regex search, and intelligent file reading with context limits.",
    icon: FileSearch,
  },
  {
    title: "Terminal Native",
    body: "A beautiful TUI that feels at home in your terminal workflow.",
    icon: Terminal,
  },
];

const permissionCards = [
  {
    title: "Granular Permissions",
    body: "Approve individual actions or grant session-wide access per tool type.",
    icon: Lock,
  },
  {
    title: "Full Transparency",
    body: "See exactly what Stud will do before any action is taken, including full diffs.",
    icon: Eye,
  },
  {
    title: "Deny by Default",
    body: "Sensitive operations like file writes and bash commands require explicit approval.",
    icon: TriangleAlert,
  },
  {
    title: "Configurable Policies",
    body: "Set up permission rules and agent configurations that match your workflow.",
    icon: Settings,
    active: true,
  },
];

const launchDocuments = [
  {
    title: "Studio Bridge Setup",
    meta: "Roblox Studio · Session pairing",
    body: "Install the plugin, connect your session code, and keep HTTP access visible before any agent run starts.",
    tag: "Required",
  },
  {
    title: "Place Audit",
    meta: "Workspace · Scripts · Services",
    body: "Stud reads the scene tree, open scripts, selected instances, and MCP routes before proposing changes.",
    tag: "Context",
  },
  {
    title: "Permission Log",
    meta: "Approvals · Diffs · Rollback",
    body: "Every risky Studio mutation stays attached to a human decision, with the exact scope preserved.",
    tag: "Safety",
  },
];

const launchTasks = [
  ["Task running", "Map current Workspace"],
  ["Approval needed", "Insert toolbox asset"],
  ["Task completed", "Patch ServerScriptService"],
  ["Task queued", "Generate Studio checklist"],
];

const resourcePills = ["MCP", "Studio Plugin", "Toolbox", "DataStores"];

const workflowModes = [
  {
    label: "Roblox",
    text: "AI coding assistant with deep Roblox Studio integration. Edit scripts, manipulate instances, and query DataStores. All from your terminal.",
    rows: [
      ["◆ Get Children \"game.Workspace\"", "47 instances"],
      ["◆ Get Script \"ServerScriptService.Main\"", "source retrieved"],
      ["◆ Edit Script", "+18 -4 lines"],
      ["~ Inserting asset...", ""],
    ],
  },
  {
    label: "General",
    text: "Read files, run commands, make edits, and keep a complete session trail while you move through normal development work.",
    rows: [
      ["◆ Read package.json", "dependencies mapped"],
      ["◆ Search \"auth middleware\"", "12 matches"],
      ["◆ Update config", "+6 -2 lines"],
      ["~ Running checks...", ""],
    ],
  },
  {
    label: "Scripts",
    text: "Generate Luau, patch existing scripts, and inspect diagnostics with a workflow that stays close to Studio.",
    rows: [
      ["◆ Read Script \"CombatController\"", "216 lines"],
      ["◆ Find \"damageMultiplier\"", "3 matches"],
      ["◆ Edit Script", "+24 -9 lines"],
      ["~ Validating Luau...", ""],
    ],
  },
];

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

function StudLogo({ large = false }: { large?: boolean }) {
  return (
    <span className="stud-logo">
      <img src={logo} alt="Stud" className={large ? "stud-logo-img-lg" : ""} />
      <span>STUD</span>
    </span>
  );
}

function HeroFlowField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });

    if (!canvas || !context) {
      return;
    }

    type FlowParticle = {
      x: number;
      y: number;
      phase: number;
      speed: number;
      size: number;
      alpha: number;
    };

    let width = 0;
    let height = 0;
    let frame = 0;
    let particles: FlowParticle[] = [];
    const pointer = { x: -10000, y: -10000 };

    const ellipseStrength = (
      x: number,
      y: number,
      cx: number,
      cy: number,
      rx: number,
      ry: number,
    ) => {
      const dx = (x - cx * width) / (rx * width);
      const dy = (y - cy * height) / (ry * height);
      const value = 1 - dx * dx - dy * dy;
      return value <= 0 ? 0 : value * value;
    };

    const fieldStrength = (x: number, y: number) =>
      Math.max(
        ellipseStrength(x, y, 0.13, 0.42, 0.16, 0.27),
        ellipseStrength(x, y, 0.32, 0.44, 0.2, 0.34),
        ellipseStrength(x, y, 0.58, 0.66, 0.22, 0.2),
        ellipseStrength(x, y, 0.93, 0.58, 0.18, 0.23),
      );

    const makeParticle = (): FlowParticle => {
      let x = Math.random() * width;
      let y = Math.random() * height;

      for (let attempt = 0; attempt < 28; attempt += 1) {
        const candidateX = Math.random() * width;
        const candidateY = Math.random() * height;

        if (fieldStrength(candidateX, candidateY) > 0.05) {
          x = candidateX;
          y = candidateY;
          break;
        }
      }

      return {
        x,
        y,
        phase: Math.random() * Math.PI * 2,
        speed: 0.17 + Math.random() * 0.34,
        size: 0.8 + Math.random() * 1.45,
        alpha: 0.38 + Math.random() * 0.62,
      };
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      canvas.width = Math.floor(width * pixelRatio);
      canvas.height = Math.floor(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

      const count = Math.min(1450, Math.max(560, Math.round((width * height) / 900)));
      particles = Array.from({ length: count }, makeParticle);
    };

    const movePointer = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    };

    const leavePointer = () => {
      pointer.x = -10000;
      pointer.y = -10000;
    };

    const draw = (time: number) => {
      frame = window.requestAnimationFrame(draw);

      const t = time * 0.00034;
      context.clearRect(0, 0, width, height);
      context.globalCompositeOperation = "multiply";
      context.fillStyle = "#5d635a";

      for (const particle of particles) {
        const strength = fieldStrength(particle.x, particle.y);

        if (strength < 0.018) {
          const next = makeParticle();
          particle.x = next.x;
          particle.y = next.y;
          particle.phase = next.phase;
          continue;
        }

        const wave =
          Math.sin(particle.x * 0.007 + t * 2.2 + particle.phase) +
          Math.cos(particle.y * 0.009 - t * 1.8) +
          Math.sin((particle.x + particle.y) * 0.004 - t * 2.6);
        let angle = wave * 1.18 + t + particle.phase * 0.28;

        const pointerX = particle.x - pointer.x;
        const pointerY = particle.y - pointer.y;
        const pointerDistance = pointerX * pointerX + pointerY * pointerY;

        if (pointerDistance < 36000) {
          const distance = Math.max(24, Math.sqrt(pointerDistance));
          const pull = (1 - distance / 190) * 0.32;
          angle += Math.atan2(pointerY, pointerX) * pull;
          particle.x += (-pointerY / distance) * pull * 2.2;
          particle.y += (pointerX / distance) * pull * 2.2;
        }

        particle.x += Math.cos(angle) * particle.speed + 0.08;
        particle.y += Math.sin(angle) * particle.speed * 0.82;

        if (particle.x < -18) particle.x = width + 18;
        if (particle.x > width + 18) particle.x = -18;
        if (particle.y < -18) particle.y = height + 18;
        if (particle.y > height + 18) particle.y = -18;

        const alpha = Math.min(0.35, (0.035 + strength * 0.33) * particle.alpha);
        const size = particle.size + strength * 1.35;

        context.globalAlpha = alpha;
        context.fillRect(Math.round(particle.x), Math.round(particle.y), size, size);

        if (strength > 0.22 && particle.phase > Math.PI) {
          context.globalAlpha = alpha * 0.42;
          context.fillRect(
            Math.round(particle.x - Math.cos(angle) * 4),
            Math.round(particle.y - Math.sin(angle) * 4),
            1,
            1,
          );
        }
      }

      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    };

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    window.addEventListener("pointermove", movePointer, { passive: true });
    window.addEventListener("pointerleave", leavePointer);
    resize();
    frame = window.requestAnimationFrame(draw);

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("pointermove", movePointer);
      window.removeEventListener("pointerleave", leavePointer);
    };
  }, []);

  return <canvas aria-hidden="true" className="hero-flow-canvas" ref={canvasRef} />;
}

function StageMockup({ mode }: { mode: string }) {
  if (mode === "assistant") {
    return (
      <div className="assistant-demo panel-swap">
        <video
          src="/stud/assets/feature-clips/assistant.mp4"
          autoPlay
          muted
          loop
          playsInline
        />
        <div className="assistant-overlay">
          <span>&gt; Stud</span>
          <p>Build a sword combat system and show me the diff first.</p>
          <b>planning changes...</b>
        </div>
      </div>
    );
  }

  if (mode === "permissions") {
    return (
      <div className="permission-request panel-swap">
        <h4>Write Permission Request</h4>
        <div className="file-pill">game/src/server/PlayerData.luau</div>
        <pre>{`- local retries = 1\n+ local retries = 3\n+ task.wait(0.75)`}</pre>
        <div>
          <button>Deny</button>
          <button className="primary">Allow once</button>
          <button>Allow always</button>
        </div>
      </div>
    );
  }

  if (mode === "smart") {
    return (
      <div className="smart-demo panel-swap">
        <div>
          <Terminal size={18} />
          <span>Run tests</span>
          <b>exit 0</b>
        </div>
        <div>
          <Search size={18} />
          <span>Search project</span>
          <b>22 matches</b>
        </div>
        <div>
          <Database size={18} />
          <span>Query DataStore</span>
          <b>preview</b>
        </div>
        <div>
          <Layers size={18} />
          <span>Delegate task</span>
          <b>2 agents</b>
        </div>
      </div>
    );
  }

  if (mode === "source") {
    return (
      <div className="source-demo panel-swap">
        <Code size={28} />
        <h4>stud-ai/stud</h4>
        <p>Open tools, local permissions, and Roblox workflows you can inspect.</p>
        <div>
          <span>MIT</span>
          <span>27 tools</span>
          <span>community patches</span>
        </div>
      </div>
    );
  }

  return (
    <div className="studio-ui panel-swap">
      <div className="studio-rail">
        <span>rules</span>
        <span>village builder</span>
        <b>combat system</b>
        <span>spawn area</span>
        <span>UI refactor</span>
      </div>
      <div className="studio-main">
        <div className="search-pill">Search or type a command...</div>
        <h4>Add sword combat system</h4>
        <div className="prompt-line">
          Search the toolbox for &quot;medieval village assets&quot; and insert the
          best one into Workspace
        </div>
        <div className="tool-result">
          <div className="tool-head">
            <Search size={15} />
            <span>Toolbox Search</span>
          </div>
          <div className="asset-card">
            <img
              src="https://tr.rbxcdn.com/180DAY-118b27b7f6a9283190692ac5aa42061d/150/150/Model/Png/noFilter"
              alt="Medieval Village Pack"
            />
            <span>Medieval Village Pack</span>
            <small>Model · BuildCraft</small>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureShowcase() {
  const [featureIndex, setFeatureIndex] = useState(1);
  const feature = featureTabs[featureIndex];

  useEffect(() => {
    const id = window.setInterval(() => {
      setFeatureIndex((index) => (index + 1) % featureTabs.length);
    }, 4500);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="stud-section stud-features">
      <div className="stud-container">
        <h2 className="stud-section-title">
          Everything you need,
          <br />
          nothing you don&apos;t.
        </h2>
        <p className="stud-section-copy">
          A complete toolkit for Roblox development. Every feature is free and
          open source.
        </p>
      </div>
      <div className="stud-container">
        <div className="feature-frame">
          <aside className="feature-sidebar">
            <p className="eyebrow">Features</p>
            <nav>
              {featureTabs.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    className={`feature-tab ${
                      item.label === feature.label ? "is-active" : ""
                    }`}
                    key={item.label}
                    onClick={() => setFeatureIndex(featureTabs.indexOf(item))}
                    type="button"
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                    {item.note ? <small>{item.note}</small> : null}
                  </button>
                );
              })}
            </nav>
          </aside>
          <div className="feature-stage">
            <div className="soft-backdrop" />
            <div className="studio-window">
              <header>
                <StudLogo />
                <strong>{feature.title}</strong>
              </header>
              <StageMockup key={feature.mode} mode={feature.mode} />
            </div>
          </div>
          <div className="feature-copy-strip panel-swap" key={`copy-${feature.mode}`}>
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function WorkflowCard() {
  const [workflowIndex, setWorkflowIndex] = useState(0);
  const workflow = workflowModes[workflowIndex];

  return (
    <section className="stud-container workflow-wrap">
      <div className="workflow-card">
        <img src="/stud/assets/redwoods-2.png" alt="" />
        <div className="grid-overlay" />
        <div className="project-tree">
          <p className="eyebrow">Project Tree</p>
          <span>src</span>
          <span>server</span>
          <span>matchmaking.lua</span>
          <span>queue-manager.lua</span>
          <span>client</span>
          <span>hud-controller.lua</span>
          <span>ui-theme.lua</span>
          <span>shared</span>
        </div>
        <div className="hidden-run">
          <span>&gt;_ hidden-run.stud</span>
          <p>◆ Get Children &quot;game.Workspace&quot;</p>
          <p>◆ Edit Script &quot;ServerScriptService.Main&quot;</p>
          <p>~ Inserting asset from Toolbox...</p>
        </div>
        <div className="run-panel panel-swap" key={workflow.label}>
          <div className="run-meta">
            <span>&gt;_ Stud</span>
            <small>4.2k tokens · $0.03</small>
          </div>
          {workflow.rows.map(([label, value], index) => (
            <div
              className="run-row"
              key={`${workflow.label}-${label}`}
              style={rowStyle(index)}
            >
              <span>{label}</span>
              {value ? <small>{value}</small> : null}
            </div>
          ))}
        </div>
      </div>
      <div className="integration-band">
        <div>
          <p className="panel-swap" key={`workflow-${workflow.label}`}>
            {workflow.text}
          </p>
          <div className="segmented">
            <span>How developers use Stud</span>
            {workflowModes.map((mode, index) => (
              <button
                className={index === workflowIndex ? "active" : ""}
                key={mode.label}
                onClick={() => setWorkflowIndex(index)}
                type="button"
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        <aside>
          <h3>Join the waitlist</h3>
          <p>
            Get early access to launches, private demos, and new Roblox
            workflows as they ship.
          </p>
          <button
            className="btn btn-dark"
            onClick={() => window.dispatchEvent(new Event("open-waitlist"))}
            type="button"
          >
            Join Waitlist
          </button>
        </aside>
      </div>
    </section>
  );
}

function LaunchResourcesSection() {
  return (
    <section className="stud-section launch-system-section">
      <div className="stud-container">
        <div className="launch-system-heading">
          <h2 className="stud-section-title">
            A calm control room for Roblox agents
          </h2>
          <p className="stud-section-copy">
            Stud keeps Studio, MCP tools, approvals, and Roblox context visible
            as file-like artifacts instead of hiding work inside generic chat
            cards.
          </p>
        </div>

        <div className="launch-system-grid">
          <div className="document-stack" aria-label="Stud setup documents">
            {launchDocuments.map((document) => (
              <article className="document-card" key={document.title}>
                <div className="document-card-top">
                  <span>{document.tag}</span>
                  <small>{document.meta}</small>
                </div>
                <h3>{document.title}</h3>
                <p>{document.body}</p>
                <div className="document-lines" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </div>
              </article>
            ))}
          </div>

          <aside className="resource-panel">
            <div className="resource-panel-head">
              <span>Launch resources</span>
              <button onClick={() => scrollToId("docs")} type="button">
                Open docs
              </button>
            </div>

            <div className="resource-pill-row">
              {resourcePills.map((pill) => (
                <button
                  key={pill}
                  onClick={() =>
                    scrollToId(pill === "DataStores" ? "roblox-tools" : "docs")
                  }
                  type="button"
                >
                  {pill}
                </button>
              ))}
            </div>

            <div className="resource-task-list">
              {launchTasks.map(([state, title], index) => (
                <div className="resource-task-row" key={title} style={rowStyle(index)}>
                  <span />
                  <small>{state}</small>
                  <strong>{title}</strong>
                </div>
              ))}
            </div>

            <div className="resource-actions">
              <button onClick={() => scrollToId("permissions")} type="button">
                Review safety
              </button>
              <button
                className="is-primary"
                onClick={() => window.dispatchEvent(new Event("open-waitlist"))}
                type="button"
              >
                Join waitlist
              </button>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
}

function ToolsSection() {
  const [toolIndex, setToolIndex] = useState(2);
  const tool = toolTabs[toolIndex];

  useEffect(() => {
    const id = window.setInterval(() => {
      setToolIndex((index) => (index + 1) % toolTabs.length);
    }, 5200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <section className="stud-section tools-section">
      <div className="stud-container">
        <h2 className="stud-section-title">Powerful tools at your fingertips</h2>
        <p className="stud-section-copy wide">
          Read, write, edit, and search your codebase with natural language.
          Execute commands and delegate complex tasks to subagents.
        </p>
        <div className="tool-tabs">
          {toolTabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                className={tab.label === tool.label ? "active" : ""}
                key={tab.label}
                onClick={() => setToolIndex(toolTabs.indexOf(tab))}
                type="button"
              >
                <Icon size={18} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="command-visual panel-swap" key={tool.label}>
          <img src={tool.bg} alt="" />
          <div className="terminal-card terminal-card-animated">
            <header>
              <StudLogo />
              <small>2.1k tokens · $0.02</small>
            </header>
            {tool.rows.map(([label, value], index) => (
              <p key={`${tool.label}-${label}`} style={rowStyle(index)}>
                <span>{label}</span>
                {value ? <small>{value}</small> : <i />}
              </p>
            ))}
          </div>
        </div>
        <div className="tool-caption">
          <div>
            <h3>{tool.title}</h3>
            <p>{tool.body}</p>
          </div>
          <button onClick={() => scrollToId("roblox-tools")} type="button">
            Explore all tools <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </section>
  );
}

function RobloxVisual({ mode }: { mode: string }) {
  if (mode === "script") {
    return (
      <div className="roblox-alt panel-swap">
        <h3>CombatController.luau</h3>
        <pre>{`local Players = game:GetService("Players")\n\nlocal function applyDamage(target, amount)\n  target.Health -= amount\nend\n\nreturn applyDamage`}</pre>
        <footer>diagnostics clear · source synced</footer>
      </div>
    );
  }

  if (mode === "instance") {
    return (
      <div className="roblox-alt instance panel-swap">
        <h3>Workspace</h3>
        {["Map", "Village", "NPCs", "Lighting", "SpawnLocation"].map((item) => (
          <p key={item}>
            <Box size={16} />
            {item}
            <span>updated</span>
          </p>
        ))}
      </div>
    );
  }

  if (mode === "datastore") {
    return (
      <div className="roblox-alt datastore panel-swap">
        <h3>PlayerDataStore</h3>
        <p>
          <span>coins</span>
          <b>12840</b>
        </p>
        <p>
          <span>inventory</span>
          <b>37 items</b>
        </p>
        <p>
          <span>lastSave</span>
          <b>2m ago</b>
        </p>
        <button type="button">Preview update</button>
      </div>
    );
  }

  return (
    <div className="toolbox-modal panel-swap">
      <header>
        <h3>Search Toolbox</h3>
        <span>esc</span>
      </header>
      <div className="input">village|</div>
      <div className="toolbox-row selected">
        <img
          src="https://tr.rbxcdn.com/180DAY-118b27b7f6a9283190692ac5aa42061d/150/150/Model/Png/noFilter"
          alt=""
        />
        <div>
          <b>Medieval Village Pack</b>
          <span>Model · BuildCraft ✓</span>
        </div>
      </div>
      <div className="toolbox-row">
        <img
          src="https://tr.rbxcdn.com/180DAY-118b27b7f6a9283190692ac5aa42061d/150/150/Model/Png/noFilter"
          alt=""
        />
        <div>
          <b>Villager House</b>
          <span>Model · BlockBuilder ✓</span>
        </div>
      </div>
      <div className="toolbox-row">
        <img
          src="https://tr.rbxcdn.com/180DAY-118b27b7f6a9283190692ac5aa42061d/150/150/Model/Png/noFilter"
          alt=""
        />
        <div>
          <b>Village Town Center</b>
          <span>Model · MapMakers ✓</span>
        </div>
      </div>
      <div className="toolbox-row">
        <img
          src="https://tr.rbxcdn.com/180DAY-118b27b7f6a9283190692ac5aa42061d/150/150/Model/Png/noFilter"
          alt=""
        />
        <div>
          <b>Fantasy Village Kit</b>
          <span>Model · RPGAssets</span>
        </div>
      </div>
      <div className="toolbox-row">
        <img
          src="https://tr.rbxcdn.com/180DAY-118b27b7f6a9283190692ac5aa42061d/150/150/Model/Png/noFilter"
          alt=""
        />
        <div>
          <b>Village Market Stall</b>
          <span>Model · DetailProps ✓</span>
        </div>
      </div>
      <footer>↑↓ navigate &nbsp;&nbsp; ↵ select</footer>
    </div>
  );
}

function RobloxSection() {
  const [robloxIndex, setRobloxIndex] = useState(3);
  const selected = robloxTools[robloxIndex];

  return (
    <section className="stud-section roblox-section" id="roblox-tools">
      <div className="stud-container">
        <h2 className="stud-section-title">Built for Roblox developers</h2>
        <p className="stud-section-copy wide">
          27+ specialized tools for Roblox Studio. Edit scripts, manipulate
          instances, query DataStores, and search the Toolbox.
        </p>
        <div className="roblox-grid">
          <div className="roblox-list">
            {robloxTools.map((tool) => {
              const Icon = tool.icon;
              return (
                <button
                  className={tool.title === selected.title ? "active" : ""}
                  key={tool.title}
                  onClick={() => setRobloxIndex(robloxTools.indexOf(tool))}
                  type="button"
                >
                  <div>
                    <Icon size={22} />
                  </div>
                  <div>
                    <h3>{tool.title}</h3>
                    <p>{tool.body}</p>
                  </div>
                </button>
              );
            })}
            <button onClick={() => scrollToId("docs")} type="button">
              Roblox integration guide <ChevronRight size={16} />
            </button>
          </div>
          <div className="toolbox-visual">
            <img src="/stud/assets/redwoods-2.png" alt="" />
            <RobloxVisual key={selected.mode} mode={selected.mode} />
          </div>
        </div>
      </div>
    </section>
  );
}

function CapabilitiesSection() {
  return (
    <section className="stud-section capabilities" id="docs">
      <div className="stud-container">
        <p className="center-statement">
          Stud understands your codebase deeply, learning your patterns to write
          code that fits naturally into your project.
        </p>
        <h2 className="tech-title">Powerful capabilities under the hood</h2>
        <p className="stud-section-copy wide">
          Modern AI with deep tooling integration for a seamless development
          experience.
        </p>
        <div className="capability-grid">
          {capabilities.map((capability) => {
            const Icon = capability.icon;
            return (
              <article key={capability.title}>
                <div>
                  <Icon size={22} />
                </div>
                <span>
                  <h3>{capability.title}</h3>
                  <p>{capability.body}</p>
                </span>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PermissionsSection() {
  const [permissionIndex, setPermissionIndex] = useState(3);
  const selected = permissionCards[permissionIndex];
  const SelectedIcon = selected.icon;

  return (
    <section className="permission-section" id="permissions">
      <div className="stud-container narrow">
        <h2 className="stud-section-title centered">You&apos;re always in control</h2>
        <p className="stud-section-copy centered-copy">
          A robust permission system ensures Stud only takes actions you
          approve.
        </p>
        <div className="permission-visual">
          <img src="/stud/assets/redwoods-dark.png" alt="" />
          <div className="permission-card panel-swap">
            <h3>
              <SelectedIcon size={17} /> {selected.title}
            </h3>
            <p>
              <span>✓ Read files</span>
              <b className="allow">always allow</b>
            </p>
            <p>
              <span>✓ Glob & Grep</span>
              <b className="allow">always allow</b>
            </p>
            <p>
              <span>△ Write files</span>
              <b className="ask">ask each time</b>
            </p>
            <p>
              <span>△ Bash commands</span>
              <b className="ask">ask each time</b>
            </p>
            <p>
              <span>× Destructive ops</span>
              <b className="deny">always deny</b>
            </p>
          </div>
        </div>
      </div>
      <div className="stud-container permission-grid">
        {permissionCards.map((card, index) => {
          const Icon = card.icon;
          return (
            <button
              className={index === permissionIndex ? "active" : ""}
              key={card.title}
              onClick={() => setPermissionIndex(index)}
              type="button"
            >
              <div>
                <Icon size={22} />
              </div>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </button>
          );
        })}
      </div>
      <button
        className="permission-link"
        onClick={() => scrollToId("docs")}
        type="button"
      >
        Learn about permissions <ChevronRight size={16} />
      </button>
    </section>
  );
}

function CtaAndFooter() {
  return (
    <>
      <section className="cta-section">
        <div className="stud-container">
          <p className="eyebrow">Waitlist Access</p>
          <h2>Get early access to Stud for Roblox.</h2>
          <p>
            Join the waitlist to get launch updates, private demos, and first
            access to new Roblox workflows.
          </p>
          <div>
            <button
              className="btn btn-metal"
              onClick={() => window.dispatchEvent(new Event("open-waitlist"))}
              type="button"
            >
              Join Waitlist
            </button>
            <button
              className="btn btn-dark"
              onClick={() => scrollToId("docs")}
              type="button"
            >
              Read Docs
            </button>
          </div>
        </div>
      </section>
      <footer className="stud-footer">
        <div className="stud-container">
          <div className="footer-top">
            <div>
              <StudLogo large />
              <p>Open-source AI coding assistant built for Roblox developers.</p>
            </div>
            <nav>
              <span>Product</span>
              <button
                onClick={() => window.dispatchEvent(new Event("open-waitlist"))}
                type="button"
              >
                Join Waitlist
              </button>
              <a href="#docs">Documentation</a>
              <a href="#roblox-tools">Tools</a>
            </nav>
          </div>
          <div className="footer-mark">
            <a href="#waitlist">STUD</a>
            <p>&copy; 2026 Stud. All rights reserved.</p>
          </div>
        </div>
      </footer>
    </>
  );
}

function WaitlistModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [submitted, setSubmitted] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      window.setTimeout(() => emailRef.current?.focus(), 80);
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="waitlist-modal" role="dialog" aria-modal="true">
      <button
        aria-label="Close waitlist"
        className="modal-backdrop"
        onClick={onClose}
        type="button"
      />
      <form
        className="waitlist-panel"
        onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
        }}
      >
        <header>
          <StudLogo />
          <button aria-label="Close" onClick={onClose} type="button">
            ×
          </button>
        </header>
        {submitted ? (
          <div className="modal-success panel-swap">
            <h2>You&apos;re on the list.</h2>
            <p>
              Thanks for joining. This demo keeps the signup local, but the
              interaction now behaves like the real waitlist flow.
            </p>
            <button className="btn btn-dark" onClick={onClose} type="button">
              Done
            </button>
          </div>
        ) : (
          <>
            <h2>Join the Stud waitlist</h2>
            <p>
              Get launch updates, private demos, and first access to Roblox
              workflows.
            </p>
            <label>
              Email
              <input
                ref={emailRef}
                required
                type="email"
                placeholder="you@example.com"
              />
            </label>
            <label>
              What are you building?
              <select defaultValue="Roblox game">
                <option>Roblox game</option>
                <option>Studio plugin</option>
                <option>Luau tooling</option>
                <option>Just exploring</option>
              </select>
            </label>
            <button className="btn btn-dark" type="submit">
              Request Access
            </button>
          </>
        )}
      </form>
    </div>
  );
}

export default function Home() {
  const [waitlistOpen, setWaitlistOpen] = useState(false);

  useEffect(() => {
    const open = () => setWaitlistOpen(true);
    window.addEventListener("open-waitlist", open);
    return () => window.removeEventListener("open-waitlist", open);
  }, []);

  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".stud-page");
    const revealItems = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".stud-section, .workflow-wrap, .permission-section, .cta-section, .stud-footer",
      ),
    );

    const handlePointer = (event: PointerEvent) => {
      if (!root) {
        return;
      }

      root.style.setProperty(
        "--pointer-x",
        `${(event.clientX / window.innerWidth) * 100}%`,
      );
      root.style.setProperty(
        "--pointer-y",
        `${(event.clientY / window.innerHeight) * 100}%`,
      );
    };

    revealItems.forEach((item) => item.classList.add("reveal-item"));

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
          }
        });
      },
      { rootMargin: "0px 0px -90px 0px", threshold: 0.12 },
    );

    revealItems.forEach((item) => observer.observe(item));
    window.addEventListener("pointermove", handlePointer, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("pointermove", handlePointer);
    };
  }, []);

  return (
    <main className="stud-page">
      <section className="hero" id="waitlist">
        <div className="hero-noise" />
        <HeroFlowField />
        <div className="hero-light-field" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <nav className="stud-nav">
          <a href="#waitlist">
            <StudLogo />
          </a>
          <div className="hero-nav-links" aria-label="Product navigation">
            <button onClick={() => scrollToId("docs")} type="button">
              How to
            </button>
            <button onClick={() => setWaitlistOpen(true)} type="button">
              Start
            </button>
            <button onClick={() => scrollToId("roblox-tools")} type="button">
              Build
            </button>
            <button onClick={() => scrollToId("permissions")} type="button">
              Safety
            </button>
            <button onClick={() => scrollToId("docs")} type="button">
              Docs
            </button>
            <button onClick={() => scrollToId("roblox-tools")} type="button">
              Tools
            </button>
            <button onClick={() => setWaitlistOpen(true)} type="button">
              Pricing
            </button>
          </div>
          <button
            className="nav-button"
            onClick={() => setWaitlistOpen(true)}
            type="button"
          >
            Build a game
          </button>
        </nav>
        <div className="hero-content">
          <h1>
            Stud lets you build an entire Roblox game with agents
          </h1>
          <p>
            Run scripting, worldbuilding, UI, DataStores, and live Studio ops.
          </p>
          <div className="hero-actions">
            <button
              className="hero-button is-primary"
              onClick={() => setWaitlistOpen(true)}
              type="button"
            >
              Build a game
            </button>
            <button
              className="hero-button is-secondary"
              onClick={() => scrollToId("roblox-tools")}
              type="button"
            >
              Check out the launch
            </button>
          </div>
        </div>
        <div className="hero-task-stack" aria-hidden="true">
          <div className="hero-task-row is-active">
            <span />
            <small>Task running</small>
            <strong>Generate world</strong>
          </div>
          <div className="hero-task-row">
            <span />
            <small>Task Completed</small>
            <strong>Write Luau scripts</strong>
          </div>
          <div className="hero-task-row">
            <span />
            <small>Task Completed</small>
            <strong>Place assets</strong>
          </div>
        </div>
        <div className="hero-file-card" aria-hidden="true">
          <small>Studio patch plan</small>
          <strong>CombatController.luau</strong>
          <span>+18 lines · approval ready</span>
        </div>
        <div className="hero-resource-pill" aria-hidden="true">
          MCP route · Studio live
        </div>
      </section>
      <div className="stud-body">
        <FeatureShowcase />
        <LaunchResourcesSection />
        <WorkflowCard />
        <ToolsSection />
        <RobloxSection />
        <CapabilitiesSection />
        <PermissionsSection />
        <CtaAndFooter />
      </div>
      {waitlistOpen ? (
        <WaitlistModal
          onClose={() => setWaitlistOpen(false)}
          open={waitlistOpen}
        />
      ) : null}
    </main>
  );
}
