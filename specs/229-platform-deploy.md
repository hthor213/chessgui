# 229: Deploy via the platform registry

**Status:** active
**Depends on:** 217 (arena stack), 221 (web stack); home-platform spec 022
(`platform/bin/deploy`), spec 021 (Caddyfile rendered from the registry)

## Why

Until now `deploy.sh` ran `git pull` + two `docker compose up -d --build`
inside `~/code/chessgui/server/{web,arena}` — whatever was checked out on the
homeserver, committed or not, with the arena's private data (sqlite, nets,
private personas) bind-mounted from the working tree. home-platform spec 022
replaces every per-repo deploy script with one command driven by
`services.chess` in `platform/config.yml`: the source of the running service
is `/srv/chess/src`, a clean clone of this repo's `main`; ports, bind
address, container name and data directory arrive as `PLATFORM_*`; nothing is
ever deployed from a home-directory checkout again.

## Decisions

- **One service key, one compose project, two services.** The registry
  already keys both containers as `services.chess` (`container:
  chessgui-web` on `container_port`, `containers: [chessgui-arena]` on
  `api_port`, both `/chess/*` routes). Splitting into `chess_web` /
  `chess_arena` would have forked the registry entry that Caddy rendering
  and `registry-check` hang off. So `server/web/docker-compose.yml` and
  `server/arena/docker-compose.yml` merge into **`server/docker-compose.yml`**
  (compose project `chess`, services `web` + `arena`);
  `services.chess.compose_file` names it.
- **Ports from the registry, internal ports from the Dockerfiles.** `web`
  publishes `${PLATFORM_BIND}:${PLATFORM_PORT}:80`, `arena`
  `${PLATFORM_BIND}:${PLATFORM_API_PORT}:8000` (spec 022 gained the
  `api_port` → `PLATFORM_API_PORT` export for this). 80 and 8000 are facts of
  `server/web/nginx.conf` and `server/arena/Dockerfile`, not of the registry.
- **The sidecar keeps its name in the file.** `container_name: chessgui-arena`
  is spelled out (the registry lists it under `containers:`; `registry-check`
  verifies it exists). `web` takes `${PLATFORM_CONTAINER}`.
- **Data layout on the host.** `/srv/chess/src` (clone), `/srv/chess/data/`
  holds what the arena mounts and git never sees: `arena/` (sqlite),
  `nets/` (BT3 + maia, sha-pinned), `private-personas/`. `data/personas`
  (committed books + configs) mounts **from the clone**, not from
  `/srv/chess/data` — a copy would drift from the repo. The arena's env file
  is `/srv/chess/arena.env` (`cp -p` from the old checkout; never in git).
- **`deploy.sh` is a five-line stub** that execs `platform/bin/deploy chess`
  with the same flags (`--dry-run`, `--ref`).

## Done When

- [ ] `server/docker-compose.yml` exists and every host-facing value is a
      `${PLATFORM_*:?}` guard: `python3 -c "import re,sys; s=open('server/docker-compose.yml').read(); sys.exit(0 if all(k in s for k in ['PLATFORM_SRC_DIR:?','PLATFORM_CONTAINER:?','PLATFORM_BIND:?','PLATFORM_PORT:?','PLATFORM_API_PORT:?','PLATFORM_DATA_DIR:?','PLATFORM_DEPLOY_DIR:?']) and not re.search(r'127\.0\.0\.1:80\d\d', s) else 1)"`
- [ ] `python3 -c "import os,sys; sys.exit(0 if not os.path.exists('server/web/docker-compose.yml') and not os.path.exists('server/arena/docker-compose.yml') else 1)"` — the per-project compose files are gone.
- [ ] `python3 -c "import sys; s=open('deploy.sh').read(); sys.exit(0 if 'platform/bin/deploy\" chess' in s and len(s.strip().splitlines())<=5 else 1)"` — `deploy.sh` is the stub.
- [ ] A real `platform/bin/deploy chess` run on the homeserver (not something
      the harness executes on every check) recreates both containers from
      `/srv/chess/src`; afterwards `https://spliffdonk.com/chess/` returns
      200, `/chess/api/personas` returns its pre-migration 401 (auth wall,
      unchanged), `chessgui-arena` is healthy with the mounts
      `/srv/chess/data/{arena,nets,private-personas}` and
      `/srv/chess/src/data/personas`, and `registry-check` is green.
