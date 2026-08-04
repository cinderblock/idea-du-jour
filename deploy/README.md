# Deploying idea-du-jour to firefly

idj uses the **house runner pattern** (same as `bins`, `camptool`, `smtp-bridge`):
an isolated container on firefly holds a self-hosted GitHub Actions runner **and**
the app. Pushing to this repo runs the app's own `deploy.yml` *on that runner*,
which builds, stages a release, flips a symlink, and restarts the app. Caddy
reaches the app over a shared unix socket — the container publishes no ports.

```
push idj ─▶ deploy.yml on [self-hosted, idj]   (runner lives in the container)
                │ bun install && bun run build
                │ stage /srv/idj/releases/<sha>  →  ln -sfn current  →  touch restart
                ▼
   supervisord restarts `app`  ──▶  Nitro on 127.0.0.1:3000
                                          ▲
                    socat bridge ─────────┘   exposes /run/idj/idj.sock
                                          ▲
Cloudflare (idj.isozilla.com) ─▶ Caddy ───┘   reverse_proxy unix//run/idj/idj.sock
```

**Why socat:** `bins` hand-rolls `Bun.serve({ unix })` so it binds the socket itself.
idj is served by **Nitro** (the server engine under TanStack Start), whose listener
only accepts a TCP port — neither the node nor bun preset (nor srvx underneath) can
bind a unix socket. socat bridges it inside the container, so the *external* contract
still matches bins exactly.

## Layout on the host

| Path | What |
|---|---|
| `/srv/idj/releases/<sha>/` | staged release trees (last 5 kept) |
| `/srv/idj/current` | symlink → the active release |
| `/srv/idj/data/idj.db` | SQLite append-only log + projection (durable state) |
| `/srv/idj/restart` | sentinel; `touch` restarts the app |
| `/run/idj/idj.sock` | socket Caddy connects to (shared volume) |

## Repo pieces

- **`run`** — release entrypoint (supervisord runs `/srv/idj/current/run`): applies
  migrations, then serves `.output/server/index.mjs`.
- **`.github/workflows/deploy.yml`** — build → stage → activate → verify `/api/version`
  reports this commit's SHA → prune old releases.
- **`src/routes/api/version.ts`** — reports `BUILD_SHA` so the deploy can prove the
  supervisor restarted into the *new* release.

## ops-side (provisioning; gated infra changes)

Lives in `cinderblock/ops`:

- `containers/idj-runner/` — the runner+app image (Dockerfile, entrypoint, supervisord,
  socket-bridge, restart-watcher).
- `servers/firefly/idj-runner/compose.yml` + `servers/firefly/ensure-idj-runner.sh` —
  brings the container up; writes the app env-file (generates and **reuses**
  `SESSION_SECRET` so passkey sessions survive deploys).
- `.github/workflows/deploy.yml` — `detect-idj-stack`, `idj-runner-token`,
  `install-idj-runner` jobs.
- `servers/firefly/docker-compose.yml` + `sites.d/idj.isozilla.com.caddy` — Caddy mounts
  `idj_sock` and proxies to the socket.

### One-time setup in ops

The runner registration needs a token, and **ops holds it** (the app repo never does):

1. Create a PAT that can administer self-hosted runners on `cinderblock/idea-du-jour`
   (fine-grained: repo `idea-du-jour`, **Administration: Read and write**).
2. In the **ops** repo, create a GitHub **environment** named `idj-runner` and add the
   PAT as the secret **`IDJ_RUNNER_PAT`**.

The `idj-runner-token` job (GitHub-hosted, in that environment) mints a short-lived
(~1h) registration token and hands only that to the box-side install job — the PAT
never reaches firefly.

## Updating

`git push` → deploy.yml runs on the in-container runner → new release is live in
under a minute, verified by the `/api/version` health check. No ops involvement, no
cross-repo tokens from idj.

## Admin commands on the box

```sh
docker exec -u runner -w /srv/idj/current idj-runner bun run token:mint agent "label"
docker exec -u runner -w /srv/idj/current idj-runner bun run db:rebuild
docker logs --tail 50 idj-runner
```
