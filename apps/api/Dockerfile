# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace manifests so npm ci can resolve workspace deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/package.json
COPY apps/api/package.json         ./apps/api/package.json

# Install all workspace dependencies (dev deps needed for tsc)
RUN npm ci

# Copy source code
COPY packages/shared ./packages/shared
COPY apps/api        ./apps/api

# Compile TypeScript → dist/
RUN npm run build --workspace=apps/api

# ─── Stage 2: Production runtime ──────────────────────────────────────────────
FROM node:20-alpine AS runner

WORKDIR /app/apps/api

ENV NODE_ENV=production

# Copy compiled output
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=builder /app/apps/api/package.json ./package.json

# SQL migration files are plain text — tsc does NOT copy them into dist/.
# Copy them to the exact path that dist/db/migrate.js resolves at runtime:
#   path.join(__dirname, "migrations")  →  dist/db/migrations/
COPY --from=builder /app/apps/api/src/db/migrations ./dist/db/migrations

# Copy the full workspace node_modules (includes hoisted production deps)
COPY --from=builder /app/node_modules /app/node_modules

# Copy shared package (needed for any runtime type resolution via workspace symlink)
COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/package.json /app/package.json

# Run migrations then start the server
EXPOSE 4000

CMD ["node", "dist/index.js"]
