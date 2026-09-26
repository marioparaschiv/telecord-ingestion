<div align="center">

<img src="./assets/logo.svg" width="120" alt="Telecord logo" />

<h1>Telecord Ingestion</h1>

<b>Connect your Telegram and Discord accounts to Telecord, on your own machine.</b>

A producer logs in as your account, sends the chats you choose to a Telecord server and answers a fixed set of requests. You run it, so the server only sees what it sends.

<br />

[![Telegram](https://img.shields.io/badge/telegram-mtcute-0b9981?style=for-the-badge&labelColor=0c0c0c)](#supported-libraries)
[![Discord](https://img.shields.io/badge/discord-selfbot-0b9981?style=for-the-badge&labelColor=0c0c0c)](#supported-libraries)
[![Images](https://img.shields.io/badge/images-cosign%20signed-0b9981?style=for-the-badge&labelColor=0c0c0c)](#security)
[![Node](https://img.shields.io/badge/node-24-0b9981?style=for-the-badge&labelColor=0c0c0c)](#local-development)

**[Quick start](#quick-start)** · [Filters](#filters) · [Updates](#updates) · [FAQ](#faq)

</div>

---

## At a glance

- **You choose what is shared.** Filter rules decide which chats the server sees. DMs are off by default.
- **The server can read history of shared chats**, not only new messages. Deny a chat to keep it out.
- **The request set is fixed.** A short list of request types, all checked against your filters. No arbitrary API calls.
- **Images are signed and locked down.** Non-root, read-only, no capabilities, built only by the release workflow.
- **Updates are automatic and verified.** The updater only swaps to images whose signature checks out.

## Contents

1. [Quick start](#quick-start)
2. [What the server can see](#what-the-server-can-see)
3. [Filters](#filters)
4. [Configuration](#configuration)
5. [Security](#security)
6. [Updates](#updates)
7. [Supported libraries](#supported-libraries)
8. [FAQ](#faq)
9. [Local development](#local-development)

## Quick start

1. Put `compose.yml` in a directory.
2. Create `telegram.env` and `discord.env` next to it (see [Configuration](#configuration)).
3. Log in to Telegram once. Answer the phone, code and 2FA prompts, wait for `Logged in to Telegram`, then press Ctrl+C:

    ```sh
    docker compose run --rm telegram
    ```

4. Start everything:

    ```sh
    docker compose up -d
    ```

Only running one platform? Delete the other service from `compose.yml`.

## What the server can see

A chat is shared when your filter rules allow it. For a shared chat, the server can:

- receive new, edited and deleted messages, reactions, and chat, channel, guild, role and own-membership changes;
- page through past messages;
- download its media.

Nothing else your account receives is sent. A denied chat is left out entirely, and any request for it is declined without calling Telegram or Discord.

### The fixed request set

These are the only requests the server can send:

| Request              | Telegram | Discord | What it does                                                                                |
| -------------------- | -------- | ------- | ------------------------------------------------------------------------------------------- |
| `CHATS_FETCH`        | yes      | yes     | Lists the chats the account can see, after filtering. Sent on connect and every 30 minutes. |
| `MESSAGES_FETCH`     | yes      | yes     | Reads up to 100 messages from one chat, by id or as one page of history.                    |
| `MEDIA_FETCH`        | yes      | yes     | Downloads one file and uploads it to a presigned URL the server provides.                   |
| `ATTACHMENT_REFRESH` | no       | yes     | Re-signs one expired Discord CDN URL.                                                       |
| `PROBE`              | yes      | yes     | Checks the producer is connected and responding.                                            |

Telegram `MEDIA_FETCH` only accepts document, photo and chat photo locations. Discord `MEDIA_FETCH` only downloads from Discord CDN hosts. Anything else is refused.

The wire protocol is specified in `SPEC-telegram.md` and `SPEC-discord.md` inside the `@telecord/ingest-client` package.

## Filters

Default rules keep private chats out:

- Telegram: `[{"action":"deny","peerType":"user"}]`
- Discord: `[{"action":"deny","type":["dm","group_dm"]}]`

How rules work:

1. Rules are checked in order. The first match decides.
2. A rule is an `action` (`allow` or `deny`) plus fields to match. Each field takes one value or a list.
3. If nothing matches, `FILTER_DEFAULT` decides (`allow` unless you change it).
4. The same rules apply to events, chat lists and every request.

Fields you can match on:

- **Telegram:** `peerType` (`user`, `group`, `channel`), `peerId`, `update` (the update constructor). `peerId` is the marked id: a user as is, a basic group as `-<id>`, a channel as `-100<id>`.
- **Discord:** `type` (`dm`, `group_dm`, `guild`), `guildId`, `channelId`, `event` (the dispatch name).

Example, share only one Telegram channel:

```sh
FILTER_RULES=[{"action":"allow","peerId":"-1001234567890"}]
FILTER_DEFAULT=deny
```

## Configuration

Both producers:

| Variable         | Required | Default    | Meaning                                                                    |
| ---------------- | -------- | ---------- | -------------------------------------------------------------------------- |
| `INGEST_URL`     | yes      |            | The ingest route, `wss://<host>/telegram/v1` or `wss://<host>/discord/v1`. |
| `INGEST_API_KEY` | yes      |            | The API key the operator issued for this account.                          |
| `FILTER_RULES`   | no       | DMs denied | A JSON list of ordered rules. See [Filters](#filters).                     |
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

Updater (set in a `.env` file next to `compose.yml`):

| Variable         | Default | Meaning                                                           |
| ---------------- | ------- | ----------------------------------------------------------------- |
| `CHECK_INTERVAL` | `24h`   | How often to look for a new release. Any `sleep` duration works.  |
| `UPDATE_DELAY`   | `0`     | How long to wait after a verified release before switching to it. |

## Security

### Containers

Both producers run with:

- a non-root user (uid 1000);
- a read-only root filesystem;
- no Linux capabilities, and `no-new-privileges`;
- `tmpfs` at `/tmp`, cleared on restart;
- for Telegram only, a `/data` volume holding the session. Discord stores nothing.

### Images

Images are built only by `.github/workflows/release.yml`, only from a `telegram-v*`, `discord-v*` or `updater-v*` tag. Each image is:

- signed with [cosign](https://github.com/sigstore/cosign) keyless signing, logged in the public Rekor transparency log;
- published with SLSA provenance describing how it was built;
- published with an SBOM listing its packages.

Check an image yourself (swap `telegram` for `discord` or `updater`):

```sh
cosign verify ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest \
  --certificate-identity-regexp '^https://github\.com/marioparaschiv/telecord-ingestion/\.github/workflows/release\.yml@refs/tags/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Read the provenance and SBOM:

```sh
docker buildx imagetools inspect ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest --format '{{ json .SBOM }}'
```

## Updates

### Why they matter

A producer that is never updated stops working:

- **Telegram layers.** Telegram versions its API in numbered layers. The server accepts a moving window of layers; fall below it and the connection is refused (`4003 VERSION_UNSUPPORTED`). The server warns ahead of time.
- **Discord API versions.** The server accepts gateway versions 9 and 10 today. Retired versions get refused the same way.
- **Protocol versions.** New protocol routes ship in new `@telecord/ingest-client` releases.

### How the updater works

Every `CHECK_INTERVAL`, `updater/update.sh`:

1. Finds running containers in its compose project labelled `telecord-ingestion.autoupdate=true`.
2. Looks up the latest image digest. If nothing changed, it stops there.
3. Runs `cosign verify` on that digest, requiring the release workflow's signature.
4. **If verification fails**, logs `REFUSED` and leaves the container alone. The image is never pulled.
5. **If it passes**, pulls the image, waits `UPDATE_DELAY`, and recreates the service with the same config and volumes.

Control it:

- **Pin a release:** set `image:` to a digest (`...-telegram@sha256:...`). Pinned images are skipped.
- **Turn it off:** remove the label or the `updater` service.
- **Update the updater itself:** `docker compose pull updater && docker compose up -d updater`.

### The docker socket trade-off

The updater mounts `/var/run/docker.sock` to pull images and recreate containers. That socket is equivalent to root on the host. The updater runs locked down like the producers, but that does not limit what the socket allows.

If that is not acceptable, remove the `updater` service and update by hand: run the `cosign verify` command above, then `docker compose pull && docker compose up -d`.

## Supported libraries

| Producer | Library                                                                                                                                         | Speaks                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Telegram | `@mtcute/node` 0.32.3                                                                                                                           | the TL layer it ships |
| Discord  | `discord.js-selfbot-v13`, pinned to commit `3e6baf2` of [marioparaschiv/FORK.Discord.Self](https://github.com/marioparaschiv/FORK.Discord.Self) | gateway API version 9 |

TDLib and the official apps are not supported: the protocol sends raw TL payloads, and TDLib never exposes them. Other MTProto libraries that handle raw TL (GramJS, Telethon, Pyrogram, gotd) could implement the protocol, but only mtcute ships here.

## FAQ

**Which of my chats does the server get?**
Only the ones your filter rules allow. DMs are off by default. See [Filters](#filters).

**Can the server read old messages?**
Yes, for shared chats. It can page through history and download media. Deny a chat to keep it out completely.

**Do I have to run both producers?**
No. Delete the service you don't need from `compose.yml`.

**What if I don't update?**
It keeps working until the server stops accepting your Telegram layer or Discord API version, then the connection is refused.

**Can I turn off automatic updates?**
Yes. Remove the `updater` service, or pin the image to a digest. See [Updates](#updates).

**Why not TDLib?**
TDLib never exposes the raw TL payloads the protocol forwards.

## Local development

Requires Node.js 24 (24.14.1 or later) and pnpm 12.

```sh
pnpm install
pnpm build          # producer-core and both producers
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Run a producer against a local ingest server:

```sh
DATA_DIR=./data node --env-file=telegram.env producers/telegram/dist/index.mjs
node --env-file=discord.env producers/discord/dist/index.mjs
```

Build the images locally, from the repository root:

```sh
docker build -f producers/telegram/Dockerfile -t telecord-ingestion-telegram .
docker build -f producers/discord/Dockerfile -t telecord-ingestion-discord .
docker build -t telecord-ingestion-updater updater
```
