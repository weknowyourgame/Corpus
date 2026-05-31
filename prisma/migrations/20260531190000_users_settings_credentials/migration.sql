-- AlterTable
ALTER TABLE "agent_conversations" ADD COLUMN "user_id" UUID;

-- AlterTable
ALTER TABLE "studio_tokens" ADD COLUMN "user_id" UUID;

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT,
    "display_name" TEXT,
    "avatar_url" TEXT,
    "anonymous" BOOLEAN NOT NULL DEFAULT false,
    "user_secret_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "selected_tier" TEXT NOT NULL DEFAULT 'pro',
    "dev_mode" BOOLEAN NOT NULL DEFAULT false,
    "dev_model" TEXT NOT NULL DEFAULT '',
    "app_settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_credentials" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'default',
    "encrypted_secret" TEXT NOT NULL,
    "last_four" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "provider_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_anonymous_idx" ON "users"("anonymous");

-- CreateIndex
CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "user_settings_user_id_key" ON "user_settings"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "provider_credentials_user_id_provider_label_key" ON "provider_credentials"("user_id", "provider", "label");

-- CreateIndex
CREATE INDEX "provider_credentials_user_id_idx" ON "provider_credentials"("user_id");

-- CreateIndex
CREATE INDEX "provider_credentials_provider_idx" ON "provider_credentials"("provider");

-- CreateIndex
CREATE INDEX "provider_credentials_revoked_at_idx" ON "provider_credentials"("revoked_at");

-- CreateIndex
CREATE INDEX "agent_conversations_user_id_idx" ON "agent_conversations"("user_id");

-- CreateIndex
CREATE INDEX "studio_tokens_user_id_idx" ON "studio_tokens"("user_id");

-- AddForeignKey
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "studio_tokens" ADD CONSTRAINT "studio_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
