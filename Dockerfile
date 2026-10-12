# Corpus bridge + built web UI as one always-on process (sessions live in memory).
FROM oven/bun:1.2
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bunx prisma generate
# Same-origin: the UI talks to the bridge on the host that served it.
ENV VITE_BRIDGE_URL=""
RUN bun run build
ENV NODE_ENV=production
EXPOSE 7860
CMD ["sh", "-c", "bunx prisma migrate deploy && PORT=${PORT:-7860} bun server/index.js"]
