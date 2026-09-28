# syntax=docker/dockerfile:1

FROM node:24.14.1-slim AS build

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo
COPY . .
RUN pnpm --filter @telecord/discord-producer... install --frozen-lockfile
RUN pnpm --filter @telecord/discord-producer... run build
RUN pnpm --filter @telecord/discord-producer deploy --prod /app

FROM node:24.14.1-slim

ENV NODE_ENV=production
ENV DATA_DIR=/data

WORKDIR /app
COPY --from=build /app .

RUN install --directory --owner=node --group=node /data
VOLUME /data

# The node user, numeric so runtimes that enforce non-root can check it.
USER 1000:1000

CMD ["node", "dist/index.mjs"]
