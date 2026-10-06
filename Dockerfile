# ── Build stage ───────────────────────────────────────────────────────────
# better-sqlite3 is a native addon, so the build stage needs a toolchain to
# compile it. The runtime stage then carries only the compiled result.
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Build tools required to compile better-sqlite3.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Copy pre-built node_modules (including the compiled native addon) and source.
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

# Default data location; mounted from a PVC in Kubernetes.
ENV DATABASE_PATH=/data/world-cup-ladder.db
ENV PORT=8080
RUN mkdir -p /data

# Run as the built-in unprivileged node user.
RUN chown -R node:node /app /data
USER node

EXPOSE 8080

CMD ["node", "src/server.js"]
