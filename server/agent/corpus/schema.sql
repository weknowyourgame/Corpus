-- SQL reference for the corpus tables.
-- Prisma is the source of truth: edit /prisma/schema.prisma first.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  source_url TEXT,
  license TEXT,
  license_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (license_status IN ('approved','unknown','blocked')),
  trust_level TEXT NOT NULL DEFAULT 'open_source'
    CHECK (trust_level IN ('live_project','curated','open_source','unknown')),
  genre TEXT,
  subgenres TEXT[] DEFAULT '{}',
  complexity TEXT CHECK (complexity IN ('beginner','intermediate','advanced')),
  player_mode TEXT CHECK (player_mode IN ('solo','multiplayer','both')),
  mechanics TEXT[] DEFAULT '{}',
  services TEXT[] DEFAULT '{}',
  frameworks TEXT[] DEFAULT '{}',
  script_count INTEGER DEFAULT 0,
  r2_prefix TEXT NOT NULL,
  summary_text TEXT,
  quality_score REAL DEFAULT 0.5,
  ingested_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  chunk_type TEXT NOT NULL CHECK (chunk_type IN ('summary','system','script','pattern')),
  vectorize_index TEXT NOT NULL,
  vectorize_id TEXT UNIQUE NOT NULL,
  r2_path TEXT NOT NULL,
  title TEXT,
  system_name TEXT,
  system_type TEXT,
  file_path TEXT,
  roblox_path TEXT,
  script_type TEXT CHECK (script_type IN ('server','client','module','shared','unknown')),
  line_start INTEGER,
  line_end INTEGER,
  line_count INTEGER,
  symbols TEXT[] DEFAULT '{}',
  required_modules TEXT[] DEFAULT '{}',
  remotes TEXT[] DEFAULT '{}',
  services TEXT[] DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  quality_score REAL DEFAULT 0.5,
  source_hash TEXT,
  duplicate_cluster_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patterns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern_name TEXT NOT NULL,
  category TEXT,
  difficulty TEXT CHECK (difficulty IN ('beginner','intermediate','advanced')),
  vectorize_id TEXT UNIQUE NOT NULL,
  r2_path TEXT NOT NULL,
  description TEXT,
  services TEXT[] DEFAULT '{}',
  appears_in_count INTEGER DEFAULT 0,
  quality_score REAL DEFAULT 0.5,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pattern_games (
  pattern_id UUID REFERENCES patterns(id) ON DELETE CASCADE,
  game_id UUID REFERENCES games(id) ON DELETE CASCADE,
  PRIMARY KEY (pattern_id, game_id)
);

CREATE INDEX IF NOT EXISTS idx_games_genre ON games(genre);
CREATE INDEX IF NOT EXISTS idx_games_mechanics ON games USING gin(mechanics);
CREATE INDEX IF NOT EXISTS idx_games_services ON games USING gin(services);
CREATE INDEX IF NOT EXISTS idx_chunks_game_id ON chunks(game_id);
CREATE INDEX IF NOT EXISTS idx_chunks_type ON chunks(chunk_type);
CREATE INDEX IF NOT EXISTS idx_chunks_vectorize_id ON chunks(vectorize_id);
CREATE INDEX IF NOT EXISTS idx_chunks_services ON chunks USING gin(services);
CREATE INDEX IF NOT EXISTS idx_chunks_symbols ON chunks USING gin(symbols);
CREATE INDEX IF NOT EXISTS idx_chunks_remotes ON chunks USING gin(remotes);
