"""
Pure argv builders for Garage admin and rclone data-plane commands.

Shared contract with the Go driver (bitswan-automation-server):
- Garage admin ops run in-container via the static binary:
  ``/garage json-api <Endpoint> [json-body]``. The body is a SINGLE argv
  token; logs go to stderr and the JSON result to stdout (parse stdout
  directly). ``ListBuckets``/``ListKeys`` return bare arrays; a ListKeys
  entry's key-id field is named ``id``. Keys are never imported — Garage
  issues them via ``CreateKey``.
- S3 data-plane work runs in the rclone toolbox sidecar
  (``<garage-container>-toolbox``, image rclone/rclone:1.68) with FLAGS
  only — the driver's exec primitive cannot set env vars. Remotes are the
  on-the-fly ``:s3:<bucket>/<path>`` form.

No I/O here, so every caller keeps its own monkeypatchable exec seam
(``bp_databases._driver_exec``, ``snapshot_service.run_docker_command*``).
"""

import json


def garage_json_api_argv(endpoint: str, body: dict | None = None) -> list[str]:
    """argv for a Garage admin call inside the garage container."""
    argv = ["/garage", "json-api", endpoint]
    if body:
        argv.append(json.dumps(body, separators=(",", ":")))
    return argv


def garage_rclone_argv(
    host: str, port: str | int, access_key: str, secret_key: str, *verb: str
) -> list[str]:
    """argv for an rclone S3 call inside the toolbox container."""
    return [
        "rclone",
        "--s3-provider",
        "Other",
        "--s3-endpoint",
        f"http://{host}:{port}",
        "--s3-region",
        "us-east-1",
        "--s3-access-key-id",
        access_key,
        "--s3-secret-access-key",
        secret_key,
        *verb,
    ]
