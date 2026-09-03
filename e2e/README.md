# Bitswan Bailey E2E — the suite that writes the manual

This is a real, end-to-end browser test of the **whole Bitswan Bailey product**,
run against the **real stack in a clean, isolated environment** — and its
by-product is the **Operator's Handbook**: a splashy, A4, print-ready manual
illustrated entirely with screenshots captured live during the run.

The suite drives the genuine operator journey with Playwright:

> OIDC sign-in → **claim the server** (device trust) → create the **Meridian
> Foods** workspace through the Server Console UI → create the `invoice-processing`
> business process → describe it → build it with the **Coding Agent** → try a
> change in an **experiment** off your own copy — merge it back, or take it
> wholesale without merging →
> **Deploy** (with the pre-deploy CVE **Checks**) → promote dev → staging →
> **production** (blue-green) → snapshot → **rehearse recovery into DR** → walk
> People & roles, Endpoint access, devices.

Everyone works in their **own copy**, created for them on first visit — the top
bar carries no copy picker and no copy name, and the suite **asserts that
absence**. The rest of the copy tree lives behind the top bar's **Advanced**
menu: a colleague's version (amber "you are viewing" banner), and **experiments**
— side branches off your own copy, each belonging to exactly one business
process. There are **four** ways out of one: leave it running and step back to
your copy, **merge it back** (which auto-discards it), **discard** it, or
**take it wholesale** ("Use this version without merging") — which makes your
copy become it and parks what you had as a dated experiment of its own.

`Deploy` publishes your copy into main **fast-forward-only**; the conditional
`Sync` step is what pulls main in first, and it exists only while your own copy
is behind on **that** business process. When main has moved on there are two
honest ways forward, and the product offers both: **Sync** (replay your work on
top of theirs — the answer almost every time), or **Deploy this version,
overwriting main…**, which has one outcome — main ends up holding *exactly*
your version, including dropping what main added that you do not have — behind
a dialog that names whose commits it supersedes and a typed confirmation.

The same take-a-version primitive reaches backwards, too: **Edit this version**
on any deployment's Inspect makes your copy that deployed version *on top of
main* (one ahead, none behind, so Deploy needs no Sync first), and **Revert dev
to this version** puts the shared dev stage back with one forward commit on
main — which everyone else then picks up through their ordinary Sync.

Each beat is screenshotted into `manual/build/shots/<slot>.png`; the generator
assembles them into `manual/build/handbook.html` + `handbook.pdf`. The manual
teaches what **ISO 27001, SOC 2, DORA, NIS2 and GDPR** require and ties each
control to the feature that delivers it, closing with per-standard
technical-controls guides.

The only thing not real is the identity provider: a disposable **Keycloak** with
a seeded realm (the Meridian Foods cast). Everything else — daemon, protected
gate, traefik, gitops, dashboard, real `docker compose` deploys, blue-green
slots, DR — is the real product, built from **this checkout** (`BITSWAN_*_IMAGE`
overrides point the daemon at locally-built images).

---

## Run it in a clean local KVM VM (recommended)

A test suite needs a clean room. `local-vm/` boots a **fresh, disposable Ubuntu
KVM guest**, provisions it, runs the whole suite inside it, and copies the
generated handbook back out — never touching your host's Docker or other
workspaces. Run it on any machine with `/dev/kvm` and a few spare cores + ~16 GB.

### Raw QEMU (no Vagrant)

```bash
sudo apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils rsync openssh-client
cd e2e/local-vm
E2E_VM_CPUS=8 E2E_VM_MEMORY_MB=16384 ./run-qemu.sh        # boots, runs, copies the manual back
./run-qemu.sh --keep                                      # leave the VM up to debug
```

Outputs land in `e2e/manual/build/`:
- `handbook.html` — one self-contained file (screenshots inlined)
- `handbook.pdf` — A4, print-ready
- `shots/` — the raw live screenshots

### Vagrant + libvirt

```bash
sudo apt-get install -y vagrant qemu-kvm libvirt-daemon-system
vagrant plugin install vagrant-libvirt
cd e2e/local-vm && vagrant up          # provisions + runs; report syncs to e2e/playwright-report
```

The guest provisioning (`provision.sh` → docker, Go, Node, dnsmasq, mkcert) and
the in-guest run (`run-e2e.sh` → `bringup.sh` + `npm test` + `manual/generate.mjs`)
are shared by both runners.

---

## Run just the generator (no stack)

If you already have screenshots in `manual/build/shots/` (or want to preview the
template with honest "capture pending" slots):

```bash
cd e2e && node manual/generate.mjs        # writes manual/build/handbook.{html,pdf}
```

Editorial copy lives in `manual/content.mjs`; the design in `manual/template.mjs`.
The walkthrough only fills screenshot slots by id — copy is decoupled from the run.

---

## CI

`.github/workflows/bp-lifecycle-e2e.yml` runs the suite on a fresh `docker:dind`
runner (clean per run) and uploads the handbook + Playwright report as artifacts.
dind is fine for onboarding/console/Deploy coverage, but the heavy
multi-stage **deploys are slow there** — for the full manual (live production /
blue-green / DR shots) run it in a KVM VM (above), or trigger the KVM build on a
capable host (see `bp-lifecycle-e2e-vm.yml`, which SSHes to a KVM host and runs
`run-qemu.sh`).

## One suite, one fresh server

Claiming a server trusts the browser that claimed it, and every other browser
then arrives as an untrusted device that needs an admin to approve it. So a
suite that claims cannot share a server with another suite that claims. That is
why `tests-device-trust/` is a SEPARATE testDir with its own config rather than
another file under `tests/` — `npm test` would otherwise run both against one
server and the second one would sit on the pairing scene forever.

```bash
e2e/local-vm/run-device-trust-e2e.sh     # in the guest: reset, bring up, run it
npm run test:device-trust                # against a stack that is already up
```

It stands the IdP up on its own registrable domain (`E2E_KC_DOMAIN`), because
whether Keycloak is a sibling of the Bailey hosts decides whether the device
cookie survives the round trip through the login form.

## Layout

| path | what |
|------|------|
| `bringup.sh` | stand up the real protected stack + seeded Keycloak; writes `.env` |
| `keycloak/realm-export.json` | the disposable test identity provider |
| `scenario.ts` | the Meridian Foods invoice-processing demo story (CZ/SK/DE cast) |
| `fixtures/bitswan.ts` | login, dashboard-frame, and `capture()` helpers |
| `tests/walkthrough.spec.ts` | the ordered product walkthrough |
| `tests-device-trust/` | device trust across sign-out/sign-in — its own suite, own fresh server |
| `manual/content.mjs` · `template.mjs` · `generate.mjs` | the handbook (copy · design · build) |
| `local-vm/` | clean KVM-VM runners (raw QEMU + Vagrant) + guest provisioning |
