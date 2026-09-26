#!/bin/sh
# Sets up the Telecord ingestion producers with Docker Compose.
#
#   curl -fsSL https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.sh | sh
set -eu

SOURCE="${TELECORD_INGESTION_SOURCE:-https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main}"
BASE='wss://ingest.telecord.app'

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	BOLD=$(printf '\033[1m')
	DIM=$(printf '\033[2m')
	ACCENT=$(printf '\033[38;5;36m')
	RED=$(printf '\033[31m')
	RESET=$(printf '\033[0m')
else
	BOLD='' DIM='' ACCENT='' RED='' RESET=''
fi

say() {
	printf '%s\n' "$*"
}

step() {
	printf '\n%s%s%s\n' "$ACCENT$BOLD" "$*" "$RESET"
}

ok() {
	printf '  %s✓%s %s\n' "$ACCENT" "$RESET" "$*"
}

fail() {
	printf '\n%sError:%s %s\n' "$RED$BOLD" "$RESET" "$*" >&2
	exit 1
}

# curl pipes this script through stdin, so every prompt reads the terminal directly.
read_tty() {
	IFS= read -r REPLY < /dev/tty || fail "Input closed."
}

# ask <variable> <prompt> [default]
ask() {
	while :; do
		if [ -n "${3:-}" ]; then
			printf '  %s %s(%s)%s: ' "$2" "$DIM" "$3" "$RESET"
		else
			printf '  %s: ' "$2"
		fi

		read_tty
		REPLY="${REPLY:-${3:-}}"

		if [ -n "$REPLY" ]; then
			break
		fi

		say "  ${RED}Required.${RESET}"
	done

	eval "$1=\$REPLY"
}

# ask_secret <variable> <prompt>
ask_secret() {
	while :; do
		printf '  %s %s(hidden)%s: ' "$2" "$DIM" "$RESET"
		stty -echo < /dev/tty
		trap 'stty echo < /dev/tty' EXIT
		read_tty
		stty echo < /dev/tty
		trap - EXIT
		printf '\n'

		if [ -n "$REPLY" ]; then
			break
		fi

		say "  ${RED}Required.${RESET}"
	done

	eval "$1=\$REPLY"
}

# confirm <prompt> <y|n>, succeeding on yes.
confirm() {
	if [ "$2" = y ]; then
		hint='Y/n'
	else
		hint='y/N'
	fi

	while :; do
		printf '  %s %s(%s)%s: ' "$1" "$DIM" "$hint" "$RESET"
		read_tty

		case "${REPLY:-$2}" in
			[Yy] | [Yy][Ee][Ss]) return 0 ;;
			[Nn] | [Nn][Oo]) return 1 ;;
		esac
	done
}

compose() {
	docker compose --project-directory "$DIR" "$@"
}

if ! (: < /dev/tty) 2> /dev/null; then
	fail "No terminal to prompt on. Run this from an interactive shell."
fi

printf '\n%s  Telecord Ingestion%s\n' "$ACCENT$BOLD" "$RESET"
say "  ${DIM}Connect your Telegram and Discord accounts to Telecord.${RESET}"

step "1. Checking Docker"

command -v docker > /dev/null 2>&1 || fail "Docker is not installed. Get it from https://docs.docker.com/get-docker/"
docker compose version > /dev/null 2>&1 || fail "Docker Compose v2 is missing. Update Docker, then run this again."
docker info > /dev/null 2>&1 || fail "Cannot reach the Docker daemon. Start Docker, or add your user to the docker group."
ok "Docker is ready"

step "2. Choose platforms"

say "  1) Telegram"
say "  2) Discord"
say "  3) Both"

choice=''

while :; do
	ask choice "Platform" 3

	case "$choice" in
		1) TELEGRAM=1 DISCORD=0 ;;
		2) TELEGRAM=0 DISCORD=1 ;;
		3) TELEGRAM=1 DISCORD=1 ;;
		*) continue ;;
	esac

	break
done

step "3. Install location"

ask DIR "Directory" "$HOME/telecord-ingestion"

# Expands a ~ the user typed, which the shell does not do for read input.
# shellcheck disable=SC2088
case "$DIR" in
	"~") DIR="$HOME" ;;
	"~/"*) DIR="$HOME/${DIR#"~/"}" ;;
esac

if [ -e "$DIR/.env" ] && ! confirm "$DIR already has an install. Overwrite its settings?" n; then
	fail "Stopped without changes."
fi

if [ "$TELEGRAM" = 1 ]; then
	step "4. Telegram"

	say "  ${DIM}Create an app at https://my.telegram.org to get an API id and hash.${RESET}"

	while :; do
		ask TELEGRAM_API_ID "API id"

		case "$TELEGRAM_API_ID" in
			*[!0-9]*) say "  ${RED}The API id is a number.${RESET}" ;;
			*) break ;;
		esac
	done

	ask_secret TELEGRAM_API_HASH "API hash"
	ask_secret TELEGRAM_KEY "Telecord API key for this account"
fi

if [ "$DISCORD" = 1 ]; then
	step "$((4 + TELEGRAM)). Discord"

	ask_secret DISCORD_TOKEN "Account token"
	ask_secret DISCORD_KEY "Telecord API key for this account"
fi

step "$((4 + TELEGRAM + DISCORD)). Options"

say "  ${DIM}Direct messages are private by default. You can change this later in the .env files.${RESET}"

if confirm "Share direct messages too?" n; then
	FILTER='FILTER_RULES=[]'
else
	FILTER=''
fi

say "  ${DIM}The updater installs new releases once their signature is verified. It needs access to the Docker socket.${RESET}"

if confirm "Install updates automatically?" y; then
	UPDATER=1
else
	UPDATER=0
fi

step "Setting up $DIR"

mkdir -p "$DIR"
curl -fsSL "$SOURCE/compose.yml" -o "$DIR/compose.yml" || fail "Could not download compose.yml from $SOURCE"
ok "Downloaded compose.yml"

PROFILES=''

if [ "$TELEGRAM" = 1 ]; then
	PROFILES="${PROFILES}telegram,"
fi

if [ "$DISCORD" = 1 ]; then
	PROFILES="${PROFILES}discord,"
fi

if [ "$UPDATER" = 1 ]; then
	PROFILES="${PROFILES}updater,"
fi

# The env files hold account credentials.
umask 077

printf 'COMPOSE_PROFILES=%s\n' "${PROFILES%,}" > "$DIR/.env"
ok "Wrote .env"

if [ "$TELEGRAM" = 1 ]; then
	{
		printf 'INGEST_URL=%s/telegram/v1\n' "$BASE"
		printf 'INGEST_API_KEY=%s\n' "$TELEGRAM_KEY"
		printf 'TELEGRAM_API_ID=%s\n' "$TELEGRAM_API_ID"
		printf 'TELEGRAM_API_HASH=%s\n' "$TELEGRAM_API_HASH"
		[ -z "$FILTER" ] || printf '%s\n' "$FILTER"
	} > "$DIR/telegram.env"
	ok "Wrote telegram.env"
fi

if [ "$DISCORD" = 1 ]; then
	{
		printf 'INGEST_URL=%s/discord/v1\n' "$BASE"
		printf 'INGEST_API_KEY=%s\n' "$DISCORD_KEY"
		printf 'DISCORD_TOKEN=%s\n' "$DISCORD_TOKEN"
		[ -z "$FILTER" ] || printf '%s\n' "$FILTER"
	} > "$DIR/discord.env"
	ok "Wrote discord.env"
fi

step "Downloading images"

compose pull --quiet || fail "Could not pull the images."
ok "Images are up to date"

if [ "$TELEGRAM" = 1 ]; then
	step "Log in to Telegram"

	say "  Answer the phone, code and 2FA prompts."
	say "  When you see ${BOLD}Logged in to Telegram${RESET}, press ${BOLD}Ctrl+C${RESET} to continue."
	say ""

	# Ctrl+C ends the login container, not this script.
	trap : INT
	status=0
	compose run --rm telegram < /dev/tty || status=$?
	trap - INT

	case "$status" in
		0 | 130) ok "Telegram session saved" ;;
		*) fail "The Telegram login exited with status $status. Run this installer again to retry." ;;
	esac
fi

step "Starting"

compose up --detach --quiet-pull || fail "Could not start the services."
compose ps

printf '\n%sDone.%s Telecord ingestion is running in %s\n\n' "$ACCENT$BOLD" "$RESET" "$DIR"
say "  Logs     cd \"$DIR\" && docker compose logs -f"
say "  Stop     cd \"$DIR\" && docker compose down"
say "  Filters  edit the .env files, then run: docker compose up -d"
say ""
