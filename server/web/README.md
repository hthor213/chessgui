# ChessGUI Web Client (spec 221)

Static export of `apps/web` served by nginx on **127.0.0.1:8018**, container
`chessgui-web`. Public exposure is Caddy only:
`https://www.spliffdonk.com/chess`.

The Dockerfile is multi-stage: pnpm builds the workspace static export
(`NEXT_PUBLIC_ARENA_API_BASE=/chess` baked in at build time), nginx:alpine
serves it with the COOP/COEP headers required for SharedArrayBuffer
(multi-threaded stockfish WASM). Build context is the repo root — the root
`.dockerignore` allowlists the build inputs.

## Deploy (spec 229 — owned by home-platform, spec 022)

```bash
./deploy.sh            # = platform/bin/deploy chess: clone main into /srv/chess/src,
                       #   docker compose -p chess -f server/docker-compose.yml up -d --build
./deploy.sh --dry-run  # print every command, run only the read-only checks
```

Both containers (this one and the arena) are one compose project defined in
`server/docker-compose.yml`; ports, bind address, container name and data
directories arrive as `PLATFORM_*` from `platform/config.yml`
(`services.chess`). Nothing runs from a `~/code` checkout.

Verify:

```bash
curl -sI http://127.0.0.1:8018/ | grep -i cross-origin   # COOP + COEP present
docker inspect --format '{{.State.Health.Status}}' chessgui-web   # healthy
```

## Caddy (rendered from home-platform `domains:` by `render-caddy`, spec 021)

Order matters — the api block must win over the static one (the
`chess-api` route template carries this note):

```
redir /chess /chess/ permanent
handle /chess/api/* {
    uri strip_prefix /chess
    reverse_proxy 127.0.0.1:8017
}
handle_path /chess/* {
    reverse_proxy 127.0.0.1:8018
}
```

## Not in this stack

The `arena.db` backup timer (spec 221 "Deployment mechanics") is a host-level
systemd timer following the forgejo-backup.sh pattern — it belongs to the
server deploy, not this compose file. Install it alongside the Caddy routes.
