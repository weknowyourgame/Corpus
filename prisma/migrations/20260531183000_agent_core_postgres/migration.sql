-- CreateTable
CREATE TABLE "agent_conversations" (
    "id" UUID NOT NULL,
    "studio_session_id" TEXT NOT NULL,
    "access_token_hash" TEXT,
    "next_sequence" INTEGER NOT NULL DEFAULT 1,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "runs" JSONB NOT NULL DEFAULT '[]',
    "approved_scopes" JSONB NOT NULL DEFAULT '[]',
    "audit_events" JSONB NOT NULL DEFAULT '[]',
    "pending_approvals" JSONB NOT NULL DEFAULT '[]',
    "pending_interactions" JSONB NOT NULL DEFAULT '[]',
    "proposed_plan" JSONB,
    "approved_plan" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "timestamp" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_conversations_studio_session_id_idx" ON "agent_conversations"("studio_session_id");

-- CreateIndex
CREATE INDEX "agent_conversations_updated_at_idx" ON "agent_conversations"("updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_events_conversation_id_sequence_key" ON "agent_events"("conversation_id", "sequence");

-- CreateIndex
CREATE INDEX "agent_events_conversation_id_idx" ON "agent_events"("conversation_id");

-- CreateIndex
CREATE INDEX "agent_events_run_id_idx" ON "agent_events"("run_id");

-- CreateIndex
CREATE INDEX "agent_events_type_idx" ON "agent_events"("type");

-- AddForeignKey
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
