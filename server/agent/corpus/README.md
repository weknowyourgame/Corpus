# Roblox Corpus Infrastructure

This folder contains the server-side infrastructure for Stud's open-source Roblox game knowledge base.

Current scope:

- Phase 0: v1 supports filesystem/Rojo-style source projects first.
- Phase 1: corpus config is disabled by default and safe without credentials.
- Phase 2: Postgres schema lives in `schema.sql`.
- Phase 3: Cloudflare R2 and Vectorize setup commands are generated from config.

## Environment

Copy the corpus section from `.env.example` into `.env` when you are ready to provision real resources.

Required for migrations:

```text
DATABASE_URL=
```

Required for Cloudflare setup and later ingestion:

```text
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_R2_BUCKET=roblox-games
CLOUDFLARE_VECTORIZE_GAME_INDEX=roblox-game-summaries
CLOUDFLARE_VECTORIZE_SYSTEM_INDEX=roblox-systems
CLOUDFLARE_VECTORIZE_SCRIPT_INDEX=roblox-scripts
CLOUDFLARE_VECTORIZE_PATTERN_INDEX=roblox-patterns
```

## Phase 2: Database Schema

Preview the schema:

```bash
cat server/agent/corpus/schema.sql
```

Apply it with `psql` installed:

```bash
npm run corpus:migrate
```

The migration is idempotent through `IF NOT EXISTS`, so it can be rerun during early development.

## Phase 3: Cloudflare Resources

Preview commands:

```bash
npm run corpus:cloudflare:setup
```

Execute commands with `wrangler` installed and authenticated:

```bash
npm run corpus:cloudflare:setup:execute
```

This creates:

- R2 bucket for raw and normalized Roblox game corpus files.
- Vectorize index for game summaries.
- Vectorize index for systems.
- Vectorize index for scripts.
- Vectorize index for patterns.

All Vectorize indexes use 768 dimensions and cosine distance for `@cf/baai/bge-base-en-v1.5`.
