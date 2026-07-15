"""Blue-green container resolution.

After a production rollback / DR swap, `live_slot` flips and ingress is
repointed, but the newly-live container is NOT relabelled — it keeps its
`<base>@<slot>` label, and the old bare-`deployment_id` live container is
retired. So a lookup for the bare base id finds nothing, and BOTH the Inspect
pane and the Logs stream (which resolve through `get_container`) break for the
live production slot with "No container found".

`get_container(base_id)` must fall back to the running `<base>@<slot>` slot
container(s) so the live production slot stays inspectable after a swap.
Regression for the container-inspect-empty-on-rolled-back-production bug.
"""

import asyncio

import yaml

from app.services.automation_service import AutomationService

BASE = "invoice-processing-production"


class _Container:
    def __init__(self, deployment_id):
        self.id = f"cid-{deployment_id}"
        self.labels = {
            "gitops.deployment_id": deployment_id,
            "gitops.workspace": "ws",
        }

    def to_docker_dict(self):
        return {"Id": self.id, "Labels": self.labels, "State": "running"}


class _FakeDriver:
    """Exact-label match, exactly like the real driver's container_list."""

    def __init__(self, containers):
        self.containers = containers

    async def container_list(self, ctx, labels=None):
        return [
            c
            for c in self.containers
            if all(c.labels.get(k) == v for k, v in (labels or {}).items())
        ]


def _svc(tmp_path, containers):
    (tmp_path / "bitswan.yaml").write_text(yaml.safe_dump({"deployments": {}}))
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.secrets_dir = str(tmp_path / "secrets")
    svc.workspace_name = "ws"
    svc._infra_driver = _FakeDriver(containers)
    return svc


def _ids(rows):
    return sorted(r["Id"] for r in rows)


def test_bare_label_resolves_directly(tmp_path):
    """The simple case (pre-swap): the live slot carries the bare id."""
    svc = _svc(tmp_path, [_Container(BASE)])
    assert _ids(asyncio.run(svc.get_container(BASE))) == [f"cid-{BASE}"]


def test_live_slot_fallback_after_swap(tmp_path):
    """Post-swap: only `<base>@green` runs; the bare id must still resolve it."""
    svc = _svc(tmp_path, [_Container(f"{BASE}@green")])
    assert _ids(asyncio.run(svc.get_container(BASE))) == [f"cid-{BASE}@green"]


def test_slot_id_still_exact_matches(tmp_path):
    """Querying the slotted id directly keeps working (exact match, no fallback)."""
    svc = _svc(tmp_path, [_Container(f"{BASE}@green")])
    assert _ids(asyncio.run(svc.get_container(f"{BASE}@green"))) == [
        f"cid-{BASE}@green"
    ]


def test_fallback_does_not_cross_deployments(tmp_path):
    """The `<base>@` prefix must not match a different deployment that merely
    shares a string prefix (e.g. `invoice-processing-production-2`)."""
    other = _Container("invoice-processing-production-2@green")
    svc = _svc(tmp_path, [other])
    assert asyncio.run(svc.get_container(BASE)) == []


def test_no_container_returns_empty(tmp_path):
    svc = _svc(tmp_path, [])
    assert asyncio.run(svc.get_container(BASE)) == []
