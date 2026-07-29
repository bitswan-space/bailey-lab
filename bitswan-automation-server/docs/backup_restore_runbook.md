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

To apply a file restore to the live tree:

1. `docker compose -p <W>-site down` in the workspace's deployment dir
   (stops gitops + driver; BP containers keep running).
2. rsync the restored tree over `~/.config/bitswan/workspaces/<W>/`
   (inside the daemon container, or on the volume directly):
   `rsync -a --delete <restore-dir>/…/workspaces/<W>/ ~/.config/bitswan/workspaces/<W>/`
3. `bitswan workspace update <W>` — re-renders compose from the restored
   `metadata.yaml` and brings gitops back up.

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

## Failure modes

- One workspace failing (stopped container, wrong driver token) never
  aborts the run — check `bitswan backup status` for per-step outcomes.
- A run interrupted mid-flight leaves a stale repo lock; the next run
  clears it automatically (`restic unlock` — the daemon is the only writer).
- Old per-workspace backups (the gitops-era repos, one bucket per
  workspace) remain readable through AOC's workspace-scoped proxy routes
  during the deprecation window; restore them with plain restic + the
  workspace's own key.
