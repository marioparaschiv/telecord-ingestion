<div align="center">

<img src="./assets/logo.svg" width="120" alt="Telecord logo" />

<h1>Telecord Ingestion</h1>

<b>Connect your Telegram and Discord accounts to Telecord, on your own machine.</b>

A producer logs in as your account and sends the chats you choose to a Telecord server. You run it, so the server only sees what it sends.

<br />

[![Telegram](https://img.shields.io/badge/Telegram-0b9981?style=for-the-badge&logo=telegram&logoColor=white)](#supported-libraries)
[![Discord](https://img.shields.io/badge/Discord-0b9981?style=for-the-badge&logo=discord&logoColor=white)](#supported-libraries)
[![TypeScript](https://img.shields.io/badge/TypeScript-0b9981?style=for-the-badge&logo=typescript&logoColor=white)](#local-development)
[![Docker](https://img.shields.io/badge/Docker-0b9981?style=for-the-badge&logo=docker&logoColor=white)](#quick-start)

**[Quick start](#quick-start)** · [Filters](#filters) · [Updates](#updates) · [FAQ](#faq)

</div>

---

## At a glance

- **You choose what is shared.** Filter rules pick the chats. DMs are off by default.
- **Shared chats include their history.** The server can read past messages, not only new ones.
- **The server can only ask for a few things.** Every request is checked against your filters.
- **Images are signed and locked down.** Non-root, read-only, built only from release tags.
- **Updates install themselves**, but only after the signature checks out.

## Contents

**Set up**

1. [Quick start](#quick-start)
2. [Filters](#filters)
3. [Configuration](#configuration)
4. [FAQ](#faq)

**How it works**

5. [What the server can see](#what-the-server-can-see)
6. [Updates](#updates)
7. [Security](#security)
8. [Supported libraries](#supported-libraries)
9. [Local development](#local-development)

---

## Quick start

```sh
curl -fsSL https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.sh | sh
```

Takes about 5 minutes. You need Docker and a Telecord API key for each account.

The installer asks which platforms to run and your credentials, then logs you in to Telegram and starts everything. Settings go in `~/telecord-ingestion` unless you pick another directory.

Check it worked: `docker compose ps` in that directory shows each service as `running`.

### Manual setup

1. Copy `compose.yml` from this repo into an empty directory.
2. Create `.env` next to it, listing the services to run:

    ```sh
    COMPOSE_PROFILES=telegram,discord,updater
    ```

3. Create `telegram.env`:

    ```sh
    INGEST_URL=wss://ingest.telecord.app/telegram/v1
    INGEST_API_KEY=<your key>
    TELEGRAM_API_ID=<from my.telegram.org>
    TELEGRAM_API_HASH=<from my.telegram.org>
    ```

4. Create `discord.env`:

    ```sh
    INGEST_URL=wss://ingest.telecord.app/discord/v1
    INGEST_API_KEY=<your key>
    DISCORD_TOKEN=<your account token>
    ```

5. Log in to Telegram once. Answer the phone, code and 2FA prompts. When you see `Logged in to Telegram`, press Ctrl+C.

    ```sh
    docker compose run --rm telegram
    ```

6. Start everything:

    ```sh
    docker compose up -d
    ```

Only using one platform? Leave the other out of `COMPOSE_PROFILES` and skip its env file.

## Filters

Filters decide which chats the server gets. Add them to the env file.

### Recipes

Share only one Telegram channel:

```sh
FILTER_RULES=[{"action":"allow","peerId":"-1001234567890"}]
FILTER_DEFAULT=deny
```

Hide one Discord server, keep DMs hidden:

```sh
FILTER_RULES=[{"action":"deny","type":["dm","group_dm"]},{"action":"deny","guildId":"123456789012345678"}]
```

Hide one Telegram group, keep DMs hidden:

```sh
FILTER_RULES=[{"action":"deny","peerType":"user"},{"action":"deny","peerId":"-123456789"}]
```

> **Setting `FILTER_RULES` replaces the defaults.** Keep the DM rule in your list, as the recipes above do, or DMs are shared.

### How rules work

1. Rules are checked top to bottom. The first match wins.
2. A rule is an `action` (`allow` or `deny`) plus fields to match.
3. Each field takes one value or a list. Every field in a rule must match.
4. No match? `FILTER_DEFAULT` decides. It is `allow` unless you set it.
5. The same rules cover new events, chat lists and every request.

### Fields

| Platform | Field       | Values                                                                      |
| -------- | ----------- | --------------------------------------------------------------------------- |
| Telegram | `peerType`  | `user`, `group`, `channel`                                                  |
| Telegram | `peerId`    | User id as is. Basic group as `-<id>`. Channel or supergroup as `-100<id>`. |
| Telegram | `update`    | An update constructor name                                                  |
| Discord  | `type`      | `dm`, `group_dm`, `guild`                                                   |
| Discord  | `guildId`   | A server id                                                                 |
| Discord  | `channelId` | A channel id                                                                |
| Discord  | `event`     | A gateway dispatch name                                                     |

### Defaults

- Telegram: `[{"action":"deny","peerType":"user"}]`
- Discord: `[{"action":"deny","type":["dm","group_dm"]}]`

## Configuration

### Both producers

| Variable         | Required | Default    | Meaning                                                                           |
| ---------------- | -------- | ---------- | --------------------------------------------------------------------------------- |
| `INGEST_URL`     | yes      |            | `wss://ingest.telecord.app/telegram/v1` or `wss://ingest.telecord.app/discord/v1` |
| `INGEST_API_KEY` | yes      |            | Your Telecord API key for this account                                            |
| `FILTER_RULES`   | no       | DMs denied | Ordered JSON rule list. See [Filters](#filters).                                  |
| `FILTER_DEFAULT` | no       | `allow`    | `allow` or `deny`, used when no rule matches                                      |

### Telegram

| Variable            | Required | Default | Meaning                                           |
| ------------------- | -------- | ------- | ------------------------------------------------- |
| `TELEGRAM_API_ID`   | yes      |         | From [my.telegram.org](https://my.telegram.org)   |
| `TELEGRAM_API_HASH` | yes      |         | From [my.telegram.org](https://my.telegram.org)   |
| `DATA_DIR`          | no       | `/data` | Where the login session and peer cache are stored |

### Discord

| Variable        | Required | Default | Meaning             |
| --------------- | -------- | ------- | ------------------- |
| `DISCORD_TOKEN` | yes      |         | The account's token |

### Updater

Set these in a `.env` file next to `compose.yml`.

| Variable         | Default | Meaning                                                 |
| ---------------- | ------- | ------------------------------------------------------- |
| `CHECK_INTERVAL` | `24h`   | How often to check for a release, such as `30m` or `6h` |
| `UPDATE_DELAY`   | `0`     | How long to wait before switching to a verified release |

## FAQ

### Which of my chats does the server get?

Only the ones your filters allow. DMs are off by default. See [Filters](#filters).

### Can the server read old messages?

Yes, for shared chats. It can page through history and download media. Deny a chat to keep it out completely.

### I set `FILTER_RULES` and now my DMs are shared. Why?

Your rules replace the defaults. Add the DM rule back as the first rule. See [Recipes](#recipes).

### Do I have to run both producers?

No. The installer asks which ones you want. For a manual setup, list only the ones you need in `COMPOSE_PROFILES`.

### How do I see what it's doing?

```sh
docker compose logs -f telegram
```

### Where is my Telegram login stored?

In the `telegram-data` Docker volume. It survives restarts and updates. Delete the volume to start over with a fresh login.

### What if I don't update?

It keeps working until the server stops accepting your Telegram layer or Discord API version. Then the connection is refused.

### Can I turn off automatic updates?

Yes. Answer no in the installer, remove `updater` from `COMPOSE_PROFILES`, or pin the image to a digest. See [Controlling updates](#controlling-updates).

### Why not TDLib?

TDLib never exposes the raw payloads the protocol forwards.

---

## What the server can see

For each shared chat, the server receives:

- new, edited and deleted messages;
- reactions;
- chat, channel, server and role changes, and changes to your own membership.

Nothing else your account receives is sent. A denied chat is left out entirely.

### What the server can ask for

These are the only requests. Each is checked against your filters first; a request for a denied chat is declined without calling Telegram or Discord.

| Request              | Telegram | Discord | What it does                                                   |
| -------------------- | -------- | ------- | -------------------------------------------------------------- |
| `CHATS_FETCH`        | yes      | yes     | Lists your shared chats. Sent on connect and every 30 minutes. |
| `MESSAGES_FETCH`     | yes      | yes     | Reads up to 100 messages from one chat.                        |
| `MEDIA_FETCH`        | yes      | yes     | Downloads one file and uploads it to the server.               |
| `ATTACHMENT_REFRESH` | no       | yes     | Renews one expired Discord attachment link.                    |
| `PROBE`              | yes      | yes     | Checks the producer is connected and responding.               |

`MEDIA_FETCH` is limited: Telegram accepts only documents, photos and chat photos, and Discord downloads only from Discord's CDN.

The full protocol is in `SPEC-telegram.md` and `SPEC-discord.md` inside the `@telecord/ingest-client` package.

## Updates

### Why updates matter

A producer that never updates stops working eventually:

- **Telegram** changes its API in numbered layers. The server accepts a moving window of them. Fall behind and the connection is refused (`4003 VERSION_UNSUPPORTED`). The server warns before that happens.
- **Discord** retires gateway API versions. The server accepts 9 and 10 today.
- **The protocol** gets new versions through `@telecord/ingest-client` releases.

### How the updater works

Once every `CHECK_INTERVAL` (default 24 hours), the updater:

1. Finds running containers in its compose project labelled `telecord-ingestion.autoupdate=true`.
2. Checks the registry for a newer image. None? It stops here.
3. Verifies the new image was signed by this repo's release workflow.
4. **Verification fails:** it logs `REFUSED` and changes nothing. The image is never downloaded.
5. **Verification passes:** it downloads the image, waits `UPDATE_DELAY`, then restarts the service with the same config and volumes.

The updater carries the label too, so it updates itself the same way, after the other services.

### Controlling updates

- **Delay rollout:** set `UPDATE_DELAY`, such as `2d`, to give yourself time to hear about a bad release.
- **Pin a release:** set the service's `image:` to a digest (`...-telegram@sha256:...`). Pinned images are skipped.
- **Turn it off:** remove `updater` from `COMPOSE_PROFILES` in `.env`, or the label from a service.

### The Docker socket

The updater needs `/var/run/docker.sock` to download images and restart containers. Access to that socket equals root on the host, however locked down the container is.

Rather not grant that? Remove `updater` from `COMPOSE_PROFILES` and update by hand:

1. Verify the new image (see [Verify an image](#verify-an-image)).
2. Run `docker compose pull && docker compose up -d`.

## Security

### Containers

Both producers run:

- as a non-root user (uid 1000);
- with a read-only filesystem;
- with no Linux capabilities and `no-new-privileges`;
- with a `/tmp` that is cleared on restart.

Telegram also gets a `/data` volume for its login session. Discord stores nothing.

### Images

Images are built only by `.github/workflows/release.yml`, and only from `telegram-v*`, `discord-v*` or `updater-v*` tags. Each one ships with:

- a [cosign](https://github.com/sigstore/cosign) signature, recorded in the public Rekor log;
- SLSA provenance describing how it was built;
- an SBOM listing its packages.

### Verify an image

Swap `telegram` for `discord` or `updater` to check the others.

```sh
cosign verify ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest \
  --certificate-identity-regexp '^https://github\.com/marioparaschiv/telecord-ingestion/\.github/workflows/release\.yml@refs/tags/.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Read its provenance and SBOM:

```sh
docker buildx imagetools inspect ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest --format '{{ json .Provenance }}'
docker buildx imagetools inspect ghcr.io/marioparaschiv/telecord-ingestion-telegram:latest --format '{{ json .SBOM }}'
```

## Supported libraries

| Producer | Library                                                                                                                   | Speaks                |
| -------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Telegram | [mtcute](https://github.com/mtcute/mtcute) 0.32.3                                                                         | TL layer 229          |
| Discord  | `discord.js-selfbot-v13` via [FORK.Discord.Self](https://github.com/marioparaschiv/FORK.Discord.Self) at commit `3e6baf2` | Gateway API version 9 |

TDLib and the official apps are not supported, because they never expose raw TL payloads. Other MTProto libraries that do (GramJS, Telethon, Pyrogram, gotd) could implement the protocol, but only mtcute ships here.

## Local development

Needs Node.js 24.14.1 or later (within 24) and pnpm 12.

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

Build the images, from the repository root:

```sh
docker build -f producers/telegram/Dockerfile -t telecord-ingestion-telegram .
docker build -f producers/discord/Dockerfile -t telecord-ingestion-discord .
docker build -t telecord-ingestion-updater updater
```
