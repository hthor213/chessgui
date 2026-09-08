#!/usr/bin/env bash
# Deploys are owned by home-platform (spec 022; chessgui spec 229): `platform/bin/deploy chess`
# clones this repo's main into /srv/chess/src on homeserver and runs server/docker-compose.yml there.
set -euo pipefail
exec "${HOME_PLATFORM_DIR:-$HOME/code/home-platform}/platform/bin/deploy" chess "$@"
