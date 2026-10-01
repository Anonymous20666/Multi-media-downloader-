# Pappy controller: grammY ingress + throttled sender + health server.
# Needs ffmpeg (0.8.0 ID3/artwork tagging) and yt-dlp on PATH (engine
# auto-fallback when a platform bot-gates datacenter IPs). Runs as the
# unprivileged `node` user; job dirs live in the container tmpfs.
FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && pip install --no-cache-dir --break-system-packages "yt-dlp" \
  && yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/controller/package.json apps/controller/
COPY packages/media-manifest/package.json packages/media-manifest/
RUN npm ci --workspaces --include-workspace-root
COPY apps/controller/ apps/controller/
COPY packages/media-manifest/ packages/media-manifest/
RUN npm run build -w @pappy/media-manifest && npm run build -w @pappy/controller

ENV NODE_ENV=production
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/controller/dist/index.js"]
