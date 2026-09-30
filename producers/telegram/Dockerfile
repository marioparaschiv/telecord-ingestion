# syntax=docker/dockerfile:1

FROM node:24.14.1-slim AS build

# better-sqlite3 compiles from source when no prebuilt binary matches the platform.
RUN apt-get update \
	&& apt-get install --yes --no-install-recommends g++ make python3 \
	&& rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /repo
COPY . .
RUN pnpm --filter @telecord/telegram-producer... install --frozen-lockfile
RUN pnpm --filter @telecord/telegram-producer... run build
RUN pnpm --filter @telecord/telegram-producer deploy --prod /app

FROM node:24.14.1-slim

ENV NODE_ENV=production

WORKDIR /app
COPY --from=build /app .

# Writable by whichever HOST_UID compose runs the container as.
RUN install --directory --owner=node --group=node --mode=1777 /data
VOLUME /data

# The node user, numeric so runtimes that enforce non-root can check it.
USER 1000:1000

# Arguments select a mode, e.g. `docker compose run --rm telegram login`.
ENTRYPOINT ["node", "dist/index.mjs"]
