FROM alpine:3.24

# cosign stays on the release the workflow signs with, so both read the same bundle format.
RUN apk add --no-cache cosign~3.0 crane docker-cli docker-cli-compose

COPY --chmod=755 update.sh /usr/local/bin/update

# The docker CLI and cosign keep their config and TUF cache under HOME, which must be the writable tmpfs.
ENV HOME=/tmp

ENTRYPOINT ["/usr/local/bin/update"]
