# whatsarr — WhatsApp request bot for Plex via Seerr
# Runs the TypeScript app directly via tsx (no build step).
FROM node:22-bookworm-slim

# better-sqlite3 builds a native addon at install time — needs toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for layer caching. tsx + typescript are needed at runtime
# (the app is run via tsx), so do NOT use --omit=dev here.
COPY package.json package-lock.json ./
RUN npm ci

# App source (routing.config.json + .env + the data/auth dirs come in at runtime
# via bind mounts / volumes — see docker-compose.yml and .dockerignore).
COPY . .

ENV NODE_ENV=production
# sqlite DB + WhatsApp session persist across restarts.
VOLUME ["/app/data", "/app/auth_info_baileys"]

# Dashboard + Seerr "media ready" webhook (override with WEBHOOK_PORT).
EXPOSE 5056

CMD ["npm", "start"]
