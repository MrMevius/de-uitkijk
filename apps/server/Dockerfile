# Backend: Node.js runs the TypeScript sources directly (type stripping), no build step.
FROM node:24-alpine
# ffmpeg re-wraps highlight clips for browsers (stream copy, no transcoding).
# Codex CLI (pinned) writes AI descriptions with the owner's ChatGPT sign-in; its login lives in /data/codex.
RUN apk add --no-cache ffmpeg && npm install -g @openai/codex@0.167.0 && npm cache clean --force
ENV CODEX_HOME=/data/codex
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
