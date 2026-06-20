# BitSwan E2E — real-stack browser tests for the BP lifecycle

This suite drives the **whole business-process story through the dashboard UI
against the real stack** — real `docker compose` deploys, real snapshots, real
blue-green production slots, real ingress reconcile. The **only** thing swapped
out is Keycloak: a disposable Keycloak with a seeded realm
(`keycloak/realm-export.json`) stands in for the production identity provider.
Nothing about docker, gitops, the daemon, traefik, or the databases is mocked.

The lifecycle covered (`tests/bp-lifecycle.spec.ts`):

> log in → create a BP → describe it → **Sync & Deploy** to dev → **promote**
> dev→staging→production → **snapshot/backup** → **restore into DR** → **record a
> recovery test** → **swap** DR↔Production (admin) → **roll back** → **re-apply**
> (declarative ingress reconcile).

Each step asserts both the UI and the real backend effect (`docker ps`, the live
`-production` route, gitops `bitswan.yaml` state).

---

## Run it locally (recommended: a KVM VM — fast + isolated)

The suite makes system-level changes (root daemon init, `dnsmasq` on `:53`, a
mkcert CA, lots of docker churn), so run it in a **disposable KVM guest**. On a
beefy local machine this is far faster than CI.

### Option A — Vagrant + libvirt (KVM)

```bash
# one-time host setup
sudo apt-get install -y vagrant qemu-kvm libvirt-daemon-system
vagrant plugin install vagrant-libvirt

cd e2e/local-vm
vagrant up                       # boots, provisions, and RUNS the full E2E
# iterate without re-provisioning:
vagrant ssh -c 'cd /repo/e2e && npm test'
vagrant ssh                      # poke at the live stack
vagrant destroy -f               # tear down
```

The Playwright HTML report syncs back to `e2e/playwright-report/`.
Tune size with `E2E_VM_CPUS` / `E2E_VM_MEMORY_MB`.

### Option B — raw QEMU/KVM (no Vagrant)

```bash
sudo apt-get install -y qemu-system-x86 cloud-image-utils openssh-client rsync
cd e2e/local-vm
./run-qemu.sh           # boots an Ubuntu cloud image, runs the E2E, copies the report back
./run-qemu.sh --keep    # leave the VM up for debugging (it prints the ssh command)
```

Both paths run `local-vm/provision.sh` (docker, Go, Node, dnsmasq, mkcert) then
`local-vm/run-e2e.sh` (`e2e/bringup.sh` + `npm test`).

### Option C — directly on a Linux host (no VM)

Only if you accept the system changes on your box (root daemon, dnsmasq, mkcert):

```bash
sudo apt-get install -y dnsmasq libnss3-tools sqlite3
# install mkcert, then:
mkcert -install
echo 'address=/.localhost/127.0.0.1' | sudo tee /etc/dnsmasq.d/localhost.conf && sudo systemctl restart dnsmasq

bash e2e/bringup.sh                 # stand up the real stack + seeded Keycloak
cd e2e && npm install && npx playwright install --with-deps chromium && npm test
```

`bringup.sh` writes `e2e/.env` (dashboard URL, test credentials) that the
Playwright config reads.

---

## Run the unit / integration suites locally

These are fast and need no VM:

```bash
# gitops (Python) — unit + integration (docker mocked where needed)
cd bitswan-gitops && ruff check app/ tests/ && ruff format --check app/ tests/ \
  && python -m pytest tests/ -q
# (or in the running container: docker exec <gitops> sh -c 'cd /src && python -m pytest tests/ -q')

# automation-server daemon (Go)
cd bitswan-automation-server && gofmt -l internal/ && go test ./internal/daemon/ -count=1

# dashboard (TypeScript) — type-check / build client + server
cd bitswan-workspace-dashboard && npm run build
```

CI runs these via `gitops-lint.yml`, `automation-server-test.yml`, and the
dashboard build.

---

## CI

`.github/workflows/bp-lifecycle-e2e.yml` runs this same suite on a `docker:dind`
runner (dnsmasq, mkcert, daemon init, traefik, seeded Keycloak, real images
built from source), then uploads the Playwright report + container logs as
artifacts. It's heavy (real deploys → ~10–20 min), so it's gated to PRs that
touch the relevant components plus manual `workflow_dispatch` — it does not run
on every push.

## Layout

| path | what |
|------|------|
| `bringup.sh` | stand up the real stack + disposable Keycloak; writes `.env` |
| `oauth-config.json`, `keycloak/realm-export.json` | the seeded test identity provider |
| `playwright.config.ts`, `package.json` | Playwright project (serial, generous timeouts) |
| `fixtures/bitswan.ts` | Keycloak login + the dashboard-iframe / backend-assert helpers |
| `tests/bp-lifecycle.spec.ts` | the ordered lifecycle story |
| `local-vm/` | KVM runners (Vagrant + raw QEMU) + guest provisioning |
