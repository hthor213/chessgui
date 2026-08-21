#!/bin/bash
# Deploy chessgui web + arena on homeserver (spec 221).
# Mac Studio is a workstation, never a target.
#
# Deploy = git pull --ff-only + docker compose up -d --build in server/web/
# and server/arena/ on the homeserver checkout, then a health check of the
# public /chess/ route through Caddy.
#
# Usage: ./deploy.sh [--dry-run]
#   --dry-run   print the commands that would run; run nothing.
#
# Needs a home-platform checkout ($HOME_PLATFORM_DIR or a known clone path);
# platform/lib/common.sh decides whether "homeserver" is this machine (then
# ssh_to runs `bash -c` locally — never loopback ssh) or a remote host.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

_hp=""
for _c in "${HOME_PLATFORM_DIR:-}" "$HOME/code/home-platform" \
          "$HOME/github/home-platform" "$HOME/Documents/GitHub/home-platform"; do
    [[ -n "$_c" && -f "$_c/platform/lib/common.sh" ]] && { _hp="$_c"; break; }
done
[[ -n "$_hp" ]] || { echo "home-platform checkout not found (set HOME_PLATFORM_DIR)" >&2; exit 1; }
# shellcheck source=/dev/null
source "$_hp/platform/lib/common.sh"

HOST="homeserver"
LOCATION="$(get_location)"
CODE_DIR="$(host_path_prefix "$HOST" 2>/dev/null || true)"
CODE_DIR="${CODE_DIR:-/home/hjalti}/code/chessgui"
HEALTH_URL="${CHESSGUI_HEALTH_URL:-https://www.spliffdonk.com/chess/}"

REMOTE_CMD="cd $CODE_DIR \
&& git pull --ff-only \
&& docker compose -f server/web/docker-compose.yml up -d --build \
&& docker compose -f server/arena/docker-compose.yml up -d --build"

if host_is_local "$HOST"; then
    MODE="local (bash -c)"
else
    MODE="ssh"
fi
echo "chessgui deploy → $HOST [$LOCATION, $MODE] checkout=$CODE_DIR"

if [[ "$DRY_RUN" == "1" ]]; then
    echo "[dry-run] ssh_to $HOST \"$REMOTE_CMD\""
    echo "[dry-run] health: curl -fsS -o /dev/null $HEALTH_URL (retry up to 10x, 3s apart)"
    exit 0
fi

ssh_to "$HOST" "$REMOTE_CMD"

echo "Health check: $HEALTH_URL"
ok=0
for i in $(seq 1 10); do
    if curl -fsS -o /dev/null --max-time 10 "$HEALTH_URL"; then
        ok=1; break
    fi
    echo "  attempt $i/10 failed, retrying in 3s..."
    sleep 3
done
if [[ "$ok" != "1" ]]; then
    echo "HEALTH CHECK FAILED: $HEALTH_URL" >&2
    exit 1
fi
echo "Deploy complete: chessgui web + arena on $HOST, $HEALTH_URL is up"
