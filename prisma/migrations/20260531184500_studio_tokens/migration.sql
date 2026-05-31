-- CreateTable
CREATE TABLE "studio_tokens" (
    "token_hash" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "studio_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- CreateIndex
CREATE INDEX "studio_tokens_session_id_idx" ON "studio_tokens"("session_id");

-- CreateIndex
CREATE INDEX "studio_tokens_revoked_at_idx" ON "studio_tokens"("revoked_at");
