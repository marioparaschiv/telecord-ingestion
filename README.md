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

**[Quick start](#quick-start)** · [Filters](#filters) · [Configuration](#configuration) · [FAQ](#faq)

</div>

---

## At a glance

- **You choose what is shared.** Tick chats in a picker. DMs are off by default.
- **Shared chats include their history.** The server can read past messages, not only new ones.
- **The server can only ask for a few things.** Every request about a chat is checked against your filters.
- **Images are signed and locked down.** Non-root, read-only, built only from release tags.
- **Updates install themselves**, but only after the signature checks out.

## Contents

**Set up**

1. [Quick start](#quick-start)
2. [Filters](#filters)
3. [Configuration](#configuration)
4. [Commands](#commands)
5. [FAQ](#faq)

**How it works**

6. [What the server can see](#what-the-server-can-see)
7. [Updates](#updates)
8. [Security](#security)
9. [Supported libraries](#supported-libraries)
10. [Local development](#local-development)

---

## Quick start

```sh
# macOS and Linux
curl -fsSL https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.ps1 | iex
```

Takes about 5 minutes. You need Docker with Compose, and a Telecord API key for each account. Telegram also needs an API id and hash from [my.telegram.org](https://my.telegram.org).

The installer:

1. Downloads the `telecord-ingestion` CLI from the latest release and checks its SHA-256.
2. Installs it to `~/.local/bin`, or `%LOCALAPPDATA%\Programs\telecord-ingestion` on Windows, and adds that to your `PATH`.
3. Runs `telecord-ingestion setup`, which asks which platforms to run and for your credentials.
4. Logs you in to Telegram and starts the containers.
5. Opens the chat picker, so you choose what is shared.

Settings go in `~/telecord-ingestion` unless you pass `--dir`.

Check it worked:

```sh
telecord-ingestion status
```

Each service shows `Up`, and each producer shows `config: valid`.

> Linux builds need glibc. Alpine and other musl-based systems are not supported.

### Unattended install

```sh
export TELECORD_TELEGRAM_API_HASH='<from my.telegram.org>'
export TELECORD_TELEGRAM_INGEST_API_KEY='<your Telecord key>'
export TELECORD_DISCORD_TOKEN='<your account token>'
export TELECORD_DISCORD_INGEST_API_KEY='<your Telecord key>'

curl -fsSL https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.sh |
  sh -s -- --platforms telegram,discord --telegram-api-id 12345 --updater on --yes
```

- Setup's flags go after `sh -s --`. Secrets have no flag: they come from `TELECORD_` variables, so they stay out of the process list.
- `--yes` never asks. It fails when a required setting is missing, naming it.
- The Telegram login asks for a code, so it waits for you. Run `telecord-ingestion login telegram` in a terminal afterwards.
- Every setting has a flag and a `TELECORD_` variable. See the [settings reference](#settings-reference).

On Windows, set the variables with `$env:TELECORD_DISCORD_TOKEN = '...'`, then:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.ps1))) --platforms discord --yes
```

Check it worked: `telecord-ingestion status`.

### Manual setup, without the CLI

1. Download `compose.yml` into an empty directory:

    ```sh
    curl -fsSLO https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/compose.yml
    ```

2. Create `.env` next to it, listing the services to run and the user they run as:

    ```sh
    printf 'COMPOSE_PROFILES=telegram,discord,updater\nHOST_UID=%s\nHOST_GID=%s\n' "$(id -u)" "$(id -g)" > .env
    ```

3. Create `config.toml`, readable by you only. It must exist before the first start, or Docker mounts a directory in its place.

    ```sh
    touch config.toml && chmod 600 config.toml
    ```

4. Add your settings to `config.toml`. Copy the [example](#configuration) and delete the platform you don't run.
5. Log in to Telegram once. Answer the phone, code and 2FA prompts. It exits once the session is saved.

    ```sh
    docker compose run --rm telegram login
    ```

6. Start everything:

    ```sh
    docker compose up -d
    ```

Check it worked: `docker compose ps` shows each service as `Up`.

Only using one platform? Leave the other out of `COMPOSE_PROFILES` and out of `config.toml`.

## Filters

```sh
telecord-ingestion filters
```

This opens the chat picker for each platform you run. Add `telegram` or `discord` to pick one. It needs a terminal.

1. Move with the arrow keys. Press Space to tick a chat, or a heading to tick every chat under it.
2. Press `/` to search. Press Tab or Enter to go back to the list.
3. Press `s` to save. The picker writes the `forward` table of `config.toml`.
4. Answer yes to restart the producer, so it applies the change.

Check it worked: `telecord-ingestion config show` shows `forward.allow` and `forward.deny` with the source `file`.

Picker keys:

| Keys                | Does                                                    |
| ------------------- | ------------------------------------------------------- |
| ↑ ↓, PgUp PgDn      | Move                                                    |
| Space               | Tick or untick the chat or heading                      |
| `/` or Tab          | Search                                                  |
| `s`                 | Save                                                    |
| `q` or Ctrl+C       | Cancel. `config.toml` is unchanged.                     |

Advanced keys:

| Keys                | Does                                                    |
| ------------------- | ------------------------------------------------------- |
| `a` / `n`           | Tick / untick every chat shown                          |
| `d`                 | Switch unlisted chats between forward and hide          |
| `m`                 | Switch unlisted DMs between forward and hide            |
| Esc (in search)     | Clear the search                                        |

Telegram stops for a few seconds while the picker lists its chats, since both use the same session.

### The forward table

```toml
[telegram.forward]
default = "deny"
dms = false
allow = [
    { id = "-1001234567890", name = "News channel" },
]
deny = []
```

This is what the picker writes. You can also edit it by hand, then run `telecord-ingestion restart`.

| Key       | Meaning                                                                                  |
| --------- | ---------------------------------------------------------------------------------------- |
| `allow`   | Chats to share.                                                                          |
| `deny`    | Chats to hide.                                                                           |
| `dms`     | `true` shares every DM. Unset or `false` hides DMs you don't list in `allow`.            |
| `default` | `allow` or `deny`, for chats neither list names. Unset falls back to `filter.default`.   |

An entry names one chat. `name` is only for you to read.

| Platform | Entry                                 | Id                                                                             |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| Telegram | `{ id = "...", name = "..." }`        | A user as is. A basic group as `-<id>`. A channel or supergroup as `-100<id>`. |
| Discord  | `{ guild = "...", name = "..." }`     | A server id. Covers every channel in it.                                       |
| Discord  | `{ channel = "...", name = "..." }`   | A channel id. DMs and group DMs are channels too.                              |

Listing the same id in `allow` and `deny` stops the producer at startup, naming the id.

### Recipes

Share only one Telegram channel:

```toml
[telegram.forward]
default = "deny"
allow = [
    { id = "-1001234567890", name = "News channel" },
]
```

Share one DM, and keep other DMs hidden:

```toml
[telegram.forward]
allow = [
    { id = "123456789", name = "Alex" },
]
```

Hide one Discord server, but share its announcements channel:

```toml
[discord.forward]
default = "allow"
allow = [
    { channel = "234567890123456789", name = "#announcements" },
]
deny = [
    { guild = "123456789012345678", name = "Work" },
]
```

Share every Discord DM:

```sh
telecord-ingestion config set discord.forward.dms true
telecord-ingestion restart
```

Check it worked: `telecord-ingestion status` shows `config: valid`.

### How a chat is decided

The first match wins, in this order:

1. Your `filter.rules`, if any. See [Advanced: filter rules](#advanced-filter-rules).
2. The `deny` list, then the `allow` list. On Discord, channel entries go before server entries, so a channel entry overrides its server's.
3. One DM rule: shared when `dms = true`, hidden otherwise. A DM you list in step 2 has already been decided.
4. Anything left: `forward.default`, or `filter.default` when that is unset. `filter.default` is `allow` unless you set it.

`default = "allow"` never shares DMs. Step 3 catches them first.

To find ids without the picker, list every chat the account sees as JSON. Stop Telegram first, since both use the same session:

```sh
docker compose stop telegram
docker compose run --rm telegram list-chats
docker compose start telegram

docker compose run --rm discord list-chats
```

### Advanced: filter rules

```toml
[[telegram.filter.rules]]
action = "deny"
peerType = "user"

[[telegram.filter.rules]]
action = "allow"
peerType = ["group", "channel"]
```

Rules match more than a chat id, such as a chat type or an update name. They run before the `forward` lists.

1. Rules are checked top to bottom. The first match wins.
2. A rule is an `action` (`allow` or `deny`) plus fields to match.
3. Each field takes one value or a list. Every field in a rule must match.
4. No rule matches? The `forward` table decides, then `filter.default`.
5. The same rules cover new events, chat lists and every request.

> **Without a `forward` table, your rules replace the default DM rule.** Keep a DM rule in your list, as the recipes below do, or DMs are shared. A `forward` table always adds its own DM rule after your rules.

Share only one Telegram channel:

```toml
[telegram.filter]
default = "deny"

[[telegram.filter.rules]]
action = "allow"
peerId = "-1001234567890"
```

Hide one Discord server, keep DMs hidden:

```toml
[[discord.filter.rules]]
action = "deny"
type = ["dm", "group_dm"]

[[discord.filter.rules]]
action = "deny"
guildId = "123456789012345678"
```

In a producer variable, rules are JSON: `FILTER_RULES=[{"action":"deny","peerType":"user"}]`.

#### Fields

| Platform | Field       | Values                                                                      |
| -------- | ----------- | --------------------------------------------------------------------------- |
| Telegram | `peerType`  | `user`, `group`, `channel`                                                  |
| Telegram | `peerId`    | User id as is. Basic group as `-<id>`. Channel or supergroup as `-100<id>`. |
| Telegram | `update`    | An update constructor name                                                  |
| Discord  | `type`      | `dm`, `group_dm`, `guild`                                                   |
| Discord  | `guildId`   | A server id                                                                 |
| Discord  | `channelId` | A channel id                                                                |
| Discord  | `event`     | A gateway dispatch name                                                     |

#### Defaults

With no rules and no `forward` table, each producer hides DMs and shares everything else:

- Telegram: `[{"action":"deny","peerType":"user"}]`
- Discord: `[{"action":"deny","type":["dm","group_dm"]}]`

## Configuration

A complete `config.toml` for both platforms. Setup writes the required keys; the commented ones show their defaults.

```toml
# One table per platform. Delete the one you don't run.
[telegram]
api_id = 12345                               # From https://my.telegram.org
api_hash = "0123456789abcdef0123456789abcdef" # From https://my.telegram.org. Secret.
# data_dir = "/data"                         # Inside the container. Leave it.

[telegram.ingest]
url = "wss://ingest.telecord.app/telegram/v1"
api_key = "your-telecord-api-key"            # Secret.
# window = 500                               # Events sent and not yet acknowledged.

# The chats to share. `telecord-ingestion filters` writes this table.
[telegram.forward]
default = "deny"                             # Chats neither list names: "allow" or "deny".
dms = false                                  # true shares every DM.
allow = [
    { id = "-1001234567890", name = "News channel" },  # Channel or supergroup: -100<id>
    { id = "-123456789", name = "Family" },            # Basic group: -<id>
    { id = "123456789", name = "Alex" },               # A DM: shared, even with dms = false
]
deny = []

# Advanced. Rules run before the forward table. See Filters.
# [telegram.filter]
# default = "allow"                          # Used when forward.default is unset.

[discord]
token = "your-discord-account-token"         # Secret.

[discord.ingest]
url = "wss://ingest.telecord.app/discord/v1"
api_key = "your-telecord-api-key"            # Secret.

[discord.forward]
default = "allow"
deny = [
    { guild = "123456789012345678", name = "Work" },         # A whole server
]
allow = [
    { channel = "234567890123456789", name = "#announcements" }, # Overrides its server
]
```

Apply an edit:

```sh
telecord-ingestion restart
```

Check it worked: `telecord-ingestion status` shows `config: valid`. When it doesn't, it names the key, its variable and what is wrong.

- The containers read `config.toml` read-only. A key the producer does not know is logged and ignored.
- `restart` recreates the containers. Some editors save by replacing the file, and a container keeps the old file until it is recreated. `docker compose restart` is not enough; use `telecord-ingestion restart` or `docker compose up -d --force-recreate`.

### Change what is forwarded

```sh
telecord-ingestion filters telegram
```

Or edit `[telegram.forward]` by hand, then run `telecord-ingestion restart`. See [Filters](#filters).

### Share DMs

```sh
telecord-ingestion config set telegram.forward.dms true
telecord-ingestion restart
```

To share one DM only, list it in `allow` instead. See [Recipes](#recipes).

### Rotate an API key

1. Set the new key. In a terminal, it asks with a hidden prompt:

    ```sh
    telecord-ingestion config set telegram.ingest.api_key
    ```

    Or read it from a file:

    ```sh
    telecord-ingestion config set telegram.ingest.api_key < new-key.txt
    ```

2. Apply it:

    ```sh
    telecord-ingestion restart
    ```

Secrets are refused as an argument, since they would stay in your shell history.

Check it worked: `telecord-ingestion logs -n 20 telegram` shows no authentication errors.

### Change update timing

```sh
telecord-ingestion setup --check-interval 6h --update-delay 2d
```

Setup keeps every other setting. It writes `CHECK_INTERVAL` and `UPDATE_DELAY` to `.env` and restarts the updater.

- Turn updates off: `telecord-ingestion setup --updater off`.
- Turn them back on: `telecord-ingestion setup --updater on`.

Check it worked: `cat .env` in the install directory.

### Turn on telemetry

1. Create `compose.override.yml` next to `compose.yml`:

    ```yaml
    services:
        telegram:
            environment:
                OTEL_ENABLED: 'true'
                OTEL_ENDPOINT: https://otel.example.com
                OTEL_SERVICE_NAME: telecord-telegram-producer
                OTEL_HEADERS: authorization=Bearer <token>
    ```

2. Apply it:

    ```sh
    telecord-ingestion restart
    ```

`OTEL_ENDPOINT` is an OTLP/HTTP base URL; the producer adds `/v1/traces` and `/v1/metrics`. `OTEL_SERVICE_NAME` is required once telemetry is on. `OTEL_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES` are optional `key=value` lists, comma-separated.

Check it worked: `telecord-ingestion logs telegram` shows `Initialized (telecord-telegram-producer → https://otel.example.com)`.

### Add a second platform

```sh
telecord-ingestion setup --platforms telegram,discord
```

Setup asks only for the new platform's settings, starts it, then opens the picker for each platform. List every platform you want to keep: one you leave out is stopped and removed. Its settings stay in `config.toml`.

Check it worked: `telecord-ingestion status` lists both producers.

### Where settings come from

```sh
telecord-ingestion config show
```

This prints each setting, its value (secrets masked), and where it comes from. A producer takes the first of these that is set:

1. Its environment variable, such as `INGEST_URL`. Set these in `compose.override.yml`.
2. `config.toml`.
3. The default.

A variable silently wins over the file. When an edit seems ignored, check the source column.

### compose.override.yml

```yaml
services:
    telegram:
        image: ghcr.io/marioparaschiv/telecord-ingestion-telegram@sha256:<digest>
        environment:
            FILTER_DEFAULT: deny
```

The CLI rewrites `compose.yml` on every command, so your changes there are lost. Put them in `compose.override.yml`. Compose merges it over `compose.yml`, and the CLI never touches it.

Check it worked: `docker compose config` in the install directory shows the merged result.

### .env

```sh
cat ~/telecord-ingestion/.env
```

Setup writes `.env`. Compose reads it for the variables in `compose.yml`.

| Variable                  | Meaning                                                           |
| ------------------------- | ----------------------------------------------------------------- |
| `COMPOSE_PROFILES`        | The services to run, such as `telegram,discord,updater`           |
| `HOST_UID` and `HOST_GID` | The user the producers run as. Unset on Windows.                  |
| `CHECK_INTERVAL`          | How often the updater checks, such as `30m` or `6h`. Default `24h`. |
| `UPDATE_DELAY`            | How long to wait before switching to a verified release. Default `0`. |

Change these with `telecord-ingestion setup` flags, not by hand.

### Settings reference

```sh
telecord-ingestion config set telegram.ingest.window 1000
```

Every key below can be set this way, or by editing `config.toml`. Lists take JSON. The tables are generated from the config schemas by `pnpm readme`.

- **Key** is the path in `config.toml`.
- **Producer variable** overrides the key inside the container. Set it in `compose.override.yml`.
- **Setup flag and variable** are what `telecord-ingestion setup` takes. Secrets have no flag.

<!-- settings:start -->

**Telegram**

| Key                        | Producer variable   | Setup flag and variable                                           | Default                                                        | Meaning                                                                                     |
| -------------------------- | ------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `telegram.api_id`          | `TELEGRAM_API_ID`   | `--telegram-api-id`, `TELECORD_TELEGRAM_API_ID`                   | required                                                       | The API id of your app at https://my.telegram.org.                                          |
| `telegram.api_hash`        | `TELEGRAM_API_HASH` | `TELECORD_TELEGRAM_API_HASH` or the prompt                        | required                                                       | The API hash of your app at https://my.telegram.org.                                        |
| `telegram.data_dir`        | `DATA_DIR`          | `--telegram-data-dir`, `TELECORD_TELEGRAM_DATA_DIR`               | `/data`                                                        | Holds the SQLite session (auth keys, the peer cache and the update state) and the outbox.   |
| `telegram.ingest.url`      | `INGEST_URL`        | `--telegram-ingest-url`, `TELECORD_TELEGRAM_INGEST_URL`           | required, setup offers `wss://ingest.telecord.app/telegram/v1` | The WebSocket URL of the ingest server, ending in the platform route.                       |
| `telegram.ingest.api_key`  | `INGEST_API_KEY`    | `TELECORD_TELEGRAM_INGEST_API_KEY` or the prompt                  | required                                                       | The Telecord API key for this account.                                                      |
| `telegram.ingest.window`   | `INGEST_WINDOW`     | `--telegram-ingest-window`, `TELECORD_TELEGRAM_INGEST_WINDOW`     | `500`                                                          | The most events sent and not yet acknowledged.                                              |
| `telegram.filter.rules`    | `FILTER_RULES`      | `--telegram-filter-rules`, `TELECORD_TELEGRAM_FILTER_RULES`       | unset                                                          | The ordered rules; the first one matching a chat or event decides. JSON in the environment. |
| `telegram.filter.default`  | `FILTER_DEFAULT`    | `--telegram-filter-default`, `TELECORD_TELEGRAM_FILTER_DEFAULT`   | `allow`                                                        | The action, allow or deny, when no rule matches.                                            |
| `telegram.forward.default` | `FORWARD_DEFAULT`   | `--telegram-forward-default`, `TELECORD_TELEGRAM_FORWARD_DEFAULT` | unset                                                          | The action, allow or deny, for the chats neither list names. Unset leaves filter.default.   |
| `telegram.forward.dms`     | `FORWARD_DMS`       | `--telegram-forward-dms`, `TELECORD_TELEGRAM_FORWARD_DMS`         | unset                                                          | Whether DMs are shared. A DM listed in allow or deny follows its list.                      |
| `telegram.forward.allow`   | `FORWARD_ALLOW`     | `--telegram-forward-allow`, `TELECORD_TELEGRAM_FORWARD_ALLOW`     | unset                                                          | The chats to share. JSON in the environment.                                                |
| `telegram.forward.deny`    | `FORWARD_DENY`      | `--telegram-forward-deny`, `TELECORD_TELEGRAM_FORWARD_DENY`       | unset                                                          | The chats to hide. JSON in the environment.                                                 |

**Discord**

| Key                       | Producer variable | Setup flag and variable                                         | Default                                                       | Meaning                                                                                     |
| ------------------------- | ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `discord.token`           | `DISCORD_TOKEN`   | `TELECORD_DISCORD_TOKEN` or the prompt                          | required                                                      | The token of the Discord account.                                                           |
| `discord.data_dir`        | `DATA_DIR`        | `--discord-data-dir`, `TELECORD_DISCORD_DATA_DIR`               | `/data`                                                       | Holds the outbox.                                                                           |
| `discord.ingest.url`      | `INGEST_URL`      | `--discord-ingest-url`, `TELECORD_DISCORD_INGEST_URL`           | required, setup offers `wss://ingest.telecord.app/discord/v1` | The WebSocket URL of the ingest server, ending in the platform route.                       |
| `discord.ingest.api_key`  | `INGEST_API_KEY`  | `TELECORD_DISCORD_INGEST_API_KEY` or the prompt                 | required                                                      | The Telecord API key for this account.                                                      |
| `discord.ingest.window`   | `INGEST_WINDOW`   | `--discord-ingest-window`, `TELECORD_DISCORD_INGEST_WINDOW`     | `500`                                                         | The most events sent and not yet acknowledged.                                              |
| `discord.filter.rules`    | `FILTER_RULES`    | `--discord-filter-rules`, `TELECORD_DISCORD_FILTER_RULES`       | unset                                                         | The ordered rules; the first one matching a chat or event decides. JSON in the environment. |
| `discord.filter.default`  | `FILTER_DEFAULT`  | `--discord-filter-default`, `TELECORD_DISCORD_FILTER_DEFAULT`   | `allow`                                                       | The action, allow or deny, when no rule matches.                                            |
| `discord.forward.default` | `FORWARD_DEFAULT` | `--discord-forward-default`, `TELECORD_DISCORD_FORWARD_DEFAULT` | unset                                                         | The action, allow or deny, for the chats neither list names. Unset leaves filter.default.   |
| `discord.forward.dms`     | `FORWARD_DMS`     | `--discord-forward-dms`, `TELECORD_DISCORD_FORWARD_DMS`         | unset                                                         | Whether DMs are shared. A DM listed in allow or deny follows its list.                      |
| `discord.forward.allow`   | `FORWARD_ALLOW`   | `--discord-forward-allow`, `TELECORD_DISCORD_FORWARD_ALLOW`     | unset                                                         | The chats to share. JSON in the environment.                                                |
| `discord.forward.deny`    | `FORWARD_DENY`    | `--discord-forward-deny`, `TELECORD_DISCORD_FORWARD_DENY`       | unset                                                         | The chats to hide. JSON in the environment.                                                 |

<!-- settings:end -->

## Commands

```sh
telecord-ingestion --help
```

Every command takes `--help`.

Everyday:

| Command                                | Does                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `telecord-ingestion status`            | Shows each service's state and whether each producer's config is valid |
| `telecord-ingestion logs -f telegram`  | Follows a service's logs. `-n 50` starts 50 lines from the end.        |
| `telecord-ingestion restart`           | Recreates the producers, so they read `config.toml` again              |
| `telecord-ingestion filters`           | Opens the chat picker                                                  |
| `telecord-ingestion config show`       | Shows every setting, its value and where it comes from                 |

Setup and upkeep:

| Command                                     | Does                                                             |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `telecord-ingestion setup`                  | Sets up an install, or changes one. Asks only for what is missing. |
| `telecord-ingestion config set <key> [value]` | Sets one key in `config.toml`, keeping your comments and layout. |
| `telecord-ingestion login telegram`         | Logs in to Telegram, then starts it                              |
| `telecord-ingestion update`                 | Updates the CLI to the latest release                            |
| `telecord-ingestion uninstall`              | Removes the containers. See below.                               |

The commands find the install in this order: `--dir`, the `TELECORD_INGESTION_DIR` variable, the current directory when it holds `config.toml` or `compose.yml`, then `~/telecord-ingestion`.

### Uninstall

```sh
telecord-ingestion uninstall
```

Removes the containers. Keeps `config.toml` and the account data, including the Telegram login. Run `telecord-ingestion setup` to start again.

```sh
telecord-ingestion uninstall --purge
```

Also deletes the data volumes and the install directory. It asks you to type the directory's name first. You log in to Telegram again after that.

Neither removes the CLI. Delete it from `~/.local/bin`, or `%LOCALAPPDATA%\Programs\telecord-ingestion` on Windows.

## FAQ

### Which of my chats does the server get?

Only the ones your `forward` table or filter rules allow. DMs are off by default. See [Filters](#filters).

### Can the server read old messages?

Yes, for shared chats. It can page through history and download media. Hide a chat to keep it out completely.

### I edited `config.toml` and nothing changed. Why?

The producers read it at startup. Run `telecord-ingestion restart`. Still nothing? Run `telecord-ingestion config show`: a variable in `compose.override.yml` wins over the file.

### I wrote `filter.rules` and now my DMs are shared. Why?

Without a `forward` table, your rules replace the default DM rule. Add the DM rule back as your first rule, or add a `forward` table. See [Advanced: filter rules](#advanced-filter-rules).

### Do I have to run both producers?

No. Setup asks which ones you want, or takes `--platforms`. For a manual setup, list only the ones you need in `COMPOSE_PROFILES`.

### How do I see what it's doing?

```sh
telecord-ingestion logs -f telegram
```

### Where is my Telegram login stored?

In the `telegram-data` Docker volume. It survives restarts, updates and `telecord-ingestion uninstall`. `uninstall --purge` deletes it.

### What if I don't update?

It keeps working until the server stops accepting your Telegram layer or Discord API version. Then the connection is refused.

### Can I turn off automatic updates?

Yes. Run `telecord-ingestion setup --updater off`, or pin the image to a digest. See [Controlling updates](#controlling-updates).

### Why not TDLib?

TDLib never exposes the raw payloads the protocol forwards.

---

## What the server can see

For each shared chat, the server receives:

- new, edited and deleted messages;
- on Telegram, the full chat with each new or edited message, or the full user for a DM;
- reactions;
- chat, channel, server and role changes, and changes to your own membership.

Nothing else your account receives is sent. A denied chat is left out entirely.

### What the server can ask for

These are the only requests. Each one about a chat is checked against your filters first; a request for a denied chat is declined without calling Telegram or Discord.

| Request              | Telegram | Discord | What it does                                                   |
| -------------------- | -------- | ------- | -------------------------------------------------------------- |
| `CHATS_FETCH`        | yes      | yes     | Lists your shared chats. Sent on connect and every 30 minutes. |
| `MESSAGES_FETCH`     | yes      | yes     | Reads up to 100 messages from one chat.                        |
| `MEDIA_FETCH`        | yes      | yes     | Downloads one file and uploads it to the server.               |
| `ATTACHMENT_REFRESH` | no       | yes     | Renews one expired Discord attachment link.                    |
| `USERS_FETCH`        | yes      | no      | Reads the profile of one user your account already knows.      |
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

The updater covers the containers only. Update the CLI with `telecord-ingestion update`.

### Controlling updates

- **Delay rollout:** run `telecord-ingestion setup --update-delay 2d` to give yourself time to hear about a bad release.
- **Pin a release:** set the service's `image:` to a digest (`...-telegram@sha256:...`) in `compose.override.yml`. Pinned images are skipped.
- **Turn it off:** run `telecord-ingestion setup --updater off`, or remove the label from a service.

### The Docker socket

The updater needs `/var/run/docker.sock` to download images and restart containers. Access to that socket equals root on the host, however locked down the container is.

Rather not grant that? Run `telecord-ingestion setup --updater off` and update by hand:

1. Verify the new image (see [Verify an image](#verify-an-image)).
2. Run `docker compose pull && docker compose up -d` in the install directory.

## Security

### Containers

Both producers run:

- as the user who ran setup (`HOST_UID` and `HOST_GID` in `.env`, uid 1000 when unset), not root unless you ran setup as root;
- with a read-only filesystem, and `config.toml` mounted read-only;
- with no Linux capabilities and `no-new-privileges`;
- with a `/tmp` that is cleared on restart.

Each producer also gets a `/data` volume for its outbox. On Telegram it also holds the login session. On Discord it holds the gateway session, which a restart resumes.

Setup leaves `config.toml` and `.env` readable by you only, since they hold your keys.

### Images

Images are built only by `.github/workflows/release.yml`, and only from `telegram-v*`, `discord-v*` or `updater-v*` tags. Each one ships with:

- a [cosign](https://github.com/sigstore/cosign) signature, recorded in the public Rekor log;
- SLSA provenance describing how it was built;
- an SBOM listing its packages.

The CLI binaries are built by `.github/workflows/cli-release.yml` from `cli-v*` tags, and signed with cosign the same way. The installers check each download against the release's `checksums.txt`.

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
| Discord  | `discord.js-selfbot-v13` via [FORK.Discord.Self](https://github.com/marioparaschiv/FORK.Discord.Self) at commit `0ff78cd` | Gateway API version 9 |

TDLib and the official apps are not supported, because they never expose raw TL payloads. Other MTProto libraries that do (GramJS, Telethon, Pyrogram, gotd) could implement the protocol, but only mtcute ships here.

## Local development

```sh
pnpm install
pnpm build          # producer-core and both producers
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm readme:check   # the settings reference matches the schemas
```

Needs Node.js 24.14.1 or later (within 24), pnpm 12, and bun 1.4 for the CLI.

Run a producer against a local ingest server. Outside Docker there is no `config.toml`, so it reads its [producer variables](#settings-reference), here from an env file:

```sh
DATA_DIR=./data node --env-file=telegram.env producers/telegram/dist/index.mjs
DATA_DIR=./data node --env-file=discord.env producers/discord/dist/index.mjs
```

Run the CLI from source, or build its binaries into `cli/dist`:

```sh
bun --conditions=development cli/src/index.ts --help
pnpm --filter @telecord/ingestion-cli compile
```

After changing a config schema, regenerate the settings reference:

```sh
pnpm readme
```

Build the images, from the repository root:

```sh
docker build -f producers/telegram/Dockerfile -t telecord-ingestion-telegram .
docker build -f producers/discord/Dockerfile -t telecord-ingestion-discord .
docker build -t telecord-ingestion-updater updater
```
