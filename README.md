# Bitswan Bailey Lab

**Bitswan Bailey lets you build internal apps for your team.** Bailey is a secure structure in which your apps run: it handles deployment, networking, secrets management, and workspace isolation, so your team gets working tools instead of piecemeal scripts.

Bailey provides the secure framework within which AI coding agents can run — but Bailey itself is explicitly hardened, deterministic infrastructure, not AI. Your apps and agents operate inside it; the walls stay solid.

Bailey is part of [BitSwan](https://www.bitswan.ai/), the platform for building automations and internal applications.

## Bailey Lab vs. Bailey4Enterprise

This repository — **Bailey Lab** — is the unstable upstream of **Bailey4Enterprise**:

- **Bailey Lab** (this repo) is on a **rolling release**. Development happens here first; expect rapid changes and occasional breakage. It is **shared source** — see [License](#license) below.
- **Bailey4Enterprise** has **stable releases** that are hardened and tested by our QA team, with an **SLA available**. It is a separate, **proprietary** edition under a commercial license.

To get Bailey4Enterprise, visit [bitswan.ai](https://www.bitswan.ai/).

## What's in this repo

| Component | Description |
|---|---|
| [`bitswan-automation-server`](bitswan-automation-server/) | CLI app and daemon for managing the Bitswan automation server and workspace deployments |
| [`bitswan-coding-agent`](bitswan-coding-agent/) | Secure container for running a coding agent of your choice, such as Claude or opencode |
| [`bitswan-gitops`](bitswan-gitops/) | Service that manages the deployment, management, and monitoring of Bitswan automations |
| [`bitswan-workspace-dashboard`](bitswan-workspace-dashboard/) | Web dashboard for working with your workspace, including an in-browser terminal |

Each component has its own README with development and usage instructions. CI for all components runs from the root [`.github/workflows/`](.github/workflows/) directory, with each workflow scoped to its component via paths filters.

## License

**Bitswan Lab is shared source.** Every component in this repository is licensed
under your choice of **either**:

- the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0), or
- the [PolyForm Perimeter License 1.0.0](https://polyformproject.org/licenses/perimeter/1.0.0),

at your option — see [`LICENSE`](LICENSE). In short: free for any noncommercial
use, and free for commercial use that does not compete with Bitswan.

This is **not** an OSI open-source license: the source is published and freely
usable within those bounds, but the licenses reserve commercial-competition
rights.

**Bailey4Enterprise** is a separate, **proprietary** edition under a commercial
license; the terms above do not apply to it. See [bitswan.ai](https://www.bitswan.ai/).
