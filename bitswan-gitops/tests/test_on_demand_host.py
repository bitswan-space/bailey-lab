"""Non-waking authoritative check behind the daemon gate's scale-from-zero for
staging/production. Their hostnames carry no policy (unlike '-dev'), so the gate
asks gitops — which reads bitswan.yaml, the single source of truth — whether a
host is an on-demand deployment before showing the wake-on-access loading page.
No shadow state, so nothing to drift when a deploy/promote/delete happens.
"""

import os

import yaml

from app.services.automation_service import AutomationService, make_hostname_label


def _svc(tmp_path):
    svc = AutomationService()
    svc.gitops_dir = str(tmp_path)
    svc.gitops_dir_host = str(tmp_path)
    svc.workspace_name = "ws"
    return svc


def _write(tmp_path, deployments):
    # Single-file layout (no bp/ subdir) → read_bitswan_yaml reads this verbatim.
    with open(os.path.join(str(tmp_path), "bitswan.yaml"), "w") as f:
        yaml.safe_dump({"deployments": deployments}, f)


def _host(auto, context, stage):
    return make_hostname_label("ws", auto, context, stage) + ".example.com"


def test_on_demand_staging_host_is_wakeable(tmp_path):
    _write(
        tmp_path,
        {
            "fe-shop-staging": {
                "automation_name": "frontend",
                "context": "shop",
                "stage": "staging",
                "active": False,  # asleep — the case that used to 502 forever
                "memory_reservation_policy": "on-demand",
            }
        },
    )
    svc = _svc(tmp_path)
    assert svc.host_is_on_demand(_host("frontend", "shop", "staging")) is True


def test_always_on_staging_host_is_not_wakeable(tmp_path):
    _write(
        tmp_path,
        {
            "be-shop-staging": {
                "automation_name": "backend",
                "context": "shop",
                "stage": "staging",
                "active": False,
                "memory_reservation_policy": "always-on",
            }
        },
    )
    svc = _svc(tmp_path)
    # always-on → the gate must pass a real 502 through, not loop on "waking".
    assert svc.host_is_on_demand(_host("backend", "shop", "staging")) is False


def test_default_policy_is_on_demand(tmp_path):
    # No policy key ⇒ on-demand (matches _is_on_demand's default).
    # A production deployment is PERSISTED with stage='' but its PUBLIC host
    # keeps the '-production' segment (deploy URL / ingress route / dashboard
    # link all use `stage or "production"`), so that is the host the gate asks
    # about — not the suffix-less internal label.
    _write(
        tmp_path,
        {
            "fe-shop-production": {
                "automation_name": "frontend",
                "context": "shop",
                "stage": "",  # production (persisted form)
                "active": False,
            }
        },
    )
    svc = _svc(tmp_path)
    assert svc.host_is_on_demand(_host("frontend", "shop", "production")) is True


def test_production_host_with_suffix_resolves_and_is_wakeable(tmp_path):
    """Regression (issue #244): a production deployment is persisted with an
    empty stage, but the host users actually hit is `…-production`. Resolution
    must match THAT host — otherwise on-demand detection returns False and the
    daemon gate serves a hard 502/closed connection instead of the wake-on-access
    loading page, so an asleep production endpoint stays down forever."""
    _write(
        tmp_path,
        {
            "fe-shop-production": {
                "automation_name": "frontend",
                "context": "shop",
                "stage": "",  # production (persisted form)
                "active": False,  # asleep — must still be wake-able
            }
        },
    )
    svc = _svc(tmp_path)
    public_host = _host("frontend", "shop", "production")
    # The public host carries the suffix the internal (suffix-less) label lacks.
    assert public_host.startswith("ws-frontend-")
    assert "-production." in public_host
    # It resolves to the deployment...
    match = svc._resolve_host_deployment(public_host)
    assert match is not None, "production host must resolve to its deployment"
    conf, context, stage = match
    assert context == "shop"
    assert stage == ""  # persisted form preserved for _wake_context_stage
    # ...and is reported wake-able (default policy = on-demand).
    assert svc.host_is_on_demand(public_host) is True
    # The suffix-less internal label is NOT a public host and must not resolve.
    assert svc.host_is_on_demand(_host("frontend", "shop", "")) is False


def test_unknown_host_is_not_wakeable(tmp_path):
    _write(tmp_path, {})
    svc = _svc(tmp_path)
    assert svc.host_is_on_demand("nope-nothing-here.example.com") is False


def test_inner_segment_is_stripped(tmp_path):
    _write(
        tmp_path,
        {
            "fe-shop-staging": {
                "automation_name": "frontend",
                "context": "shop",
                "stage": "staging",
                "memory_reservation_policy": "on-demand",
            }
        },
    )
    svc = _svc(tmp_path)
    label = make_hostname_label("ws", "frontend", "shop", "staging")
    assert svc.host_is_on_demand(f"{label}--inner.example.com") is True
