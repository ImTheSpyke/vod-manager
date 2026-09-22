FROM node:20-bookworm-slim

# ffmpeg is required by yt-dlp to merge separate video/audio streams (needed
# for max-quality 1080p60 Twitch VODs, which are served as split streams).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (does the actual Twitch VOD downloading: format selection,
# fragment retries, resuming, etc). Installed via pip so it's easy to upgrade.
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig*.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

RUN mkdir -p /app/downloads /app/config /app/data

ENV NODE_ENV=production
ENV DOWNLOAD_DIR=/app/downloads
ENV SETTINGS_PATH=/app/config/settings.json
ENV JOBS_PATH=/app/data/jobs.json

EXPOSE 3000

CMD ["node", "dist/server/index.js"]
