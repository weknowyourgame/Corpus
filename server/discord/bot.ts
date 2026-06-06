import { randomBytes } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { AgentEvent, AgentQuestion, AgentRun, JsonValue } from "../agent/types.ts";
import { DiscordProjectStore } from "./store.ts";
import type {
  DiscordAction,
  DiscordBotDeps,
  DiscordConfig,
  DiscordPendingInteraction,
  DiscordProject,
  DiscordRunRequest,
} from "./types.ts";

const DISCORD_CONTENT_LIMIT = 1900;
const ACTION_TTL_MS = 30 * 60_000;

type RoleCacheLike = {
  cache?: {
    keys: () => Iterable<string>;
  };
};

type MemberLike = {
  roles?: string[] | RoleCacheLike;
};

const roleIds = (member: unknown) => {
  if (!member || typeof member !== "object") return [];
  const roles = (member as MemberLike).roles;
  if (Array.isArray(roles)) return roles;
  if (roles && typeof roles === "object" && typeof roles.cache?.keys === "function") {
    return [...roles.cache.keys()];
  }
  return [];
};

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 3))}...`;

const toolLabel = (toolName: string) =>
  toolName
    .replace(/^roblox_/, "")
    .replace(/^corpus_/, "")
    .replace(/_/g, " ");

const splitDiscord = (value: string) => {
  const text = value.trim();
  if (!text) return [];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > DISCORD_CONTENT_LIMIT) {
    const cut = rest.lastIndexOf("\n", DISCORD_CONTENT_LIMIT);
    const index = cut > 400 ? cut : DISCORD_CONTENT_LIMIT;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
};

const jsonSummary = (value: JsonValue | undefined) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const obj = value as Record<string, JsonValue>;
  if (typeof obj.error === "string") return `Error: ${obj.error}`;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.path === "string") return obj.path;
  return "";
};

const questionText = (questions: AgentQuestion[]) => {
  const lines = questions.map((question, index) => {
    const options = (question.options ?? [])
      .map((option) => typeof option === "string" ? option : option.label)
      .filter(Boolean);
    const suffix = options.length ? `\nOptions: ${options.join(", ")}` : "";
    return questions.length === 1
      ? `${question.question}${suffix}`
      : `${index + 1}. ${question.question}${suffix}`;
  });
  return lines.join("\n\n");
};

const answerFor = (question: AgentQuestion, value: string) => {
  const trimmed = value.trim();
  if (question.type !== "multi") return trimmed;
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
};

export class CorpusDiscordBot {
  private readonly client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  private readonly store = new DiscordProjectStore();
  private readonly actions = new Map<string, { expiresAt: number; action: DiscordAction }>();
  private readonly pendingInteractions = new Map<string, DiscordPendingInteraction>();

  constructor(
    private readonly config: DiscordConfig,
    private readonly deps: DiscordBotDeps,
  ) {}

  async start() {
    if (!this.config.enabled) return;
    this.client.once(Events.ClientReady, (client) => {
      console.log(`[discord] logged in as ${client.user.tag}`);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction).catch((error) => this.logError("interaction", error));
    });
    this.client.on(Events.MessageCreate, (message) => {
      void this.handleMessage(message).catch((error) => this.logError("message", error));
    });

    if (this.config.registerCommands) await this.registerCommands();
    await this.client.login(this.config.token);
  }

  private async registerCommands() {
    const rest = new REST({ version: "10" }).setToken(this.config.token);
    const body = [this.command().toJSON()];
    if (this.config.guildIds.length) {
      for (const guildId of this.config.guildIds) {
        await rest.put(Routes.applicationGuildCommands(this.config.clientId, guildId), { body });
        console.log(`[discord] registered /${this.config.commandName} in guild ${guildId}`);
      }
      return;
    }
    await rest.put(Routes.applicationCommands(this.config.clientId), { body });
    console.log(`[discord] registered global /${this.config.commandName}`);
  }

  private command() {
    return new SlashCommandBuilder()
      .setName(this.config.commandName)
      .setDescription("Control Corpus from this Discord channel")
      .addSubcommand((command) => command
        .setName("connect")
        .setDescription("Link this channel to Roblox Studio")
        .addStringOption((option) => option
          .setName("session")
          .setDescription("Paste the Studio token from Corpus, or a short session id")
          .setRequired(true)
          .setMinLength(6)
          .setMaxLength(160)))
      .addSubcommand((command) => command
        .setName("status")
        .setDescription("Show the Studio connection linked to this channel"))
      .addSubcommand((command) => command
        .setName("disconnect")
        .setDescription("Unlink this channel from its Studio session"))
      .addSubcommand((command) => command
        .setName("cancel")
        .setDescription("Cancel the active Corpus run in this channel"))
      .addSubcommand((command) => command
        .setName("run")
        .setDescription("Send a prompt to Corpus")
        .addStringOption((option) => option
          .setName("prompt")
          .setDescription("What should Corpus build or change?")
          .setRequired(true)
          .setMaxLength(Math.min(this.config.maxPromptLength, 6000))))
      .addSubcommand((command) => command
        .setName("plan")
        .setDescription("Ask Corpus for an implementation plan first")
        .addStringOption((option) => option
          .setName("prompt")
          .setDescription("What should Corpus plan?")
          .setRequired(true)
          .setMaxLength(Math.min(this.config.maxPromptLength, 6000))))
      .addSubcommand((command) => command
        .setName("guide")
        .setDescription("Show the Discord setup checklist"));
  }

  private async handleInteraction(interaction: Interaction) {
    if (interaction.isChatInputCommand() && interaction.commandName === this.config.commandName) {
      await this.handleCommand(interaction);
      return;
    }
    if (interaction.isButton()) {
      await this.handleButton(interaction);
    }
  }

  private async handleCommand(interaction: ChatInputCommandInteraction) {
    if (!this.canUseInteraction(interaction)) {
      await interaction.reply({ content: "This Discord member is not allowed to use Corpus here.", flags: MessageFlags.Ephemeral });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "connect") {
      await this.connect(interaction);
      return;
    }
    if (subcommand === "status") {
      await this.status(interaction);
      return;
    }
    if (subcommand === "disconnect") {
      await this.disconnect(interaction);
      return;
    }
    if (subcommand === "cancel") {
      await this.cancel(interaction);
      return;
    }
    if (subcommand === "run" || subcommand === "plan") {
      await this.runCommand(interaction, subcommand);
      return;
    }
    if (subcommand === "guide") {
      await interaction.reply({ content: this.guideText(), flags: MessageFlags.Ephemeral });
    }
  }

  private async connect(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    const channelId = interaction.channelId;
    const input = interaction.options.getString("session", true).trim();
    const resolved = this.deps.resolveStudioSession(input);
    if (!guildId || !resolved) {
      await interaction.reply({
        content: "Paste the Studio token from the Corpus web app/plugin, or a short session id like `ABC12345`.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const conversation = await this.deps.runtime.createConversation(resolved.sessionId, undefined, null);
    const project = await this.store.connect({
      guildId,
      channelId,
      ownerDiscordId: interaction.user.id,
      conversationId: conversation.id,
      studioSessionId: resolved.sessionId,
    });
    const status = this.deps.studioStatus(project.studioSessionId);
    const line = status.connected || resolved.studioConnected ? "Studio is connected." : "Studio is not polling yet. Open Studio with the Corpus plugin running.";
    await interaction.reply({
      content: `Linked this channel to Studio session \`${project.studioSessionId}\`.\n${line}\nYou can now talk to Corpus in this channel.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async status(interaction: ChatInputCommandInteraction) {
    const project = await this.store.getActiveByChannel(interaction.channelId);
    if (!project) {
      await interaction.reply({ content: "This channel is not linked yet. Run `/corpus connect` with your Studio token first.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.reply({ content: this.statusText(project), flags: MessageFlags.Ephemeral });
  }

  private async disconnect(interaction: ChatInputCommandInteraction) {
    const project = await this.store.disconnect(interaction.channelId);
    const content = project
      ? `Disconnected this channel from Studio session \`${project.studioSessionId}\`.`
      : "This channel was not linked to Corpus.";
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  private async cancel(interaction: ChatInputCommandInteraction) {
    const project = await this.store.getActiveByChannel(interaction.channelId);
    if (!project) {
      await interaction.reply({ content: "This channel is not linked yet.", flags: MessageFlags.Ephemeral });
      return;
    }
    const conversation = await this.deps.runtime.getConversation(project.conversationId);
    const run = conversation?.runs.find((item) => item.status === "running");
    if (!run) {
      await interaction.reply({ content: "No Corpus run is active in this channel.", flags: MessageFlags.Ephemeral });
      return;
    }
    const cancelled = await this.deps.runtime.cancelRun(project.conversationId, run.id);
    await interaction.reply({
      content: cancelled ? "Cancelled the active Corpus run." : "That run could not be cancelled.",
      flags: MessageFlags.Ephemeral,
    });
  }

  private async runCommand(interaction: ChatInputCommandInteraction, subcommand: string) {
    const project = await this.store.getActiveByChannel(interaction.channelId);
    if (!project) {
      await interaction.reply({ content: "This channel is not linked yet. Run `/corpus connect` with your Studio token first.", flags: MessageFlags.Ephemeral });
      return;
    }
    const prompt = interaction.options.getString("prompt", true);
    await interaction.reply(`Starting Corpus ${subcommand === "plan" ? "plan" : "run"}...`);
    await this.startRun(project, {
      prompt,
      mode: subcommand === "plan" ? "plan" : "execute",
    });
  }

  private async handleButton(interaction: ButtonInteraction) {
    if (!this.canUseInteraction(interaction)) {
      await interaction.reply({ content: "You are not allowed to use Corpus controls here.", flags: MessageFlags.Ephemeral });
      return;
    }
    const action = this.takeAction(interaction.customId);
    if (!action) {
      await interaction.reply({ content: "That Corpus action expired. Ask Corpus to try again.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (action.type === "approval") {
      const answered = await this.deps.runtime.answerApproval(
        action.conversationId,
        action.runId,
        action.approvalId,
        action.decision,
      );
      await interaction.update({
        content: answered ? `Approval answered: \`${action.decision}\`.` : "That approval is no longer active.",
        components: [],
      });
      return;
    }
    const ok = action.decision === "approve"
      ? await this.deps.runtime.approvePlan(action.conversationId, action.planId)
      : await this.deps.runtime.rejectPlan(action.conversationId, action.planId);
    await interaction.update({
      content: ok ? `Plan ${action.decision === "approve" ? "approved" : "rejected"}.` : "That plan is no longer active.",
      components: [],
    });
  }

  private async handleMessage(message: Message) {
    if (message.author.bot || !message.guildId) return;
    if (!this.guildAllowed(message.guildId) || !this.memberAllowed(message.member)) return;
    const pending = this.pendingInteractions.get(message.channelId);
    if (pending) {
      await this.answerPendingInteraction(message, pending);
      return;
    }
    const project = await this.store.getActiveByChannel(message.channelId);
    if (!project) return;
    if (this.config.requireMention && (!this.client.user || !message.mentions.users.has(this.client.user.id))) return;
    const prompt = this.cleanPrompt(message.content);
    if (!prompt) return;
    await this.startRun(project, { prompt, mode: "execute" });
  }

  private async answerPendingInteraction(message: Message, pending: DiscordPendingInteraction) {
    const lines = message.content.split("\n").map((line) => line.trim()).filter(Boolean);
    const answers = pending.questions.map((question, index) => answerFor(question, lines[index] ?? message.content));
    this.pendingInteractions.delete(message.channelId);
    const answered = await this.deps.runtime.answerInteraction(
      pending.conversationId,
      pending.runId,
      pending.interactionId,
      answers,
    );
    await message.reply(answered ? "Got it. Continuing the run." : "That question is no longer active.");
  }

  private async startRun(project: DiscordProject, request: DiscordRunRequest) {
    const prompt = truncate(this.cleanPrompt(request.prompt), this.config.maxPromptLength);
    if (!prompt) return;
    const conversation = await this.deps.runtime.getConversation(project.conversationId);
    if (!conversation) {
      await this.send(project.channelId, "This Discord channel points at a missing Corpus conversation. Reconnect the channel.");
      return;
    }
    const after = Math.max(0, conversation.nextSequence - 1);
    let run: AgentRun;
    try {
      run = await this.deps.runtime.startRun(project.conversationId, {
        message: prompt,
        tier: this.config.defaultTier,
        mode: request.mode,
        fullAccess: this.config.fullAccess,
      });
    } catch (error) {
      await this.send(project.channelId, error instanceof Error ? error.message : String(error));
      return;
    }

    await this.store.setLastRun(project.channelId, run.id);
    const reporter = this.createReporter(project.channelId, run.id);
    let unsubscribe: () => void = () => undefined;
    unsubscribe = await this.deps.runtime.subscribe(project.conversationId, after, (event) => {
      if (event.runId !== run.id) return;
      void reporter(event, unsubscribe).catch((error) => this.logError("run reporter", error));
    });
  }

  private createReporter(channelId: string, runId: string) {
    let status: Message | null = null;
    let accumulated = "";
    let last = "";

    const updateStatus = async (content: string) => {
      const next = truncate(content, 1800);
      if (next === last) return;
      last = next;
      if (!status) {
        status = await this.send(channelId, next);
        return;
      }
      status = await status.edit(next).catch(() => status);
    };

    const finish = async (text: string, unsubscribe: () => void) => {
      await updateStatus("Corpus finished.");
      const chunks = splitDiscord(text || accumulated || "Done.");
      for (const chunk of chunks.slice(0, 6)) {
        await this.send(channelId, chunk);
      }
      if (chunks.length > 6) await this.send(channelId, "Output was too long for Discord, so I trimmed the tail.");
      unsubscribe();
    };

    return async (event: AgentEvent, unsubscribe: () => void) => {
      if (event.type === "run_started") {
        await updateStatus(`Corpus is working in ${event.mode} mode...`);
        return;
      }
      if (event.type === "text_delta") {
        accumulated += event.text;
        return;
      }
      if (event.type === "tool_call") {
        await updateStatus(`Using ${toolLabel(event.toolName)}...`);
        return;
      }
      if (event.type === "tool_result") {
        const summary = jsonSummary(event.output);
        if (summary) await updateStatus(`${toolLabel(event.toolName)}: ${truncate(summary, 120)}`);
        return;
      }
      if (event.type === "mutation_result") {
        await updateStatus(`${toolLabel(event.toolName)} changed ${event.path}.`);
        return;
      }
      if (event.type === "task_update") {
        await updateStatus(`${event.title}: ${event.status}${event.note ? ` - ${event.note}` : ""}`);
        return;
      }
      if (event.type === "approval_pending") {
        await this.sendApproval(channelId, event);
        return;
      }
      if (event.type === "interaction_requested") {
        this.pendingInteractions.set(channelId, {
          conversationId: event.conversationId,
          runId,
          interactionId: event.interactionId,
          questions: event.questions,
        });
        await this.send(channelId, `Corpus needs input before continuing:\n${questionText(event.questions)}\n\nReply in this channel with the answer.`);
        return;
      }
      if (event.type === "plan_steps_proposed") {
        await this.sendPlan(channelId, event);
        return;
      }
      if (event.type === "run_completed") {
        await finish(event.text, unsubscribe);
        return;
      }
      if (event.type === "run_error") {
        await updateStatus(`Corpus hit an error: ${event.error}`);
        unsubscribe();
        return;
      }
      if (event.type === "run_cancelled") {
        await updateStatus(`Corpus run cancelled: ${event.reason}`);
        unsubscribe();
      }
    };
  }

  private async sendApproval(channelId: string, event: Extract<AgentEvent, { type: "approval_pending" }>) {
    const buttons = [
      new ButtonBuilder()
        .setCustomId(this.actionId({
          type: "approval",
          conversationId: event.conversationId,
          runId: event.runId,
          approvalId: event.approvalId,
          decision: "allow_once",
        }))
        .setLabel("Allow once")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(this.actionId({
          type: "approval",
          conversationId: event.conversationId,
          runId: event.runId,
          approvalId: event.approvalId,
          decision: "allow_scope",
        }))
        .setLabel("Approve scope")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(this.actionId({
          type: "approval",
          conversationId: event.conversationId,
          runId: event.runId,
          approvalId: event.approvalId,
          decision: "deny",
        }))
        .setLabel("Deny")
        .setStyle(ButtonStyle.Danger),
    ];
    if (event.allowStripScripts) {
      buttons.splice(2, 0, new ButtonBuilder()
        .setCustomId(this.actionId({
          type: "approval",
          conversationId: event.conversationId,
          runId: event.runId,
          approvalId: event.approvalId,
          decision: "insert_without_scripts",
        }))
        .setLabel("No scripts")
        .setStyle(ButtonStyle.Secondary));
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
    await this.send(channelId, {
      content: `Corpus needs approval for **${toolLabel(event.toolName)}**.\n${event.summary}\nScope: \`${event.scope}\``,
      components: [row],
    });
  }

  private async sendPlan(channelId: string, event: Extract<AgentEvent, { type: "plan_steps_proposed" }>) {
    const approve = new ButtonBuilder()
      .setCustomId(this.actionId({
        type: "plan",
        conversationId: event.conversationId,
        planId: event.planId,
        decision: "approve",
      }))
      .setLabel("Approve plan")
      .setStyle(ButtonStyle.Success);
    const reject = new ButtonBuilder()
      .setCustomId(this.actionId({
        type: "plan",
        conversationId: event.conversationId,
        planId: event.planId,
        decision: "reject",
      }))
      .setLabel("Reject")
      .setStyle(ButtonStyle.Danger);
    const steps = event.steps
      .slice(0, 8)
      .map((step, index) => `${step.index ?? index + 1}. ${step.title ?? step.summary ?? step.scope}`)
      .join("\n");
    await this.send(channelId, {
      content: `Corpus proposed a plan:\n${event.summary}\n\n${steps}`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(approve, reject)],
    });
  }

  private actionId(action: DiscordAction) {
    this.cleanupActions();
    const token = randomBytes(9).toString("base64url");
    this.actions.set(token, { expiresAt: Date.now() + ACTION_TTL_MS, action });
    return `corpus:${token}`;
  }

  private takeAction(customId: string) {
    this.cleanupActions();
    if (!customId.startsWith("corpus:")) return null;
    const token = customId.slice("corpus:".length);
    const entry = this.actions.get(token);
    if (!entry || entry.expiresAt < Date.now()) return null;
    this.actions.delete(token);
    return entry.action;
  }

  private cleanupActions() {
    const timestamp = Date.now();
    for (const [token, entry] of this.actions) {
      if (entry.expiresAt < timestamp) this.actions.delete(token);
    }
  }

  private canUseInteraction(interaction: Interaction) {
    if (!interaction.guildId) return false;
    return this.guildAllowed(interaction.guildId) && this.memberAllowed(interaction.member);
  }

  private guildAllowed(guildId: string) {
    return this.config.guildIds.length === 0 || this.config.guildIds.includes(guildId);
  }

  private memberAllowed(member: unknown) {
    const allowed = [...this.config.allowedRoleIds, ...this.config.adminRoleIds];
    if (allowed.length === 0) return true;
    const roles = roleIds(member);
    return roles.some((role) => allowed.includes(role));
  }

  private cleanPrompt(value: string) {
    const botId = this.client.user?.id;
    const withoutMention = botId
      ? value.replace(new RegExp(`<@!?${botId}>`, "g"), "")
      : value;
    return withoutMention.trim();
  }

  private statusText(project: DiscordProject) {
    const status = this.deps.studioStatus(project.studioSessionId);
    const connected = status.connected ? "connected" : "not connected";
    const lastPoll = status.last_poll_time === null ? "never" : `${Math.round(status.last_poll_time / 1000)}s ago`;
    return [
      `Channel is linked to Studio session \`${project.studioSessionId}\`.`,
      `Studio: **${connected}**`,
      `Last plugin poll: ${lastPoll}`,
      `Pending Studio requests: ${status.pending_requests}`,
      project.lastRunId ? `Last run: \`${project.lastRunId.slice(0, 8)}\`` : "",
    ].filter(Boolean).join("\n");
  }

  private guideText() {
    return [
      "Discord Corpus setup:",
      "1. Open Roblox Studio and run the Corpus plugin.",
      "2. Copy the Studio token from the Corpus web app.",
      "3. Run `/corpus connect` and paste that token in a private project channel.",
      "4. Chat naturally in that channel, or use `/corpus run prompt:<task>`.",
      "5. Use approval buttons when Corpus asks before risky changes.",
    ].join("\n");
  }

  private async send(channelId: string, options: string | MessageCreateOptions) {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return null;
    return channel.send(options);
  }

  private logError(area: string, error: unknown) {
    console.error(`[discord] ${area} failed`, error instanceof Error ? error.message : error);
  }
}
