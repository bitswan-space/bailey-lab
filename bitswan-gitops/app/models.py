from datetime import datetime

from pydantic import BaseModel


class DeployedAutomation(BaseModel):
    container_id: str | None
    endpoint_name: str | None
    created_at: datetime | None
    name: str
    state: str | None
    status: str | None
    deployment_id: str | None
    active: bool
    automation_url: str | None
    relative_path: str | None
    stage: str | None
    automation_name: str | None = None
    context: str | None = None
    version_hash: str | None = None
    replicas: int = 1
    # True for frontends (exposed through Bailey), False for worker
    # containers (private backends). Read from the automation's
    # [deployment] expose; drives the dashboard's Frontends vs Worker
    # containers split.
    expose: bool = False
    # Memory governance (Containers tab): live usage vs the declared reservation,
    # the reservation policy, and whether usage exceeds the reservation.
    mem_usage_bytes: int | None = None
    mem_reservation_mb: int | None = None
    mem_policy: str | None = None
    mem_over_reservation: bool = False


class ProcessInfo(BaseModel):
    id: str
    # Directory-name slug — what git repos, deployment ids, and API routes
    # key on. `display_name` is the human-readable name from process.toml
    # (falls back to the slug for BPs created before it existed).
    name: str
    display_name: str = ""
    attachments: list[str]
    automation_sources: list[str]


# =============================================================================
# Infrastructure Service Models
# =============================================================================


class ServiceEnableRequest(BaseModel):
    stage: str = ""
    image: str = ""
    kafka_image: str = ""
    ui_image: str = ""
    postgres_image: str = ""
    pgadmin_image: str = ""
    minio_image: str = ""


class ServiceDisableRequest(BaseModel):
    stage: str = ""


class ServiceActionRequest(BaseModel):
    """Request for start/stop/update actions."""

    stage: str = ""
    image: str | None = None


class ServiceBackupRequest(BaseModel):
    stage: str = ""
    backup_path: str


class ServiceRestoreRequest(BaseModel):
    stage: str = ""
    backup_path: str
    force: bool = False


class ServiceClearRequest(BaseModel):
    stage: str = ""


# =============================================================================
# Stage Snapshot Models
# =============================================================================


class SnapshotProvisionRequest(BaseModel):
    """Explicit opt-in to per-BP databases at one stage (starts empty)."""

    stage: str
    bp_name: str = ""  # original BP folder name; defaults to the URL value


class SnapshotCreateRequest(BaseModel):
    label: str = ""
    by: str | None = None


class SnapshotRestoreRequest(BaseModel):
    snapshot_id: str
    source_stage: str
    target_stage: str
    by: str | None = None


class SnapshotCloneRequest(BaseModel):
    source_stage: str
    target_stage: str
