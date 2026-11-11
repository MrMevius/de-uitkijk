# Web: static Vite build served by the nginx edge, which also restricts access to go2rtc.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json VERSION CHANGELOG.md ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build --workspace=@uitkijk/web

FROM nginx:1.30-alpine
COPY --chmod=644 deploy/nginx/*.template /etc/nginx/templates/
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=server:3000 GO2RTC_UPSTREAM=go2rtc:1984
EXPOSE 8080 8081
