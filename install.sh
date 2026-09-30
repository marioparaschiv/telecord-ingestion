#!/bin/sh
# Installs the telecord-ingestion CLI, then runs its setup with any arguments given.
#
#   curl -fsSL https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/marioparaschiv/telecord-ingestion/main/install.sh | sh -s -- --yes
set -eu

RELEASES="${TELECORD_INGESTION_RELEASES:-https://api.github.com/repos/marioparaschiv/telecord-ingestion/releases}"
NAME='telecord-ingestion'
BIN_DIR="$HOME/.local/bin"

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

detect_asset() {
	case "$(uname -s)" in
		Linux) os=linux ;;
		Darwin) os=darwin ;;
		*) fail "No telecord-ingestion build for $(uname -s). Use install.ps1 on Windows." ;;
	esac

	# The Linux builds link against glibc.
	if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
		fail "No telecord-ingestion build for musl-based Linux such as Alpine."
	fi

	case "$(uname -m)" in
		x86_64 | amd64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) fail "No telecord-ingestion build for the $(uname -m) architecture." ;;
	esac

	# A shell running under Rosetta reports x86_64 on Apple silicon.
	if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2> /dev/null)" = 1 ]; then
		arch=arm64
	fi

	ASSET="$NAME-$os-$arch"
}

# Scans the release list without a JSON parser. GitHub lists each release's tag_name
# before its draft and prerelease flags, and escapes the quotes in any free text.
latest_tag() {
	printf '%s' "$RELEASES_JSON" |
		grep -Eo '"(tag_name|draft|prerelease)": *("[^"]*"|true|false)' |
		awk '
			/^"tag_name"/ { split($0, part, "\""); tag = part[4]; draft = ""; prerelease = ""; next }
			/^"draft"/ { draft = /true$/ }
			/^"prerelease"/ { prerelease = /true$/ }
			tag != "" && draft != "" && prerelease != "" {
				if (tag ~ /^cli-v[0-9]+\.[0-9]+\.[0-9]+/ && !draft && !prerelease) {
					print tag
					exit
				}

				tag = ""
			}
		'
}

# asset_url <file>
asset_url() {
	printf '%s' "$RELEASES_JSON" |
		grep -Eo '"browser_download_url": *"[^"]*"' |
		sed 's/.*"\([^"]*\)"$/\1/' |
		awk -v suffix="/$TAG/$1" 'substr($0, length($0) - length(suffix) + 1) == suffix { print; exit }'
}

# download <file> <destination>
download() {
	url=$(asset_url "$1")
	[ -n "$url" ] || fail "Release $TAG has no $1."
	curl -fsSL "$url" -o "$2" || fail "Could not download $1 from $url"
}

sha256() {
	if command -v sha256sum > /dev/null 2>&1; then
		sha256sum "$1" | awk '{ print $1 }'
	elif command -v shasum > /dev/null 2>&1; then
		shasum -a 256 "$1" | awk '{ print $1 }'
	else
		fail "Neither sha256sum nor shasum is installed, so the download cannot be verified."
	fi
}

# Appends a PATH entry to the profile of the user's login shell.
add_to_path() {
	# shellcheck disable=SC2016
	line='export PATH="$HOME/.local/bin:$PATH"'

	case "$(basename "${SHELL:-sh}")" in
		zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
		bash)
			if [ "$(uname -s)" = Darwin ]; then
				profile="$HOME/.bash_profile"
			else
				profile="$HOME/.bashrc"
			fi
			;;
		fish)
			profile="$HOME/.config/fish/config.fish"
			# shellcheck disable=SC2016
			line='fish_add_path "$HOME/.local/bin"'
			;;
		*) profile="$HOME/.profile" ;;
	esac

	if [ -f "$profile" ] && grep -Fqx "$line" "$profile"; then
		return
	fi

	mkdir -p "$(dirname "$profile")"
	printf '\n%s\n' "$line" >> "$profile"
	ok "Added $BIN_DIR to PATH in $profile"
	say "  ${DIM}Open a new terminal to run $NAME by name.${RESET}"
}

main() {
	command -v curl > /dev/null 2>&1 || fail "curl is not installed."

	printf '\n%s  Telecord Ingestion%s\n' "$ACCENT$BOLD" "$RESET"

	step "1. Finding the latest release"

	detect_asset
	RELEASES_JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$RELEASES?per_page=100") ||
		fail "Could not list the releases at $RELEASES"
	TAG=$(latest_tag)
	[ -n "$TAG" ] || fail "No stable $NAME release found at $RELEASES"
	ok "$NAME ${TAG#cli-v} for ${ASSET#"$NAME-"}"

	step "2. Downloading"

	mkdir -p "$BIN_DIR"
	# Staged beside the destination so the final move is an atomic rename.
	staging=$(mktemp -d "$BIN_DIR/.$NAME.XXXXXX")
	trap 'rm -rf "$staging"' EXIT

	download checksums.txt "$staging/checksums.txt"
	download "$ASSET" "$staging/$ASSET"

	expected=$(awk -v file="$ASSET" '$2 == file || $2 == "*" file { print tolower($1); exit }' "$staging/checksums.txt")
	[ -n "$expected" ] || fail "checksums.txt lists no checksum for $ASSET"
	actual=$(sha256 "$staging/$ASSET")
	[ "$actual" = "$expected" ] || fail "Checksum mismatch for $ASSET: expected $expected, got $actual. Nothing was installed."
	ok "Checksum verified"

	step "3. Installing"

	chmod 755 "$staging/$ASSET"
	mv -f "$staging/$ASSET" "$BIN_DIR/$NAME"
	rm -rf "$staging"
	trap - EXIT
	ok "Installed $BIN_DIR/$NAME"

	case ":$PATH:" in
		*":$BIN_DIR:"*) ;;
		*) add_to_path ;;
	esac

	step "4. Setting up"

	# curl pipes this script through stdin, so setup reads the terminal directly.
	if (: < /dev/tty) 2> /dev/null; then
		exec "$BIN_DIR/$NAME" setup "$@" < /dev/tty
	fi

	exec "$BIN_DIR/$NAME" setup "$@"
}

# Called last so a download cut short runs nothing.
main "$@"
