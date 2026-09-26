#!/bin/sh
# Recreates this compose project's labelled containers on a newer image, only
# once the image's signature proves it was built by the release workflow.
set -u

LABEL='telecord-ingestion.autoupdate=true'
IDENTITY='^https://github\.com/marioparaschiv/telecord-ingestion/\.github/workflows/release\.yml@refs/tags/.*$'
ISSUER='https://token.actions.githubusercontent.com'
PROJECT_DIR=/project
CHECK_INTERVAL="${CHECK_INTERVAL:-24h}"
UPDATE_DELAY="${UPDATE_DELAY:-0}"

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME must name the compose project to update}"

log() {
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

# The repository part of an image reference, without its tag.
repository_of() {
	case "${1##*/}" in
		*:*) echo "${1%:*}" ;;
		*) echo "$1" ;;
	esac
}

# The image is resolved to a digest, verified and pulled by that digest before
# the tag moves, so an unverified image is never pulled or started.
update() {
	container="$1"
	service=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container") || return 1
	ref=$(docker inspect --format '{{.Config.Image}}' "$container") || return 1
	running=$(docker inspect --format '{{.Image}}' "$container") || return 1

	case "$ref" in
		*@*)
			log "$service: $ref is pinned to a digest, skipping"
			return 0
			;;
	esac

	if ! digest=$(crane digest "$ref"); then
		log "$service: failed to resolve $ref"
		return 1
	fi

	image="$(repository_of "$ref")@$digest"

	# A miss only means the image is not local yet.
	if [ "$(docker image inspect --format '{{.Id}}' "$image" 2> /dev/null)" = "$running" ]; then
		log "$service: $ref is up to date"
		return 0
	fi

	if ! cosign verify \
		--certificate-identity-regexp "$IDENTITY" \
		--certificate-oidc-issuer "$ISSUER" \
		"$image" > /dev/null; then
		log "$service: REFUSED $image: signature verification failed, keeping $running"
		return 1
	fi

	if ! docker pull --quiet "$image" > /dev/null; then
		log "$service: failed to pull $image"
		return 1
	fi

	if [ "$(docker image inspect --format '{{.Id}}' "$image")" = "$running" ]; then
		log "$service: $ref is up to date"
		return 0
	fi

	log "$service: verified $image, recreating after UPDATE_DELAY=$UPDATE_DELAY"
	sleep "$UPDATE_DELAY"

	if ! docker tag "$image" "$ref" ||
		! docker compose --project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT_NAME" \
			up --detach --no-deps "$service"; then
		log "$service: failed to recreate on $image"
		return 1
	fi

	log "$service: now running $image"
}

check() {
	if ! containers=$(docker ps --quiet \
		--filter "label=$LABEL" \
		--filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"); then
		log "Failed to list the containers of $COMPOSE_PROJECT_NAME"
		return 1
	fi

	if [ -z "$containers" ]; then
		log "No running container in $COMPOSE_PROJECT_NAME carries $LABEL"
		return 0
	fi

	for container in $containers; do
		update "$container"
	done
}

while :; do
	check
	sleep "$CHECK_INTERVAL"
done
