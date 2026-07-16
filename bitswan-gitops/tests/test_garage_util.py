"""
Unit tests for the pure Garage argv builders (app/services/garage_util.py).
"""

import json

from app.services.garage_util import garage_json_api_argv, garage_rclone_argv


def test_json_api_argv_without_body():
    assert garage_json_api_argv("GetClusterHealth") == [
        "/garage",
        "json-api",
        "GetClusterHealth",
    ]


def test_json_api_argv_body_is_single_compact_token():
    argv = garage_json_api_argv("CreateBucket", {"globalAlias": "bp-my-bp"})
    assert argv[:3] == ["/garage", "json-api", "CreateBucket"]
    # The body must be ONE argv token, compact (no spaces).
    assert len(argv) == 4
    assert argv[3] == '{"globalAlias":"bp-my-bp"}'
    assert json.loads(argv[3]) == {"globalAlias": "bp-my-bp"}


def test_json_api_argv_nested_body():
    argv = garage_json_api_argv(
        "AllowBucketKey",
        {
            "bucketId": "b1",
            "accessKeyId": "GK1",
            "permissions": {"read": True, "write": True, "owner": True},
        },
    )
    assert len(argv) == 4
    assert " " not in argv[3]
    assert json.loads(argv[3])["permissions"] == {
        "read": True,
        "write": True,
        "owner": True,
    }


def test_rclone_argv_flags_only():
    argv = garage_rclone_argv(
        "ws-garage-dev", "9000", "GK1", "sk1", "sync", ":s3:bkt", "/tmp/out"
    )
    assert argv[0] == "rclone"
    joined = " ".join(argv)
    assert "--s3-provider Other" in joined
    assert "--s3-endpoint http://ws-garage-dev:9000" in joined
    assert "--s3-region us-east-1" in joined
    assert "--s3-access-key-id GK1" in joined
    assert "--s3-secret-access-key sk1" in joined
    assert argv[-3:] == ["sync", ":s3:bkt", "/tmp/out"]
