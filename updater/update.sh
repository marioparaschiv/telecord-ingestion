#!/bin/sh
# Recreates this compose project's labelled containers on a newer image, only
# once the image's signature proves it was built by the release workflow.
set -u

LABEL='telecord-ingestion.autoupdate=true'
IDENTITY='^https://github\.com/marioparaschiv/telecord-ingestion/\.github/workflows/release\.yml@refs/tags/.*$'
ISSUER='https://token.actions.githubusercontent.com'
PROJECT_DIR=/project
SOCKET=/var/run/docker.sock
CHECK_INTERVAL="${CHECK_INTERVAL:-24h}"
UPDATE_DELAY="${UPDATE_DELAY:-0}"

: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME must name the compose project to update}"

log() {
	echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*"
}

# Docker bind-mounts /etc/hostname from the container's own directory, which is named by its full id.
SELF=$(sed -n 's|.* [^ ]*/containers/\([0-9a-f]\{64\}\)/hostname /etc/hostname .*|\1|p' /proc/self/mountinfo)

if [ -z "$SELF" ]; then
	log "Failed to find the updater's own container id"
	exit 1
fi

if ! HOST_PROJECT_DIR=$(docker inspect \
	--format "{{range .Mounts}}{{if eq .Destination \"$PROJECT_DIR\"}}{{.Source}}{{end}}{{end}}" \
	"$SELF") || [ -z "$HOST_PROJECT_DIR" ]; then
	log "Failed to find the host directory mounted at $PROJECT_DIR"
	exit 1
fi

# compose.yml bind-mounts this as /project when the updater is recreated.
export HOST_PROJECT_DIR

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

	if ! docker tag "$image" "$ref"; then
		log "$service: failed to tag $image as $ref"
		return 1
	fi

	if [ "$container" = "$SELF" ]; then
		handoff "$service" "$image"
		return
	fi

	if ! docker compose --project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT_NAME" \
		up --detach --no-deps "$service"; then
		log "$service: failed to recreate on $image"
		return 1
	fi

	log "$service: now running $image"
}

# Compose stops the old container before starting the new one, which would end
# this script halfway, so the updater is recreated from a one-off container of
# the verified image instead.
handoff() {
	service="$1"
	image="$2"

	if ! helper=$(docker run --detach --rm \
		--read-only --tmpfs /tmp \
		--cap-drop ALL --cap-add DAC_READ_SEARCH \
		--security-opt no-new-privileges:true \
		--volume "$SOCKET:$SOCKET" \
		--volume "$HOST_PROJECT_DIR:$PROJECT_DIR:ro" \
		--env HOST_PROJECT_DIR \
		--entrypoint docker \
		"$image" \
		compose --project-directory "$PROJECT_DIR" --project-name "$COMPOSE_PROJECT_NAME" \
		up --detach --no-deps "$service"); then
		log "$service: failed to start the container that recreates it on $image"
		return 1
	fi

	log "$service: recreating on $image from container $helper"
}

check() {
	if ! containers=$(docker ps --quiet --no-trunc \
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
		[ "$container" = "$SELF" ] || update "$container"
	done

	# Last, since recreating the updater ends this run.
	for container in $containers; do
		[ "$container" != "$SELF" ] || update "$container"
	done
}

while :; do
	check
	sleep "$CHECK_INTERVAL"
done
