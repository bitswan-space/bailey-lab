"""
FastAPI routes for the read-only data explorer (workspace-dashboard's
"Object Storage" and "SQL" panels).

GET-only surface. `table`, `key` and `prefix` travel as QUERY params, never
path segments — Postgres identifiers and S3 keys may contain `/` and other
path-hostile bytes. Common params: `copy` (live-dev sandbox scope; only valid
at the dev stage) and `db` (production blue-green override; defaults to the
LIVE slot).

Error mapping follows `routes/snapshots.py`: ValueError → 400,
LookupError → 404, ExplorerUnavailableError → 503, RuntimeError → 500.
"""

import os
import shutil

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from app.services import data_explorer
from app.services.data_explorer import ExplorerUnavailableError

router = APIRouter(prefix="/data-explorer", tags=["data-explorer"])


def _http_error(e: Exception) -> HTTPException:
    if isinstance(e, ValueError):
        return HTTPException(status_code=400, detail=str(e))
    if isinstance(e, LookupError):
        return HTTPException(status_code=404, detail=str(e))
    if isinstance(e, ExplorerUnavailableError):
        return HTTPException(status_code=503, detail=str(e))
    return HTTPException(status_code=500, detail=str(e))


def _resolve(bp: str, stage: str, copy: str, db: int | None):
    try:
        return data_explorer.resolve_target(bp, stage, copy, db)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)


@router.get("/{bp}/{stage}")
async def data_overview(bp: str, stage: str, copy: str = "", db: int | None = None):
    """Capability probe: which of postgres/minio are enabled+running and which
    concrete resources this deployment maps to. Reports flags instead of
    raising for disabled services / unregistered BPs."""
    try:
        return await data_explorer.overview(bp, stage, copy, db)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)


@router.get("/{bp}/{stage}/sql/tables")
async def sql_tables(bp: str, stage: str, copy: str = "", db: int | None = None):
    target = _resolve(bp, stage, copy, db)
    try:
        tables = await data_explorer.list_tables(target)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)
    return {"database": target.postgres_db, "db": target.db, "tables": tables}


@router.get("/{bp}/{stage}/sql/columns")
async def sql_columns(
    bp: str, stage: str, table: str, copy: str = "", db: int | None = None
):
    target = _resolve(bp, stage, copy, db)
    try:
        columns = await data_explorer.list_columns(target, table)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)
    if not columns:
        raise HTTPException(status_code=404, detail=f"Table '{table}' not found")
    return {"table": table, "columns": columns}


@router.get("/{bp}/{stage}/sql/rows")
async def sql_rows(
    bp: str,
    stage: str,
    table: str,
    copy: str = "",
    db: int | None = None,
    limit: int = data_explorer.DEFAULT_ROW_LIMIT,
    offset: int = 0,
    sort: str | None = None,
    order: str = "asc",
):
    target = _resolve(bp, stage, copy, db)
    try:
        return await data_explorer.table_rows(
            target, table, limit=limit, offset=offset, sort=sort, order=order
        )
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)


@router.get("/{bp}/{stage}/objects")
async def object_list(
    bp: str, stage: str, prefix: str = "", copy: str = "", db: int | None = None
):
    target = _resolve(bp, stage, copy, db)
    try:
        return await data_explorer.list_objects(target, prefix)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)


@router.get("/{bp}/{stage}/objects/stat")
async def object_stat(
    bp: str, stage: str, key: str, copy: str = "", db: int | None = None
):
    target = _resolve(bp, stage, copy, db)
    try:
        return await data_explorer.stat_object(target, key)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)


@router.get("/{bp}/{stage}/objects/preview")
async def object_preview(
    bp: str,
    stage: str,
    key: str,
    copy: str = "",
    db: int | None = None,
    max_bytes: int = data_explorer.PREVIEW_DEFAULT_BYTES,
):
    target = _resolve(bp, stage, copy, db)
    try:
        return await data_explorer.preview_object(target, key, max_bytes)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)


@router.get("/{bp}/{stage}/objects/download")
async def object_download(
    bp: str, stage: str, key: str, copy: str = "", db: int | None = None
):
    target = _resolve(bp, stage, copy, db)
    try:
        tmpdir, path, stat = await data_explorer.download_object(target, key)
    except (ValueError, LookupError, RuntimeError) as e:
        raise _http_error(e)
    filename = os.path.basename(key) or "object"
    return FileResponse(
        path,
        media_type=stat.get("content_type") or "application/octet-stream",
        filename=filename,
        background=BackgroundTask(shutil.rmtree, tmpdir, ignore_errors=True),
    )
