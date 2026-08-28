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

Server state (tag `server-config`) — everything that makes a host *this*
server, captured at **real absolute paths** so a recovery can
`restic restore --target /` straight into the `bitswan` volume:

| Path | Why it must be there |
|---|---|
| `automation_server_config.toml` | identity: AOC url, server id, token, relay, domains |
| `bailey.db.snapshot` | users, devices, MFA, access grants — a `VACUUM INTO` copy, never the live file |
| `traefik/` | **`rest-state.json` is the global route table**, plus `acme/` (LE account + every cert) and operator-supplied `certs/` |
| `protected-proxy/` | `cookie-secret`, the session **and** CSRF key — losing it logs everyone out |
| `certauthorities/` | operator CA PEMs, mounted into every workspace container |
| `backup/config.json` | enabled flag + retention policy |
| `server-manifest.json` | what this server was: workspaces, image pins, versions (below) |

`rest-state.json` is the one with no way back: a missing file makes
`InitTraefik` write an *empty* `dynamic.yml`, and gitops's `/ingress/reconcile`
decides "in sync" from `bailey.db` alone — so every route looks fine and none
gets re-pushed.

Business-process images (tag `images`) — one `docker save` of every named
`internal/*` image, streamed straight into the repo as `internal-images.tar`.

gitops can already rebuild a missing image from the revision `bitswan.yaml`
records, and lands on the same tag because the tag hashes the *source tree*.
That is provenance, not content: if a workspace's `image/Dockerfile` does an
unpinned `pip install`, if `build.sh` fetches, or if an upstream `FROM` moves,
the rebuild reproduces the tag over different bytes — and it needs working
network egress at the worst possible moment. Saving the archive makes a recovery
restore *the* image rather than *an* image. Both paths stay: an archive is
architecture-specific, so recovering onto different hardware still rebuilds.

Cheaper than it looks, because tags alias heavily — one live server had 103
`internal/*` tags behind 26 distinct images, ~2.4 GB of unique layers. `docker
save` given every tag at once writes each layer once and records all the tag
mappings, so one archive restores all 103 names. The tags are content-addressed
and never change, so restic dedupes later runs to near nothing: the first
snapshot after enabling is the only expensive one. Switch it off with
`{"images": false}` in `backup/config.json`; absent means on.

**Not** backed up: Kafka data, physical DB volumes (logical dumps only),
build-proxy caches, the grype DB, and **the mkcert CA** (`bitswan-mkcert`)
— a CA signing key stays out of off-site storage by policy. After a rebuild,
`.localhost` certs are re-minted under a new CA that developers must re-trust;
the manifest records the old CA's fingerprint so a mismatch is detectable.
Irrelevant for ACME servers.

The capture is an explicit path list, not "the config dir minus excludes" —
so no exclude bug can ever sweep in `backup/pre-recover/` (whole quarantined
workspace trees) or `backup/restic-key`, which would put the repo's own
decryption key inside the repo it decrypts.

## The encryption key is the crown jewels

Backups include workspace secrets, so the key **is** the data:

- It lives at `~/.config/bitswan/backup/restic-key` (0600) inside the daemon's
  config volume, and **nowhere else**. There is no escrow: it is never stored
  in AOC or in object storage, by design.
- Download a copy and store it off the server: `bitswan backup key show`.
- Until you confirm you have, `backup status`, every nightly run and the
  console say so loudly. Record it with
  `bitswan backup key show --acknowledge`.
- If this server is lost and you have no copy, **every backup is permanently
  unreadable** — by you, by us, by anyone. Nothing in the recovery flow can
  work around that, which is why it is the first thing the disaster-recovery
  dialog tells you.

## Day-2 operations

```
bitswan backup status                # config, key state, last run per workspace
bitswan backup run --wait            # manual run, streamed
bitswan backup retention --daily 30 --monthly 12
bitswan backup snapshots [--workspace W] [--tag postgres]
bitswan backup manifest              # what the latest backup says this server is
```

## The server manifest

Written fresh into every server snapshot, and the first thing a recovery
reads — because a bare machine knows none of it. Most of it exists nowhere
else at all: the `BITSWAN_*` **image pins live only in the daemon container's
environment**, so a rebuilt server silently reverts to defaults without them.

It also records the **bitswan version** that made the backup. A recovery run
by a different version warns and continues — restores are expected to work
across versions, and blocking a disaster recovery over a version difference
would be worse than the risk it names.

`bitswan backup manifest` reads it on a live server. On a machine with no
daemon — mid-recovery, or just to check a backup is readable before committing
to a rebuild — the same command takes the inputs directly:

```
bitswan backup manifest \
  --aoc-api https://api.example.com --server-id <id> \
  --token <token from the recovery OTP> --key-file ./backup-encryption-key.txt
```

restic is not in the bitswan binary — it ships in the runtime image — so this
mode runs restic in a throwaway container. Docker is the only prerequisite.

## Recovering a whole workspace

One command takes a workspace from destroyed-or-broken back to running with its
data. It restores the tree, recreates every container that mounts it, re-applies
the deployments so the driver rebuilds the infra services and business-process
containers, then reloads the databases and object storage for each enabled
stage:

```
bitswan backup recover workspace <W>            # a workspace that is gone
bitswan backup recover workspace <W> --force    # replace one that still exists
bitswan backup recover workspace <W> --dry-run  # show the plan, change nothing
```

It runs as a job and streams a step-by-step report; a cold apply outlives any
client timeout, so there is nothing to wait on locally. The whole current state
of the workspace is replaced, which is why an existing workspace needs `--force`
and the CLI asks you to type the name.

Useful flags:

| Flag | Effect |
|---|---|
| `--snapshot ID` | anchor on a specific file-tree snapshot (point-in-time); the databases are taken from the SAME backup run |
| `--stage S` | only this stage (repeatable) |
| `--skip-files` | keep the current tree; only rebuild containers and reload data |
| `--skip-postgres` / `--skip-couchdb` / `--skip-garage` | leave that data alone |
| `--garage-mirror` | mirror Garage instead of copying — **deletes** objects absent from the backup |
| `--discard-previous` | delete the quarantined pre-recovery tree on success (kept by default) |

The previous tree is renamed aside to
`~/.config/bitswan/backup/pre-recover/<W>-<ts>` before anything is written, and
put back automatically if the restore fails. Each recovery's report is kept at
`~/.config/bitswan/backup/recoveries/<W>-<ts>.json`.

Reading the report: any step before `verify-tree` failing means nothing was
changed (or the rollback already ran). Steps after it are independent — a failed
`postgres:staging` does not stop `garage:production`, and the summary lists
exactly what needs re-running. Re-run with `--skip-files` to resume from the
container stage without touching the tree again.

### Targeted restore (single piece)

For repairing one thing rather than recovering a workspace. Databases REPLACE
the stage's current data — for production prefer the per-BP DR flow in the
workspace dashboard, which restores into the isolated DR slot first:

```
bitswan backup restore postgres --workspace W --stage staging [--snapshot ID]
bitswan backup restore couchdb  --workspace W --stage staging [--snapshot ID]
bitswan backup restore garage   --workspace W --stage staging [--snapshot ID]
```

Workspace files, non-destructively into a staging dir (for inspection or a
hand-driven recovery):

```
bitswan backup restore files --workspace W [--snapshot ID]
# → ~/.config/bitswan/backup/restores/W/<timestamp>/
```

### Doing it by hand

Only needed if the command itself is unavailable. This is what it automates, and
every step is here because omitting it broke something in a real drill:

1. `docker compose -p <W>-site down` in `<wsDir>/deployment`.
2. Move the restored tree into place. The restore is nested under the snapshot's
   absolute path, and there is **no rsync in the daemon image**:
   ```
   R=~/.config/bitswan/backup/restores/<W>/<ts>/root/.config/bitswan/workspaces/<W>
   rm -rf ~/.config/bitswan/workspaces/<W> && mv "$R" ~/.config/bitswan/workspaces/<W>
   ```
3. Bring the site up with the RESTORED compose — `bitswan rollback <W>`, or
   `docker compose -p <W>-site up -d --force-recreate`. Do **not** use
   `bitswan workspace update`: it regenerates the compose and re-resolves images,
   discarding the restored pins (fatal for a `--dev` workspace, whose images
   exist only locally — compose then fails with `pull access denied`).
4. Recreate **every** container that mounts the workspace tree, because Docker
   binds volume-subpath mounts to the directory *inode* at create time and a
   survivor silently reads the deleted one:
   - dashboard and coding-agent: `docker compose -f docker-compose-<svc>.yml -p <W>-<svc> up -d --force-recreate`
   - the sub-traefik, which subpath-mounts `traefik.yml` and `dynamic.yml` as
     single FILES: `docker rm -f <W>__traefik` then let the daemon recreate it
   - the driver's BP and infra containers, which are in the driver's own compose
     project and which `compose up` will not recreate while the compose content
     is unchanged: `docker rm -f $(docker ps -aq --filter label=gitops.workspace=<W>)`
5. Re-apply so the driver rebuilds infra services and BP containers (their
   volumes come back EMPTY):
   `bitswan automation start <any-deployment> --workspace <W>`. **The CLI may
   time out while the daemon keeps working** — check `docker ps`, don't retry.
6. `bitswan backup restore postgres|couchdb --workspace <W> --stage <stage>` per
   enabled stage.
7. `bitswan backup restore garage --workspace <W> --stage <stage>` per enabled
   stage — **after** the apply, which re-mints the `_system` key the restore
   authenticates with.

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

### Getting a token onto a machine that has nothing

This is the part that used to be a footgun. The AOC access token authenticates
the restic repo **and decides which bucket you reach** — and it normally lives
in the config file *inside* the backup. "Re-register into the same server
record" fails silently in exactly one direction: a new record, a new empty
bucket, and an operator who believes they have a backup.

So recovery has its own front door. On the AOC server card, take
**Recover** → it reports the state of the backup repository (bucket, snapshot
count, newest snapshot), refuses if there is nothing to restore, and hands you
a one-time password plus the command to run. The OTP is minted against the
**existing** server record, so the bucket resolves correctly by construction.

Two things to know before you run it:

- **You need your own copy of the encryption key.** There is no escrow. The
  dialog says so before you commit to a rebuild you cannot finish.
- **Redeeming the OTP replaces the server's access token**, which cuts off a
  server that is still alive (its own backups included) until it re-registers.
  Issuing the OTP does *not*, and neither does the recovery's preflight — the
  swap happens only after your key has been proven to open the repository and
  you have confirmed the plan. The card warns when the target still holds a
  live token.
- **A wrong key costs nothing.** The preflight opens the repository with the key
  you supply *before* exchanging the OTP, authenticating to the AOC with the OTP
  itself (which grants reads only). A key that does not work, a `--server-id`
  with no repo, or a repo still locked by a live server all stop the run with
  nothing changed and the OTP still valid — so you can retry with the right key.
  `--dry-run` likewise spends nothing.

Every issue is recorded in AOC (`DisasterRecoveryRequest`: who asked, which
server, when, whether it was redeemed, and whether it displaced a live token).
The OTP itself is not stored — only a fingerprint of it.

### On the replacement machine

One command. Docker is the only prerequisite:

```
curl -fsSL <AOC>/api/automation_server/recover.sh -o ~/bitswan-recover.sh && \
  sudo sh ~/bitswan-recover.sh --aoc-api "<AOC>" --otp "<otp>" --server-id "<id>"
```

It asks for the backup encryption key (pass `--key-file <path>` instead for an
unattended run), then works through six phases, printing each step:

| Phase | What it does |
|---|---|
| preflight | checks docker; refuses if this machine is already a *different* server; verifies your key opens the repository; reads the manifest and prints the plan — all read-only, then exchanges the OTP as its last act |
| state | creates the `bitswan` volume and restores the server's own state into it, **before any daemon exists** |
| daemon | re-applies the recorded image pins, then deploys the daemon |
| ingress | stores the new token, brings Traefik up on the restored route table, waits for it to serve, provisions the protected proxy, and tells the AOC where this server now lives |
| workspaces | loads the saved business-process images, then recovers each workspace — files, secrets, databases, object storage — rebuilding any image the archive did not carry |
| verify | confirms the world is served this server's own certificate |

Useful flags: `--dry-run` (print the plan and stop), `--skip-workspaces`,
`--workspace W` (repeatable), `--skip-image-rebuild`, `--snapshot` (recover from
an older point).

**If it fails partway, re-run it.** A token that still authenticates is detected
and reused, so a retry does not need a fresh OTP — and OTPs are single-use, with a
thirty-minute life for recovery (long enough to verify the key, read the plan and
decide). A run that failed *before* the exchange has not spent the OTP at all, so
re-run with the same one. Workspaces are fail-fast: the run stops at the first one
that fails rather than burying the cause.

### Which CLI version a recovery installs

The command the AOC hands out is pinned to the version the lost server was
running, so a rebuilt server comes back on the same build rather than on whatever
is newest. The daemon reports its version to the AOC at startup and on every
backup run, which means the recorded version describes the binary that wrote the
newest recovery point. The version is also inside each backup (the server
manifest), but restic encrypts it and the key is never escrowed — so the AOC's copy
is the only one readable before a binary exists to read the other.

The pin is dropped, and the newest release installed instead, when the recorded
version cannot be honoured: nothing was ever reported, it is a build from source
(no published release to fetch), or that build predates `recover server`. The
"Disaster recovery" dialog states which case applies before issuing anything.

### How business-process images come back

Two ways, tried in that order, because the ordinary converge does not build and a
missing image fails it outright.

**Loaded from the backup.** Runs first, before any workspace converges — a load
afterwards would never be reached. `restic dump` streams `internal-images.tar` out
of the newest `images` snapshot and pipes it into `docker load`, which restores
every tag the archive recorded. A backup with no archive (older than the feature,
or images switched off) is not an error: the step says so and the rebuild takes
over. So is a failed load — it is recorded red, the report warns that images will
be rebuilt, and the recovery continues.

**Rebuilt from the recorded revision.** For everything the archive did not carry,
including any recovery onto a different CPU architecture, where a saved archive is
useless. `bitswan.yaml` carries `source_commit` per deployment (and `git_commit`
per BP stage), and the BP's canonical bare repo lives inside the workspace tree
the backup captures, so the full source history is restored with it. The image tag
is a pure content address of the source tree, so extracting that commit reproduces
the pinned tag exactly — for promoted stages as much as for dev, and regardless of
how far the working copy has moved on since. Note this reproduces the *tag*, not
necessarily the bytes: see the `images` tag above for when that distinction bites.

Where a rebuild produces a *different* tag, the tree that was deployed was not the
tree that was committed (untracked files at deploy time, or a hand-built image).
Those deployments are named in the report and their pins are left untouched —
retagging would make a signed-off production tag name an artifact nobody approved.
They need a **re-promote**; their containers will not start until then.

The same resolution runs before a rollback converges, so rolling back to an older
commit works on a rebuilt host (and after any image prune) rather than failing on
a Docker Hub pull.

One thing the command cannot do for you, and reports at the end:

- **Re-trust the local CA** on `.localhost` setups. The mkcert CA is deliberately
  not backed up (a CA signing key does not belong off-site), so a rebuilt server
  mints a new one; the manifest records the old fingerprint.

Then verify production business processes by hand before trusting them.

<details>
<summary>Doing it by hand (if the command is unavailable)</summary>

The order is not negotiable — restoring after the daemon starts loses the route
table.

0. Check the backup is readable: `bitswan backup manifest --aoc-api <AOC>
   --server-id <id> --token <token> --key-file ./key`
1. `docker volume create bitswan`, then restore into it with restic in a
   container (`--target / --tag server-config latest`, volume mounted at
   `/root/.config/bitswan`, image = the manifest's `daemon_image`).
2. Rename `bailey.db.snapshot` → `bailey.db` in the volume; put the key at
   `backup/restic-key` (0600).
3. Reconcile the config: keep the **new** token and expiry, take domain, relay
   and protected domain from the restored file.
4. **Only now** `bitswan automation-server-daemon init`.
5. `bitswan ingress provision-protected-proxy` — nothing else creates it, and
   every protected hostname 502s until it exists.
6. Per workspace: `bitswan backup recover workspace W`.

</details>

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

**What that drill did NOT prove.** It removed containers and volumes but never
the local Docker **images**, so every `internal/<ws>-<bp>-<auto>-app:sha…` tag was
still present and the converge found what it needed. On a genuinely fresh host
those images are absent and the plain converge *fails* — the compiled compose
names a local-only tag with no build instructions, so compose tries to pull it
from Docker Hub. That is why `recover server` rebuilds images before converging,
and why a drill that means to prove bare-metal recovery has to delete the images
too.

A second drill wiped the whole server — daemon, traefik, protected proxy, the
`bitswan` volume (config, `bailey.db`, secrets, every workspace tree), the mkcert
volume and all workspace data volumes — and recovered it by hand. The route table,
TLS certificate (the *same* one: `acme.json` came back, so no re-issuance),
`bailey.db` row counts, Postgres and Garage contents all survived. It found the
three defects `recover server` now handles: nothing creates the protected proxy,
the AOC-dependent boot steps race Traefik, and the config merge was hand-editing a
TOML inside a volume.

A third drill did it properly: the same wipe **plus every `internal/dev-*` image**,
then the single command. **2m43s, zero manual steps.** What it proved:

- the workspace tree came back with **no files lost**; the 21 that differ are git
  refs the deploy push touched, re-minted Garage credentials (mandatory — the
  metadata volume was wiped, invalidating the old keys) and new build logs;
- `bailey.db` row counts identical across all 13 tables; 15 of 15 routers restored;
  Postgres and Garage identical on both stages; 23 of 23 containers back;
- **the same TLS certificate**, again;
- all four business-process images **rebuilt to byte-identical tags** — the content
  addressing works: gitops recomputed `sha8fe36734…` from unchanged source and it
  matched what `bitswan.yaml` pinned;
- `bailey.<domain>` answered 302 **without** anyone running
  `provision-protected-proxy`;
- the config kept `aoc_url` and `domain` with only the token and expiry replaced;
- re-running with no `--otp` detected the live token and resumed;
- the recovered server backed itself up green immediately afterwards.

The one sandbox-only concession: this host runs the AOC behind the very Traefik
being wiped, so the drill left Traefik in place to keep the AOC reachable. In
production the AOC is on other hardware and is unaffected by the rebuild.

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
