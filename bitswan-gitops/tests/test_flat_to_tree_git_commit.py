"""The Deployments history (bp_history) keys off business_processes[bp][stage]
.git_commit. _flat_to_tree must derive that from the deployment's own
source_commit — every deploy path stamps source_commit on the deployment, but
only write_bp_deploy stamps the node-level git_commit. Without this, deploys via
the set-deploy path (Sync & Deploy's auto-deploy, the editor) leave the node
git_commit-less and read "not deployed yet" even though they deployed fine.
"""

from app.utils import _flat_to_tree


def test_derives_git_commit_from_deployment_source_commit():
    """A set-deploy-path deployment (source_commit on the deployment, no
    existing node git_commit) surfaces git_commit on the node."""
    bs = {
        "deployments": {
            "backend-test3-dev": {
                "context": "test3",
                "stage": "dev",
                "source_commit": "abc123",
                "image_id": "sha256:a",
            },
            "frontend-test3-dev": {
                "context": "test3",
                "stage": "dev",
                "source_commit": "abc123",
                "image_id": "sha256:b",
            },
        }
    }
    tree = _flat_to_tree(bs)
    assert tree["test3"]["dev"]["git_commit"] == "abc123"


def test_deployment_source_commit_reflects_latest_deploy():
    """The node tracks the CURRENT deploy's source_commit, not a stale value
    left in the existing tree — so re-deploys keep showing up in history."""
    bs = {
        "business_processes": {"bp": {"dev": {"git_commit": "old000"}}},
        "deployments": {
            "backend-bp-dev": {
                "context": "bp",
                "stage": "dev",
                "source_commit": "new999",
            },
        },
    }
    tree = _flat_to_tree(bs)
    assert tree["bp"]["dev"]["git_commit"] == "new999"


def test_falls_back_to_existing_when_no_source_commit():
    """A deployment without a source_commit (e.g. live-dev) keeps the existing
    node git_commit rather than dropping it."""
    bs = {
        "business_processes": {"bp": {"dev": {"git_commit": "keep111"}}},
        "deployments": {
            "backend-bp-dev": {"context": "bp", "stage": "dev"},
        },
    }
    tree = _flat_to_tree(bs)
    assert tree["bp"]["dev"]["git_commit"] == "keep111"
