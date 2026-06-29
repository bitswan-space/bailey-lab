"""Unit tests for the `docker cp` dispatch in infra_service.run_docker_command.

The infra-driver client is faked at the module boundary (_driver_client_ctx);
these tests verify the host<->container TAR translation `docker cp` requires
(the infra images ship no `tar`, so the driver archives via copy_out/copy_in
and gitops does the host-side tar build/extract).
"""

import io
import tarfile

import pytest

from app.services import infra_service as infra_mod
from app.services.infra_service import run_docker_command


class FakeDriverClient:
    """Records copy_out/copy_in calls; copy_out serves a programmable TAR."""

    def __init__(self, out_tar: bytes = b""):
        self.out_tar = out_tar
        self.copy_out_calls: list[tuple[str, str]] = []
        self.copy_in_calls: list[tuple[str, str, bytes]] = []

    async def copy_out(self, ctx, container, src_path, on_chunk):
        self.copy_out_calls.append((container, src_path))
        # Stream in two chunks to exercise the chunked reader.
        mid = len(self.out_tar) // 2
        await on_chunk(self.out_tar[:mid])
        await on_chunk(self.out_tar[mid:])

    async def copy_in(self, ctx, container, dst_path, chunks):
        if isinstance(chunks, (bytes, bytearray)):
            data = bytes(chunks)
        else:
            data = b"".join([c async for c in chunks])
        self.copy_in_calls.append((container, dst_path, data))


def _tar_of(name: str, content: bytes) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        ti = tarfile.TarInfo(name)
        ti.size = len(content)
        tar.addfile(ti, io.BytesIO(content))
    return buf.getvalue()


@pytest.fixture
def fake_client(monkeypatch):
    client = FakeDriverClient()

    def fake_ctx():
        return client, object()  # ctx is opaque to these helpers

    monkeypatch.setattr(infra_mod, "_driver_client_ctx", fake_ctx)
    return client


async def test_cp_out_single_file_to_host_path(fake_client, tmp_path):
    # `docker cp <c>:/tmp/tarball.tgz <host_file>`: copy_out yields a TAR with
    # one member; it must be written AS the host path (Docker's file semantics).
    fake_client.out_tar = _tar_of("tarball.tgz", b"BACKUP-BYTES")
    host_file = tmp_path / "out.tar.gz"

    out, err, rc = await run_docker_command(
        "docker", "cp", "ws__minio:/tmp/tarball.tgz", str(host_file)
    )
    assert rc == 0, err
    assert host_file.read_bytes() == b"BACKUP-BYTES"
    assert fake_client.copy_out_calls == [("ws__minio", "/tmp/tarball.tgz")]


async def test_cp_out_to_existing_dir_extracts_members(fake_client, tmp_path):
    fake_client.out_tar = _tar_of("obj.txt", b"hello")
    dest = tmp_path / "dest"
    dest.mkdir()

    out, err, rc = await run_docker_command(
        "docker", "cp", "ws__minio:/data/obj.txt", str(dest)
    )
    assert rc == 0, err
    assert (dest / "obj.txt").read_bytes() == b"hello"


async def test_cp_in_from_host_builds_tar(fake_client, tmp_path):
    # `docker cp <host_file> <c>:/tmp/...`: a TAR of the host file (rooted at its
    # basename) is built and copy_in'd to the container path.
    src = tmp_path / "payload.tar.gz"
    src.write_bytes(b"RESTORE-BYTES")

    out, err, rc = await run_docker_command(
        "docker", "cp", str(src), "ws__minio:/tmp/minio-restore.tar.gz"
    )
    assert rc == 0, err
    assert len(fake_client.copy_in_calls) == 1
    container, dst, tar_bytes = fake_client.copy_in_calls[0]
    assert (container, dst) == ("ws__minio", "/tmp/minio-restore.tar.gz")
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r") as tar:
        members = tar.getmembers()
        assert [m.name for m in members] == ["payload.tar.gz"]
        assert tar.extractfile(members[0]).read() == b"RESTORE-BYTES"


async def test_cp_rejects_two_host_paths(fake_client, tmp_path):
    # Neither operand is a container:path ref — must fail loudly.
    with pytest.raises(ValueError):
        await run_docker_command(
            "docker", "cp", str(tmp_path / "a"), str(tmp_path / "b")
        )


async def test_cp_rejects_two_container_refs(fake_client):
    with pytest.raises(ValueError):
        await run_docker_command("docker", "cp", "c1:/a", "c2:/b")


async def test_cp_rejects_wrong_operand_count(fake_client):
    with pytest.raises(ValueError):
        await run_docker_command("docker", "cp", "ws__minio:/a")


async def test_cp_in_rejects_missing_source(fake_client, tmp_path):
    missing = tmp_path / "nope"
    with pytest.raises(ValueError):
        await run_docker_command("docker", "cp", str(missing), "ws__minio:/tmp")


async def test_unsupported_verb_fails_loudly(fake_client):
    with pytest.raises(NotImplementedError):
        await run_docker_command("docker", "rm", "ws__minio")


def test_split_cp_ref_rejects_host_path():
    with pytest.raises(ValueError):
        infra_mod._split_cp_ref("/just/a/host/path")
