#!/bin/sh
# Deploys one build of Parley on the server. .github/workflows/deploy.yml
# copies this directory's files to /opt/parley and runs it over SSH, after
# logging the server in to GHCR:
#
#   IMAGE_TAG=<git sha> PARLEY_DOMAIN=<domain> sh /opt/parley/deploy.sh
#
# Secrets come from Doppler's prd config, read with the service token in
# /etc/parley/doppler-token (README.md, "Set up the server").
set -eu

: "${IMAGE_TAG:?set IMAGE_TAG}" "${PARLEY_DOMAIN:?set PARLEY_DOMAIN}"
cd "$(dirname "$0")"

DOPPLER_TOKEN=$(cat /etc/parley/doppler-token)
export DOPPLER_TOKEN

compose() {
  doppler run -- docker compose -f compose.yaml -f compose.prod.yaml "$@"
}

# compose.yaml falls back to a fixed broker password for the local stack.
# Stop before touching anything rather than deploy with it.
if ! doppler run -- sh -c '[ -n "${RABBITMQ_PASSWORD:-}" ]'; then
  echo "RABBITMQ_PASSWORD is not set in Doppler's prd config" >&2
  exit 1
fi

compose pull
# migrate runs to completion before the API starts (compose.yaml).
# --wait returns once everything is running and healthy, so a broken build
# fails the workflow instead of passing quietly.
compose up -d --remove-orphans --wait --wait-timeout 300

# A container can still crash soon after --wait sees it healthy, and Docker
# restarts it, so give it time to, then fail if anything restarted.
restarts() {
  # One argument per container id, so the split is the point.
  # shellcheck disable=SC2046
  docker inspect -f '{{.Name}} {{.RestartCount}}' $(compose ps -aq) | sort
}
before=$(restarts)
sleep 30
after=$(restarts)
if [ "$before" != "$after" ]; then
  echo "Containers restarted after starting (name, restarts):" >&2
  echo "$after" >&2
  compose logs --tail 30 >&2
  exit 1
fi

# Parley's site on the shared proxy. A reload that fails keeps the running
# config, and fails this script.
sed "s/__PARLEY_DOMAIN__/$PARLEY_DOMAIN/" parley.caddy > /opt/proxy/caddy/sites/parley.caddy
docker compose -f /opt/proxy/compose.yaml exec -T caddy \
  caddy reload --config /etc/caddy/Caddyfile

# Old builds' images, once nothing uses them, so the disk doesn't fill.
docker image prune -af --filter "until=72h" > /dev/null
