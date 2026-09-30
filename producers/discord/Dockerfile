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

WORKDIR /app
COPY --from=build /app .

# Writable by whichever HOST_UID compose runs the container as.
RUN install --directory --owner=node --group=node --mode=1777 /data
VOLUME /data

# The node user, numeric so runtimes that enforce non-root can check it.
USER 1000:1000

# Arguments select a mode, e.g. `docker compose run --rm discord list-chats`.
ENTRYPOINT ["node", "dist/index.mjs"]
