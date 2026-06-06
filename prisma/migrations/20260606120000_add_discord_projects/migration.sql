-- CreateTable
CREATE TABLE "discord_projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "guild_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "owner_discord_id" TEXT NOT NULL,
    "conversation_id" UUID NOT NULL,
    "studio_session_id" TEXT NOT NULL,
    "last_run_id" TEXT,
    "disconnected_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "discord_projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "discord_projects_channel_id_key" ON "discord_projects"("channel_id");

-- CreateIndex
CREATE INDEX "discord_projects_guild_id_idx" ON "discord_projects"("guild_id");

-- CreateIndex
CREATE INDEX "discord_projects_owner_discord_id_idx" ON "discord_projects"("owner_discord_id");

-- CreateIndex
CREATE INDEX "discord_projects_conversation_id_idx" ON "discord_projects"("conversation_id");

-- CreateIndex
CREATE INDEX "discord_projects_studio_session_id_idx" ON "discord_projects"("studio_session_id");

-- CreateIndex
CREATE INDEX "discord_projects_disconnected_at_idx" ON "discord_projects"("disconnected_at");

-- AddForeignKey
ALTER TABLE "discord_projects" ADD CONSTRAINT "discord_projects_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
