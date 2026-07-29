# Server-level backup & restore runbook

The automation-server daemon makes a nightly (02:00 UTC) backup of the
**entire server** into one restic repository, reached through AOC's restic
REST proxy (one S3 bucket per server, `<server>--server`). Workspaces run no
backup jobs and hold no backup credentials.

## What one nightly run contains

Per workspace (tag `files`, `ws:<name>`):
- the whole `workspaces/<name>/` tree from the `bitswan` volume — workspace
  repo + copies, gitops worktree, **secrets/** (AES key, DB/Garage creds, BP
  env files), `metadata.yaml`, canonical bare git repos (`git-repos/`),
  `deploy-repos/`, per-BP stage `snapshots/`, generated compose files
  (`deployment/`, incl. the `.rollback` compose).

Per workspace × enabled stage (tags `postgres|couchdb|garage`, `ws:<name>`,
`stage:<stage>`): logical dumps — `pg_dumpall`, a CouchDB JSON-export
tarball, a Garage bucket tar (rclone sync). A stage is enabled iff its
secrets env file exists; stopped containers are skipped, not failed.

Server state (tag `server-config`): `automation_server_config.toml` (holds
the AOC registration + tokens) and a `VACUUM INTO` copy of `bailey.db`
(users, devices, MFA, access grants).

**Not** backed up: Kafka data, physical DB volumes (logical dumps only),
build-proxy caches, the grype DB.

## The encryption key is the crown jewels

Backups now include workspace secrets, so treat the restic key accordingly:

- It lives at `~/.config/bitswan/backup/restic-key` (0600) inside the
  daemon's config volume and is escrowed at AOC on first generation.
- Download a copy and store it OFF the server: `bitswan backup key show`.
- `bitswan backup key mirror-status` tells you whether AOC holds it. If the
  escrow was deleted and the server is lost, **backups are unrecoverable
  without your downloaded copy.**

## Day-2 operations

```
bitswan backup status                # config, key state, last run per workspace
bitswan backup run --wait            # manual run, streamed
bitswan backup retention --daily 30 --monthly 12
bitswan backup snapshots [--workspace W] [--tag postgres]
```

## Targeted restore (existing server)

Databases (REPLACES the stage's current data — for production prefer the
per-BP DR flow in the workspace dashboard, which restores into the isolated
DR slot first):

```
bitswan backup restore postgres --workspace W --stage staging [--snapshot ID]
bitswan backup restore couchdb  --workspace W --stage staging [--snapshot ID]
```

Workspace files (non-destructive — lands in a staging dir):

```
bitswan backup restore files --workspace W [--snapshot ID]
# → ~/.config/bitswan/backup/restores/W/<timestamp>/
```

To apply a file restore to the live tree (verified end-to-end by a
destroy-and-recover drill — see "Drill notes" below):

1. `docker compose -p <W>-site down` in the workspace's deployment dir
   (stops gitops + driver; BP containers keep running).
2. Move the restored tree into place. The restore is nested under the
   snapshot's absolute path, and there is **no rsync in the daemon image** —
   use `mv` (same volume, so it is atomic) or `cp -a`:
   ```
   R=~/.config/bitswan/backup/restores/<W>/<timestamp>/root/.config/bitswan/workspaces/<W>
   rm -rf ~/.config/bitswan/workspaces/<W> && mv "$R" ~/.config/bitswan/workspaces/<W>
   ```
3. Bring the workspace back up. **Prefer `bitswan rollback <W>`** over
   `workspace update`: update REGENERATES the compose and re-resolves images
   from Docker Hub, which discards the restored image pins (fatal for a
   workspace built with `--dev`, whose `-dev` images exist only locally —
   compose then fails on `pull access denied`). `rollback` re-applies the
   compose that came out of the backup verbatim.
   If you do run `workspace update`, pass the same flags the workspace was
   created with (`--dev` / `--staging`), or `rollback` afterwards — update
   snapshots the pre-update compose, so the restored one is recoverable.
4. Recreate EVERY container that mounts a subpath of the workspace
   directory — not just the `-site` project. Docker binds a volume-subpath
   mount to the directory's **inode** at container-create time, so any
   container that existed before you replaced the directory keeps pointing at
   the deleted one and sees an empty mount (symptoms: dashboard file tree
   empty, coding-agent SSH falling back to a password prompt because
   `/workspace/.ssh` looks empty). From the deployment dir:
   ```
   docker compose -f docker-compose-dashboard.yml    -p <W>-dashboard    up -d --force-recreate
   docker compose -f docker-compose-coding-agent.yml -p <W>-coding-agent up -d --force-recreate
   ```
5. Re-apply the deployments so the driver recreates infra services and BP
   containers (fresh service volumes start empty): `bitswan automation start
   <any-deployment> --workspace <W>`. One apply reconciles the whole
   workspace. **The CLI may time out while the daemon keeps working** — a
   cold reconcile of many BPs exceeds the client timeout; check
   `docker ps` rather than retrying.
6. Restore the databases into the now-running containers:
   `bitswan backup restore postgres --workspace <W> --stage <stage>` (and
   `couchdb`) for every enabled stage.
7. Restore Garage buckets — still manual, see below.

### Garage object data (manual)

```
# in the daemon container, with the restic env exported (see below)
restic restore latest --tag "garage,ws:<W>,stage:<stage>" --target /tmp/g
tar xf /tmp/g/…/garage-<stage>-backup-<ts>.tar          # → garage-backup/<bucket>/…
# then, per bucket, from inside the stage's rclone toolbox:
rclone --s3-provider Other --s3-endpoint http://<W>-garage[-stage]:9000 \
  --s3-region us-east-1 --s3-access-key-id <_system AK> \
  --s3-secret-access-key <_system SK> sync /tmp/garage-backup/<bucket> :s3:<bucket>
```

The `_system` credentials are at
`workspaces/<W>/secrets/garagecreds/<stage>/_system`. Note the driver
re-creates the buckets empty during step 4, so a DB restored without this
step leaves dangling object references (rows pointing at missing keys).

Restic env for ad-hoc commands inside the daemon (keys are indented under
`[aoc]` in the TOML, so grep by name, not `^key`):

```
CFG=~/.config/bitswan/automation_server_config.toml
export RESTIC_REPOSITORY="rest:$(grep aoc_url $CFG | cut -d'"' -f2)/api/automation_server/backups/repo/"
export RESTIC_REST_USERNAME="$(grep automation_server_id $CFG | cut -d'"' -f2)"
export RESTIC_REST_PASSWORD="$(grep access_token $CFG | cut -d'"' -f2)"
export RESTIC_PASSWORD="$(cat ~/.config/bitswan/backup/restic-key)"
```

## Full-server bootstrap (disaster recovery)

On a fresh host:

1. Install bitswan + daemon (`bitswan automation-server-daemon init`).
2. Recover the server identity — either restore
   `automation_server_config.toml` from the old server's `server-config`
   snapshots (needs the downloaded key: point plain `restic` at
   `rest:<AOC>/api/automation_server/backups/repo/` with
   `RESTIC_REST_PASSWORD=<old access token>` — or re-register and ask an AOC
   admin to re-point the old bucket), or `bitswan register` with a fresh OTP
   and keep the same server record so the token still matches the bucket.
3. Place the restic key: write your downloaded copy to
   `~/.config/bitswan/backup/restic-key` (0600) in the daemon volume — or,
   if the AOC escrow still exists, the daemon recovers it automatically on
   startup (`EnsureEnabled`).
4. Per workspace:
   a. `bitswan backup restore files --workspace W` and move the tree into
      `~/.config/bitswan/workspaces/W/` (step list above).
   b. `bitswan workspace update W` — recreates containers from the restored
      compose/metadata/secrets.
   c. `bitswan backup restore postgres --workspace W --stage <each enabled
      stage>` and the same for couchdb.
   d. Garage data: **manual** in v1 — extract the `garage-*.tar` from the
      garage snapshot (`restic restore` + untar) and `rclone sync` each
      bucket dir back through the workspace's garage toolbox container.
5. Verify: open each workspace dashboard; for production BPs run the DR
   rehearsal (restore into DR, verify by hand) before trusting the result.

## Drill notes (what a real destroy-and-recover proved)

A full drill on a live workspace — 23 containers, Postgres + Garage on two
stages, 1062 files — removed every container, deleted all six service data
volumes, and `rm -rf`'d the workspace tree, WITHOUT going through
`bitswan workspace remove`. Outcome:

- The restored tree was **bit-identical** to the original (1062 files, no
  differing hashes), secrets and `.aes-key` included.
- gitops came back knowing every deployment from the restored
  `bitswan.yaml` (stages, version hashes, URLs) — declared but not running
  until step 4's apply, which recreated all 23 containers and the volumes.
- Postgres restored to identical row counts and content; Garage needed the
  manual step above (the DB otherwise references missing objects).
- Two provisioner bugs had to be fixed for the workspace to come back
  working at all, both triggered by restoring secrets onto a REBUILT Garage
  (its metadata volume stores buckets *and* access keys, so wiping it
  invalidates every key the restored secrets name):
  1. a creds file naming a non-existent key was never re-minted (only an
     empty file was), so backends stayed AccessDenied forever;
  2. once re-minted pre-compile, `reconcileGarageBuckets` skipped the bucket
     as "fully provisioned" (bucket + key both exist) and never granted the
     new key on it — a key owning nothing.
  Both are fixed in `provision.go`; the symptom to recognise is
  `No such key: GK…` or `Access Denied` from an app's S3 client.
- AOC kept the original workspace UUID and its Keycloak client/group, so no
  re-registration was needed.

**Do NOT use `bitswan workspace remove` to rehearse this.** It is a hard
teardown (volumes, networks, ingress routes, TLS, images, files) and on
success the daemon calls `syncWorkspaceListToAOC()`; AOC then treats the
unreported workspace as a zombie and DELETES it, tearing down its Keycloak
client, editor group and MQTT topics. That state lives in AOC's Postgres and
is **not** in the server backup, so recovery would mean re-registering with a
new workspace id — the restored `metadata.yaml` would be stale. Simulate host
loss instead (containers + volumes + tree), which is the scenario the backup
actually covers.

## Failure modes

- One workspace failing (stopped container, wrong driver token) never
  aborts the run — check `bitswan backup status` for per-step outcomes.
- A run interrupted mid-flight leaves a stale repo lock; the next run
  clears it automatically (`restic unlock` — the daemon is the only writer).
- Old per-workspace backups (the gitops-era repos, one bucket per
  workspace) remain readable through AOC's workspace-scoped proxy routes
  during the deprecation window; restore them with plain restic + the
  workspace's own key.
