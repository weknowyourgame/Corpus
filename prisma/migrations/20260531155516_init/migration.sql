-- CreateEnum
CREATE TYPE "ChunkType" AS ENUM ('summary', 'system', 'script');

-- CreateEnum
CREATE TYPE "ScriptType" AS ENUM ('server', 'client', 'module', 'shared', 'unknown');

-- CreateTable
CREATE TABLE "games" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "subniches" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mechanics" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "script_count" INTEGER NOT NULL DEFAULT 0,
    "r2_prefix" TEXT NOT NULL,
    "summary_text" TEXT,
    "quality_score" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "ingested" BOOLEAN NOT NULL DEFAULT false,
    "ingested_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chunks" (
    "id" UUID NOT NULL,
    "game_id" UUID NOT NULL,
    "chunk_type" "ChunkType" NOT NULL,
    "vectorize_index" TEXT NOT NULL,
    "vectorize_id" TEXT NOT NULL,
    "r2_path" TEXT NOT NULL,
    "title" TEXT,
    "system_name" TEXT,
    "file_path" TEXT,
    "roblox_path" TEXT,
    "script_type" "ScriptType",
    "line_start" INTEGER,
    "line_end" INTEGER,
    "symbols" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "required_modules" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "remotes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "services" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "quality_score" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "source_hash" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chunks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "games_slug_key" ON "games"("slug");

-- CreateIndex
CREATE INDEX "games_niche_idx" ON "games"("niche");

-- CreateIndex
CREATE INDEX "games_mechanics_idx" ON "games" USING GIN ("mechanics");

-- CreateIndex
CREATE INDEX "games_services_idx" ON "games" USING GIN ("services");

-- CreateIndex
CREATE UNIQUE INDEX "chunks_vectorize_id_key" ON "chunks"("vectorize_id");

-- CreateIndex
CREATE INDEX "chunks_game_id_idx" ON "chunks"("game_id");

-- CreateIndex
CREATE INDEX "chunks_vectorize_index_idx" ON "chunks"("vectorize_index");

-- CreateIndex
CREATE INDEX "chunks_vectorize_id_idx" ON "chunks"("vectorize_id");

-- CreateIndex
CREATE INDEX "chunks_services_idx" ON "chunks" USING GIN ("services");

-- CreateIndex
CREATE INDEX "chunks_symbols_idx" ON "chunks" USING GIN ("symbols");

-- CreateIndex
CREATE INDEX "chunks_remotes_idx" ON "chunks" USING GIN ("remotes");

-- AddForeignKey
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_game_id_fkey" FOREIGN KEY ("game_id") REFERENCES "games"("id") ON DELETE CASCADE ON UPDATE CASCADE;
