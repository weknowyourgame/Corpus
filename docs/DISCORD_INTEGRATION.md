# Discord Integration Guide

Corpus can run as an invite-only Discord bot without changing the existing web app. Discord is only a chat/control surface; Roblox Studio still connects through the Corpus Studio plugin and the bridge polling model.

## Architecture

```text
Discord project channel
  -> Corpus Discord bot
  -> existing AgentRuntime
  -> existing Studio bridge queue
  -> Corpus Roblox Studio plugin
  -> Roblox Studio changes
```

The React web app continues to use the existing `/agent` HTTP/SSE routes. The Discord bot calls the same server runtime directly from `server/discord`.

## What Was Added

- `server/discord/` - Discord adapter, commands, message listener, approval buttons, event formatting.
- `discord_projects` table - maps one Discord channel to one Corpus conversation and Studio session.
- Env-gated bridge startup - Discord only starts when configured with `CORPUS_DISCORD_ENABLED=true`, `DISCORD_BOT_TOKEN`, and `DISCORD_CLIENT_ID`.
- File fallback - local dev without `DATABASE_URL` stores mappings in `.corpus/discord-projects.json`.

## Discord App Setup

1. Go to the Discord Developer Portal.
2. Create an application named `Corpus`.
3. Open **Bot** and create/reset the bot token.
4. Enable these privileged intents:
   - Message Content Intent: required for natural messages in linked channels.
   - Server Members Intent: recommended when gating by role.
5. Copy:
   - bot token -> `DISCORD_BOT_TOKEN`
   - application/client id -> `DISCORD_CLIENT_ID`
6. Under **OAuth2 -> URL Generator**, select:
   - Scopes: `bot`, `applications.commands`
   - Bot permissions: Send Messages, Read Message History, Use Slash Commands, Embed Links.
7. Invite the bot to your private Discord server.

## Environment

Add this to the bridge server environment:

```bash
CORPUS_DISCORD_ENABLED=true
DISCORD_BOT_TOKEN=...
DISCORD_CLIENT_ID=...
CORPUS_DISCORD_GUILD_IDS=123456789012345678
CORPUS_DISCORD_ALLOWED_ROLE_IDS=234567890123456789
CORPUS_DISCORD_ADMIN_ROLE_IDS=345678901234567890
CORPUS_DISCORD_DEFAULT_TIER=pro
CORPUS_DISCORD_REGISTER_COMMANDS=true
CORPUS_DISCORD_REQUIRE_MENTION=false
CORPUS_DISCORD_MAX_PROMPT_LENGTH=6000
CORPUS_DISCORD_FULL_ACCESS=false
```

Notes:

- `CORPUS_DISCORD_GUILD_IDS` should be set for invite-only alpha use.
- If `CORPUS_DISCORD_ALLOWED_ROLE_IDS` and `CORPUS_DISCORD_ADMIN_ROLE_IDS` are empty, any member in the allowed guild can use Corpus.
- `CORPUS_DISCORD_REQUIRE_MENTION=false` is best for private project channels.
- Set `CORPUS_DISCORD_REQUIRE_MENTION=true` if the bot is present in shared channels.
- `CORPUS_DISCORD_FULL_ACCESS=true` only works when `CORPUS_FULL_ACCESS_ENABLED=true` is also set.

## Database Migration

For production:

```bash
npm run db:generate
npm run db:migrate:deploy
```

For local development:

```bash
npm run db:generate
npm run db:migrate
```

If you run without `DATABASE_URL`, no migration is needed; Discord links are written to `.corpus/discord-projects.json`.

## User Flow

1. User opens Roblox Studio.
2. User runs or installs the Corpus Studio plugin.
3. Copy the Studio token from the Corpus web app. This is the same token you paste into the Roblox Studio plugin.
4. In a private Discord project channel, user runs:

```text
/corpus connect session:<studio-token>
```

5. The channel is now linked to that Studio session.
6. User chats naturally:

```text
make me a round timer with lobby voting and a server validated coin reward
```

7. Corpus posts progress in Discord.
8. If a risky Studio action needs approval, Corpus posts buttons:
   - Allow once
   - Approve scope
   - No scripts, when supported
   - Deny

## Commands

```text
/corpus connect session:<studio-token>
/corpus status
/corpus disconnect
/corpus cancel
/corpus run prompt:<task>
/corpus plan prompt:<task>
/corpus guide
```

Natural channel messages also start runs after `/corpus connect`, unless `CORPUS_DISCORD_REQUIRE_MENTION=true`.

## Recommended Discord Layout

Create one private channel per project:

```text
#project-sarthak-obby
#project-alex-tycoon
#project-test-arena
```

Recommended permissions:

- only the project owner/team can see the channel
- only the Corpus bot and allowed builder roles can send messages
- keep general chat separate from Corpus project channels

## Deployment Checklist

1. Deploy the bridge server with the Discord env vars.
2. Run Prisma migrations.
3. Restart the bridge.
4. Confirm logs show:

```text
[discord] registered /corpus in guild ...
[discord] logged in as Corpus#....
```

5. In Discord, run `/corpus guide`.
6. Open Studio with the Corpus plugin connected.
7. Run `/corpus connect session:<studio-token>`.
8. Run `/corpus status`.
9. Send a small test prompt in the linked channel.

## Troubleshooting

### Slash command does not appear

- Confirm the bot was invited with `applications.commands`.
- Confirm `CORPUS_DISCORD_REGISTER_COMMANDS=true`.
- Prefer `CORPUS_DISCORD_GUILD_IDS` for instant guild command registration.
- Restart the bridge and check the `[discord] registered` log.

### Bot ignores normal messages

- Enable Message Content Intent in the Discord Developer Portal.
- Confirm the channel is linked with `/corpus status`.
- Confirm the sender has one of the allowed roles.
- If `CORPUS_DISCORD_REQUIRE_MENTION=true`, mention the bot in the message.

### Corpus says Studio is not connected

- Open Roblox Studio.
- Make sure the Corpus plugin is running.
- Confirm the plugin is polling the same deployed bridge URL.
- Re-run `/corpus connect session:<studio-token>` if the Studio token changed.

### Approval buttons stop working

- Buttons are in-memory and expire after 30 minutes.
- If the bridge restarted, ask Corpus to retry the action.

### Web app behavior changed

Discord should not affect the web app. Disable these env vars and restart:

```bash
CORPUS_DISCORD_ENABLED=false
DISCORD_BOT_TOKEN=
DISCORD_CLIENT_ID=
```

The React app and `/agent` routes remain independent.
