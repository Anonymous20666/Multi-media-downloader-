FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/controller/package.json apps/controller/
COPY packages/media-manifest/package.json packages/media-manifest/
RUN npm ci --workspaces --include-workspace-root
COPY apps/controller/ apps/controller/
COPY packages/media-manifest/ packages/media-manifest/
RUN npm run build -w @pappy/media-manifest && npm run build -w @pappy/controller
ENV NODE_ENV=production
CMD ["node", "apps/controller/dist/index.js"]
