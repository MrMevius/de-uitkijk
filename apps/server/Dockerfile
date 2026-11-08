# Backend: Node.js runs the TypeScript sources directly (type stripping), no build step.
FROM node:24-alpine
# ffmpeg re-wraps highlight clips for browsers (stream copy, no transcoding).
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --workspace=@uitkijk/server --no-audit --no-fund && npm cache clean --force
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY config config
# Build contexts may have private directory modes (deployctl unpacks releases with umask 077).
RUN chmod -R a+rX packages apps config && mkdir /data && chown node:node /data
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "apps/server/src/index.ts"]
