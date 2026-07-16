"""
Garage (S3-compatible object storage) infrastructure service management.

Runs headless — objects are browsed via the workspace-dashboard's object
explorer, so Garage has no web UI and registers no ingress route. The
container is the bare static-binary image (`/garage server --single-node`,
no shell/tar), so all S3 data-plane work goes through the rclone toolbox
sidecar (`<container>-toolbox`) the driver composes alongside it.

Secrets (contract shared with the Go driver):
  - `secrets/garage<suffix>`      env file: GARAGE_ADMIN_TOKEN,
    GARAGE_RPC_SECRET, S3_HOST (the container's network alias), S3_PORT.
    Carries the admin token — must NEVER be attached to a BP backend.
  - `secrets/garage<suffix>.toml` mounted ro at /etc/garage.toml by the
    driver's compose.
  - `secrets/garagecreds/<realm>/{_system,<bucket>}` Garage-issued S3 keys
    (written by the driver's provisioner; `_system` is the full-access key
    used here for backup/restore).
"""

import json
import logging
import os
import secrets as py_secrets
from datetime import datetime

from app.services.garage_util import garage_json_api_argv, garage_rclone_argv
from app.services.infra_service import InfraService, run_docker_command

logger = logging.getLogger(__name__)


class GarageService(InfraService):
    """Manages Garage service deployment (garage + rclone toolbox)."""

    @property
    def service_type(self) -> str:
        return "garage"

    @property
    def network_alias(self) -> str:
        # Hyphenated (a valid Host header, unlike the `__` container name);
        # the driver's compose attaches it as a network alias.
        return f"{self.workspace_name}-garage{self.service_suffix}"

    @property
    def toolbox_container_name(self) -> str:
        return f"{self.container_name}-toolbox"

    @property
    def toml_file_path(self) -> str:
        return os.path.join(self.secrets_dir, f"garage{self.service_suffix}.toml")

    def _generate_secrets_content(self) -> str:
        admin_token = py_secrets.token_hex(32)
        rpc_secret = py_secrets.token_hex(32)
        return (
            f"GARAGE_ADMIN_TOKEN={admin_token}\n"
            f"GARAGE_RPC_SECRET={rpc_secret}\n"
            f"S3_HOST={self.network_alias}\n"
            f"S3_PORT=9000\n"
        )

    def _read_secrets(self) -> dict:
        from app.services.bp_databases import get_service_secrets

        return get_service_secrets(self.service_type, self.stage) or {}

    async def _extra_enable_setup(self) -> None:
        """Write garage<suffix>.toml (the driver mounts it ro at
        /etc/garage.toml). Must agree with the env file just written —
        rpc_secret/admin_token are read back from it."""
        secrets = self._read_secrets()
        toml = (
            'metadata_dir = "/meta"\n'
            'data_dir = "/data"\n'
            'db_engine = "sqlite"\n'
            "replication_factor = 1\n"
            'rpc_bind_addr = "[::]:3901"\n'
            f'rpc_secret = "{secrets.get("GARAGE_RPC_SECRET", "")}"\n'
            "\n"
            "[s3_api]\n"
            'api_bind_addr = "0.0.0.0:9000"\n'
            's3_region = "us-east-1"\n'
            'root_domain = ".s3.invalid"\n'
            "\n"
            "[admin]\n"
            'api_bind_addr = "0.0.0.0:3903"\n'
            f'admin_token = "{secrets.get("GARAGE_ADMIN_TOKEN", "")}"\n'
        )
        os.makedirs(self.secrets_dir, mode=0o700, exist_ok=True)
        with open(self.toml_file_path, "w") as f:
            f.write(toml)
        os.chmod(self.toml_file_path, 0o600)
        logger.info(f"Garage config saved to: {self.toml_file_path}")

    async def _extra_disable_cleanup(self) -> None:
        if os.path.exists(self.toml_file_path):
            os.remove(self.toml_file_path)

    def _get_ingress_upstream(self) -> str:
        # No web UI (objects are browsed via the dashboard's explorer) —
        # empty upstream tells the base class to register no ingress route.
        return ""

    def _get_connection_info(self) -> dict:
        from app.services.bp_databases import _garage_creds

        info = {}
        secrets = self._read_secrets()
        if secrets.get("S3_HOST"):
            info["host"] = secrets["S3_HOST"]
        info["api_port"] = int(secrets.get("S3_PORT", "9000") or 9000)
        if info.get("host"):
            info["endpoint"] = f"http://{info['host']}:{info['api_port']}"
        creds = _garage_creds(self.stage, "_system")
        if creds:
            info["access_key"], info["secret_key"] = creds
        return info

    async def stop(self) -> dict:
        """Stop both the garage and toolbox containers."""
        result = await super().stop()
        try:
            await run_docker_command("docker", "stop", self.toolbox_container_name)
        except Exception as e:
            logger.warning(f"Failed to stop Garage toolbox container: {e}")
        return result

    def _s3_endpoint(self) -> tuple[str, str]:
        secrets = self._read_secrets()
        return (
            secrets.get("S3_HOST") or self.network_alias,
            secrets.get("S3_PORT") or "9000",
        )

    def _system_creds(self) -> tuple[str, str] | None:
        from app.services.bp_databases import _garage_creds

        return _garage_creds(self.stage, "_system")

    async def backup(self, backup_path: str) -> dict:
        """Backup every bucket via rclone sync in the toolbox."""
        if not self.is_enabled():
            raise ValueError(f"{self.display_name} is not enabled")
        if not await self.is_running():
            raise ValueError(f"{self.display_name} is not running")

        # Bucket names are the global aliases (the provisioner always
        # creates one per bucket).
        stdout, stderr, rc = await run_docker_command(
            "docker",
            "exec",
            self.container_name,
            *garage_json_api_argv("ListBuckets"),
        )
        if rc != 0:
            raise RuntimeError(f"ListBuckets failed: {stderr.strip()}")
        try:
            entries = json.loads(stdout)
        except json.JSONDecodeError:
            raise RuntimeError(f"ListBuckets returned non-JSON: {stdout[:200]}")
        buckets: list[str] = []
        for entry in entries:
            buckets.extend((entry or {}).get("globalAliases") or [])

        creds = self._system_creds()
        if buckets and creds is None:
            raise RuntimeError(
                f"No _system Garage key for stage {self.stage} — cannot back up"
            )
        host, port = self._s3_endpoint()

        backup_container_dir = "/tmp/garage-backup"
        _, stderr, rc = await run_docker_command(
            "docker",
            "exec",
            self.toolbox_container_name,
            "sh",
            "-c",
            f"rm -rf {backup_container_dir} && mkdir -p {backup_container_dir}",
        )
        if rc != 0:
            raise RuntimeError(f"backup scratch setup failed: {stderr.strip()}")

        for bucket in buckets:
            _, stderr, rc = await run_docker_command(
                "docker",
                "exec",
                self.toolbox_container_name,
                *garage_rclone_argv(
                    host,
                    port,
                    creds[0],
                    creds[1],
                    "sync",
                    f":s3:{bucket}",
                    f"{backup_container_dir}/{bucket}",
                ),
            )
            if rc != 0:
                logger.warning(f"Failed to sync bucket {bucket}: {stderr}")

        backup_time = datetime.utcnow()
        manifest = {
            "version": 1,
            "workspace": self.workspace_name,
            "backup_date": backup_time.isoformat(),
            "format": "rclone_sync",
            "buckets": buckets,
            "s3_host": host,
        }
        manifest_json = json.dumps(manifest, indent=2)
        await run_docker_command(
            "docker",
            "exec",
            self.toolbox_container_name,
            "sh",
            "-c",
            f"cat > {backup_container_dir}/manifest.json << 'MANIFESTEOF'\n{manifest_json}\nMANIFESTEOF",
        )

        # Stream the synced dir out as a tar via `docker cp` — the archiving
        # is done by the docker daemon. Stored uncompressed (restic
        # compresses off-site); the archive is rooted at the backup dir's
        # basename ("garage-backup/").
        from app.services.snapshot_service import run_docker_command_to_file

        backup_prefix = f"garage{self.service_suffix}"
        tarball_name = (
            f"{backup_prefix}-backup-{backup_time.strftime('%Y%m%d-%H%M%S')}.tar"
        )
        os.makedirs(backup_path, exist_ok=True)
        tarball_path = os.path.join(backup_path, tarball_name)

        stderr, rc = await run_docker_command_to_file(
            [
                "docker",
                "cp",
                f"{self.toolbox_container_name}:{backup_container_dir}",
                "-",
            ],
            tarball_path,
        )
        if rc != 0:
            raise RuntimeError(f"docker cp failed: {stderr}")

        await run_docker_command(
            "docker",
            "exec",
            self.toolbox_container_name,
            "rm",
            "-rf",
            backup_container_dir,
        )

        logger.info(f"Backup completed: {tarball_path}")
        return {
            "status": "ok",
            "backup_path": tarball_path,
            "tarball": tarball_name,
            "buckets": buckets,
        }

    async def restore(self, backup_path: str, force: bool = False) -> dict:
        """Restore bucket data from a backup tarball (or extracted dir).

        Accepts both the new `garage-backup/`-rooted tars and legacy MinIO
        backups (`minio-backup/` root for plain tars, "." for the old
        gzipped ones) — the dir-tree format is identical.
        """
        if not self.is_enabled():
            raise ValueError(f"{self.display_name} is not enabled")
        if not await self.is_running():
            raise ValueError(f"{self.display_name} is not running")

        toolbox = self.toolbox_container_name
        restore_container_dir = "/tmp/garage-restore"

        if os.path.isfile(backup_path) and backup_path.endswith((".tar", ".tar.gz")):
            # Stream the tar in via `docker cp -` — extraction is done by the
            # docker daemon. Plain tars carry their own root dir; legacy
            # gzipped tars (rooted at ".") are gunzipped on our end.
            from app.services.snapshot_service import (
                _is_gzip,
                run_docker_command_from_file,
            )

            await run_docker_command(
                "docker",
                "exec",
                toolbox,
                "rm",
                "-rf",
                restore_container_dir,
                "/tmp/garage-backup",
                "/tmp/minio-backup",
            )
            await run_docker_command(
                "docker",
                "exec",
                toolbox,
                "mkdir",
                "-p",
                restore_container_dir,
            )

            gzipped = _is_gzip(backup_path)
            # Legacy gzipped archives extract INTO the restore dir; plain
            # ones carry their own root, so extract into /tmp and find it.
            target = restore_container_dir if gzipped else "/tmp"
            _, stderr, rc = await run_docker_command_from_file(
                ["docker", "cp", "-", f"{toolbox}:{target}"],
                backup_path,
                gunzip_input=gzipped,
            )
            if rc != 0:
                raise RuntimeError(f"docker cp failed: {stderr}")
            if not gzipped:
                for root in ("/tmp/garage-backup", "/tmp/minio-backup"):
                    _, _, rc = await run_docker_command(
                        "docker", "exec", toolbox, "sh", "-c", f"test -d {root}"
                    )
                    if rc == 0:
                        restore_container_dir = root
                        break
                else:
                    raise ValueError(
                        "Backup archive has no garage-backup/ or minio-backup/ root"
                    )
        elif os.path.isdir(backup_path):
            await run_docker_command(
                "docker",
                "exec",
                toolbox,
                "rm",
                "-rf",
                restore_container_dir,
            )
            stdout, stderr, rc = await run_docker_command(
                "docker",
                "cp",
                backup_path,
                f"{toolbox}:{restore_container_dir}",
            )
            if rc != 0:
                raise RuntimeError(f"docker cp failed: {stderr}")
        else:
            raise ValueError(
                f"Backup path does not exist or is not a valid format: {backup_path}"
            )

        try:
            # Read manifest to get bucket list
            stdout, stderr, rc = await run_docker_command(
                "docker",
                "exec",
                toolbox,
                "cat",
                f"{restore_container_dir}/manifest.json",
            )

            buckets = []
            if rc == 0 and stdout.strip():
                try:
                    manifest = json.loads(stdout)
                    buckets = manifest.get("buckets", [])
                except json.JSONDecodeError:
                    pass

            if not buckets:
                # Fallback: list directories in the restore dir
                stdout, stderr, rc = await run_docker_command(
                    "docker",
                    "exec",
                    toolbox,
                    "sh",
                    "-c",
                    f"ls -d {restore_container_dir}/*/",
                )
                if rc == 0:
                    for line in stdout.strip().split("\n"):
                        bucket = line.strip().rstrip("/").split("/")[-1]
                        if bucket and bucket != "manifest.json":
                            buckets.append(bucket)

            creds = self._system_creds()
            if buckets and creds is None:
                raise RuntimeError(
                    f"No _system Garage key for stage {self.stage} — cannot restore"
                )
            host, port = self._s3_endpoint()

            from app.services.bp_databases import _create_garage_bucket

            for bucket in buckets:
                await _create_garage_bucket(self.container_name, self.stage, bucket)
                # sync is delete-extraneous — the bucket ends up exactly as
                # the backup left it.
                _, stderr, rc = await run_docker_command(
                    "docker",
                    "exec",
                    toolbox,
                    *garage_rclone_argv(
                        host,
                        port,
                        creds[0],
                        creds[1],
                        "sync",
                        f"{restore_container_dir}/{bucket}",
                        f":s3:{bucket}",
                    ),
                )
                if rc != 0:
                    logger.warning(f"Failed to restore bucket {bucket}: {stderr}")

            logger.info("Garage restore completed")
            return {
                "status": "ok",
                "message": "Restore completed successfully",
                "buckets": buckets,
            }
        finally:
            await run_docker_command(
                "docker",
                "exec",
                toolbox,
                "rm",
                "-rf",
                restore_container_dir,
                "/tmp/garage-backup",
                "/tmp/minio-backup",
            )
