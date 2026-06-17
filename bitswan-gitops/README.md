# Bitswan GitOps

Bitswan gitops is a service that manages the deployment, management and monitoring of bitswan automations. With it, you can deploy a business process into production with the click of a button.

## Installation

For installation use the [`bitswan`](https://github.com/bitswan-space/bitswan-workspaces) cli.

## Development
1. Be sure external docker network `bitswan_network` is created, otherwise create it
```bash
docker network create bitswan_network  
```
2. Copy `.env.example` env file and fill slugs
```bash
cp .env.example .env
```
### Mac
```bash
docker compose --env-file .env -f docker-compose.mac.yaml up  -d  
```
### Linux
```bash
docker compose --env-file .env -f docker-compose.linux.yaml up -d
```

In development you can then connect to the gitops either via curl / postman at `0.0.0.0:8079` or you can set it up as a gitops from a running vscode instance by adding the gitops to the vscode extension [see the bitswan editor readme](https://github.com/bitswan-space/bitswan-editor).

## License

Part of [Bitswan Lab](https://github.com/bitswan-space/bailey-lab), which is **shared source**. Licensed under your choice of the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) or the [PolyForm Perimeter License 1.0.0](https://polyformproject.org/licenses/perimeter/1.0.0) — see [`LICENSE`](LICENSE). Free for noncommercial use, and for commercial use that doesn't compete with Bitswan. The separate Bitswan Enterprise edition is proprietary.
