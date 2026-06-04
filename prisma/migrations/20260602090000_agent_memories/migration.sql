CREATE TABLE "agent_memories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memories_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_memories_conversation_id_key_key" ON "agent_memories"("conversation_id", "key");
CREATE INDEX "agent_memories_conversation_id_idx" ON "agent_memories"("conversation_id");
CREATE INDEX "agent_memories_category_idx" ON "agent_memories"("category");

ALTER TABLE "agent_memories"
ADD CONSTRAINT "agent_memories_conversation_id_fkey"
FOREIGN KEY ("conversation_id") REFERENCES "agent_conversations"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
