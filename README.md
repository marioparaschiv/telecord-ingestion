# telecord-ingestion

Reference producers for the Telecord ingest protocol. A producer logs in as your own Telegram or Discord account, forwards a fixed set of raw events to a Telecord ingest server and answers a fixed set of requests from it. You run the producer; the server only ever sees what the producer sends.

- `producers/telegram`: an MTProto client on [mtcute](https://github.com/mtcute/mtcute).
- `producers/discord`: a gateway client on a fork of discord.js-selfbot-v13.
- `packages/producer-core`: the connection, delivery buffer, filter rules and request plumbing both share.
- `updater`: the sidecar that keeps the producer containers on signed releases.

The wire protocol is specified in `SPEC-telegram.md` and `SPEC-discord.md` inside the `@telecord/ingest-client` package.

## What the server can see

The server can read the history of every chat the producer shares with it. A chat is shared when it appears in a chat snapshot, which means your filter rules allow it. For a shared chat the server can page through past messages with `MESSAGES_FETCH` and download its media with `MEDIA_FETCH`, not just receive new events. If a chat must stay private, deny it in `FILTER_RULES`; a denied chat is left out of snapshots and every request for it is declined without calling Telegram or Discord.

## The fixed request set

The server cannot ask a producer to call arbitrary Telegram methods or Discord routes. It can only send these requests, and every one of them is checked against your filter rules before anything is called:

| Request              | Telegram | Discord | What it does                                                                                |
| -------------------- | -------- | ------- | ------------------------------------------------------------------------------------------- |
| `CHATS_FETCH`        | yes      | yes     | Lists the chats the account can see, after filtering. Sent on connect and every 30 minutes. |
| `MESSAGES_FETCH`     | yes      | yes     | Reads up to 100 messages from one chat, by id or as one page of history.                    |
| `MEDIA_FETCH`        | yes      | yes     | Downloads one file and uploads it to a presigned URL the server provides.                   |
| `ATTACHMENT_REFRESH` | no       | yes     | Re-signs one expired Discord CDN URL.                                                       |
| `PROBE`              | yes      | yes     | Echoes a token back. Does no work.                                                          |

Telegram `MEDIA_FETCH` only accepts document, photo and chat photo locations, and Discord `MEDIA_FETCH` only downloads from Discord CDN hosts. Anything else is refused without a call.

The forwarded events are fixed too: new, edited and deleted messages, reactions, and chat, channel, guild, role and own-membership changes. Nothing else your account receives is sent.

## Supported libraries

| Producer | Library                                                                                                                                         | Speaks                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Telegram | `@mtcute/node` 0.32.3                                                                                                                           | the TL layer it ships |
| Discord  | `discord.js-selfbot-v13`, pinned to commit `3e6baf2` of [marioparaschiv/FORK.Discord.Self](https://github.com/marioparaschiv/FORK.Discord.Self) | gateway API version 9 |

TDLib is not supported, and neither are the official apps. The protocol forwards raw TL payloads, and TDLib never exposes them. Other MTProto libraries that read and write raw TL (GramJS, Telethon, Pyrogram, gotd and others) can implement the protocol, but only mtcute ships here.

## Deployment

### Configuration

Each producer reads its configuration from the environment. The compose file loads `telegram.env` and `discord.env` from the same directory.

Both producers:

| Variable         | Required | Default    | Meaning                                                                    |
| ---------------- | -------- | ---------- | -------------------------------------------------------------------------- |
| `INGEST_URL`     | yes      |            | The ingest route, `wss://<host>/telegram/v1` or `wss://<host>/discord/v1`. |
| `INGEST_API_KEY` | yes      |            | The API key the operator issued for this account.                          |
| `FILTER_RULES`   | no       | DMs denied | A JSON list of ordered rules; the first rule that matches decides.         |
| `FILTER_DEFAULT` | no       | `allow`    | `allow` or `deny`, used when no rule matches.                              |

Telegram only:

| Variable            | Required | Default | Meaning                                                           |
| ------------------- | -------- | ------- | ----------------------------------------------------------------- |
| `TELEGRAM_API_ID`   | yes      |         | From [my.telegram.org](https://my.telegram.org).                  |
| `TELEGRAM_API_HASH` | yes      |         | From [my.telegram.org](https://my.telegram.org).                  |
| `DATA_DIR`          | no       | `/data` | Holds the SQLite session: auth keys, peer cache and update state. |

Discord only:

| Variable        | Required | Default | Meaning              |
| --------------- | -------- | ------- | -------------------- |
| `DISCORD_TOKEN` | yes      |         | The account's token. |

### Filters

Private chats are not shared unless you say so. The default rules are:

- Telegram: `[{"action":"deny","peerType":"user"}]`
- Discord: `[{"action":"deny","type":["dm","group_dm"]}]`

A rule is an `action` (`allow` or `deny`) plus any of the fields below; each field takes one value or a list, and every field a rule names must match.

- Telegram: `peerType` (`user`, `group`, `channel`), `peerId` (the marked id: a user as is, a basic group as `-<id>`, a channel as `-100<id>`), `update` (the update constructor).
- Discord: `type` (`dm`, `group_dm`, `guild`), `guildId`, `channelId`, `event` (the dispatch name).

For example, to share only one Telegram channel:

```sh
FILTER_RULES=[{"action":"allow","peerId":"-1001234567890"}]
FILTER_DEFAULT=deny
```

The same rules apply to forwarded events, chat snapshots and every request.

### Running with compose

1. Put `compose.yml` in a directory and create `telegram.env` and `discord.env` next to it.
2. Log in to Telegram once, interactively. The session is written to the `telegram-data` volume:

    ```sh
    docker compose run --rm telegram
    ```

    Answer the phone, code and 2FA prompts, wait for `Logged in to Telegram`, then stop it with Ctrl+C.

3. Start everything:

    ```sh
    docker compose up -d
    ```

Drop the `discord` or `telegram` service from `compose.yml` if you only run one.

### How the deployment is secured

The compose file runs both producers with:

- a non-root user (uid 1000) baked into the image;
- `read_only: true`, so the root filesystem cannot be written;
- `cap_drop: [ALL]`, so the process holds no Linux capabilities;
- `no-new-privileges`, so nothing inside can gain privileges through setuid binaries;
- `tmpfs: [/tmp]` for scratch space, cleared on restart;
- for Telegram, a named volume at `/data`, the only persistent writable path, holding the session. Discord keeps nothing and mounts no volume.

The images are built only by the release workflow (`.github/workflows/release.yml`), and only from a `telegram-v*`, `discord-v*` or `updater-v*` tag. Each image is:

- signed with [cosign](https://github.com/sigstore/cosign) keyless signing. The certificate names the workflow and tag that built it, and the signature is logged in the public Rekor transparency log;
- published with SLSA provenance (`mode=max`) describing how it was built;
- published with an SBOM listing its packages.

To check an image yourself before running it:

```sh
cosign verify ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest \
  --certificate-identity-regexp '^https://github\.com/marioparaschiv/telecord-ingestion/\.github/workflows/release\.yml@refs/tags/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Replace `telegram` with `discord` or `updater` for the other images. To read the provenance and SBOM:

```sh
docker buildx imagetools inspect ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest --format '{{ json .SBOM }}'
```

## Updates

### Why updates are needed

A producer that is never updated eventually stops working:

- **Telegram TL layer drift.** Telegram changes its API schema in numbered layers. The server accepts a window of layers that moves up as its decoder does. A producer on an old mtcute falls below the window and is refused with `4003 VERSION_UNSUPPORTED`; the `HELLO` frame warns ahead of time with `deprecation`.
- **Discord API version drift.** The server accepts gateway API versions 9 and 10 today. When Discord retires a version, or the server drops it, a producer still on it is refused the same way.
- **Ingest protocol versions.** The protocol itself is versioned (`/telegram/v1`, `/discord/v1`). New routes and changes to the request set ship in new `@telecord/ingest-client` releases.

### How the updater works

The `updater` service in `compose.yml` runs `updater/update.sh`:

1. Every `CHECK_INTERVAL` (default `24h`) it lists the running containers of its own compose project that carry the label `telecord-ingestion.autoupdate=true`. Nothing else is touched; the updater does not carry the label and does not update itself.
2. For each, it resolves the image tag (such as `:latest`) to a digest in the registry. If that digest is what the container runs, it moves on.
3. Otherwise it runs `cosign verify` on that exact digest, requiring a certificate issued to `https://github.com/marioparaschiv/telecord-ingestion/.github/workflows/release.yml@refs/tags/...` by GitHub's OIDC issuer.
4. If verification fails for any reason (no signature, wrong identity, registry error) it logs `REFUSED` and keeps the current container. The unverified image is never pulled, and the local tag is not moved.
5. If verification passes, it pulls the image by digest, waits `UPDATE_DELAY` (default `0`), points the local tag at the verified digest and recreates the service with `docker compose up -d --no-deps <service>`. The compose directory is mounted read-only at `/project`, so the new container gets the same configuration and volumes.

`CHECK_INTERVAL` and `UPDATE_DELAY` accept any duration `sleep` does, such as `30m`, `6h` or `1d`. Set them in a `.env` file next to `compose.yml`. A delay gives you time to notice a bad release before it reaches you.

To pin a producer to one release, set its `image:` to a digest (`...-telegram@sha256:...`); the updater skips digest-pinned images. To stop updates altogether, remove the label or the `updater` service.

Update the updater itself by hand:

```sh
docker compose pull updater && docker compose up -d updater
```

### The docker socket trade-off

The updater has to pull images and recreate containers, so it mounts `/var/run/docker.sock`. Access to that socket is equivalent to root on the host: anything that controls the updater controls the machine. It runs with the same read-only root, no capabilities and `no-new-privileges` as the producers, but that does not limit what the socket allows. It runs as root inside its container because the socket's group id differs between hosts.

If that is not acceptable, remove the `updater` service and update by hand: verify the new image with the `cosign verify` command above, then `docker compose pull && docker compose up -d`.

## Local development

Requires Node.js 24.14.1 or later within 24 and pnpm 12.

```sh
pnpm install
pnpm build          # producer-core and both producers
pnpm test           # the vitest suites
pnpm typecheck
pnpm lint
pnpm format:check
```

To run a producer against a local ingest server, build it and pass an env file; use a local `DATA_DIR` for the Telegram session:

```sh
pnpm build
DATA_DIR=./data node --env-file=telegram.env producers/telegram/dist/index.mjs
node --env-file=discord.env producers/discord/dist/index.mjs
```

To build an image locally, from the repository root:

```sh
docker build -f producers/telegram/Dockerfile -t telecord-ingestion-telegram .
docker build -f producers/discord/Dockerfile -t telecord-ingestion-discord .
docker build -t telecord-ingestion-updater updater
```
