# Roblox Corpus Infrastructure

This folder contains the server-side infrastructure for Stud's open-source Roblox game knowledge base.

Current scope:

- Phase 0: v1 supports filesystem/Rojo-style source projects first.
- Phase 1: corpus config is disabled by default and safe without credentials.
- Phase 2: Prisma schema lives in `prisma/schema.prisma`; `schema.sql` is a SQL reference for the same corpus tables.
- Phase 3: Cloudflare R2 and Vectorize setup commands are generated from config.

## Environment

Copy the corpus section from `.env.example` into `.env` when you are ready to provision real resources.

Required for Prisma migrations:

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

Prisma is the source of truth for the corpus database because the same models will support ingestion, retrieval, server routes, and future UI/admin screens.

Install dependencies with Bun when registry access is healthy:

```bash
bun install
```

Generate the Prisma client:

```bash
bun run db:generate
```

Create/apply a local development migration:

```bash
bun run db:migrate -- --name corpus_init
```

Apply migrations in a deployed environment:

```bash
bun run db:migrate:deploy
```

Open Prisma Studio for DB inspection:

```bash
bun run db:studio
```

`server/agent/corpus/schema.sql` remains as a readable SQL reference and compatibility sketch, but do not edit it instead of `prisma/schema.prisma`.

## Workers Note

Do not use Hyperdrive for this plan.

For Cloudflare Workers later, use Prisma's JavaScript client engine with an edge-compatible Postgres path. This repo is set up for the driver-adapter direction (`@prisma/adapter-pg` + `pg`) without binding the design to Hyperdrive. If the Worker DB access becomes too heavy, keep Prisma in the Stud API server and let Workers call internal API routes for corpus jobs.

## Phase 3: Cloudflare Resources

Preview commands:

```bash
bun run corpus:cloudflare:setup
```

Execute commands with `wrangler` installed and authenticated:

```bash
bun run corpus:cloudflare:setup:execute
```

This creates:

- R2 bucket for raw and normalized Roblox game corpus files.
- Vectorize index for game summaries.
- Vectorize index for systems.
- Vectorize index for scripts.
- Vectorize index for patterns.

All Vectorize indexes use 768 dimensions and cosine distance for `@cf/baai/bge-base-en-v1.5`.
