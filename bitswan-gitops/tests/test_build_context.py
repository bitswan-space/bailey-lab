"""Build-context materialization (`_atomic_publish` / `_copy_tree` /
`_materialize_build_context`).

The `.builds/<hash>` dirs are content-addressed and materialized from a thread
pool (`asyncio.to_thread`). Two automations with an identical `image/` tree —
e.g. every BP's backend, scaffolded from one template — map to ONE ctx dir but
take DIFFERENT per-tag build locks, so their materializations run concurrently.
A plain rmtree+copytree then throws `FileExists`; these tests pin the atomic,
idempotent behavior that prevents it.
"""

import os
import threading

from app.services.automation_service import AutomationService


def _make_src(root, name, files):
    src = os.path.join(root, name)
    os.makedirs(src, exist_ok=True)
    for fname, body in files.items():
        with open(os.path.join(src, fname), "w") as f:
            f.write(body)
    return src


def test_copy_tree_publishes_content(tmp_path):
    src = _make_src(tmp_path, "image", {"Dockerfile": "FROM scratch\n"})
    dst = os.path.join(tmp_path, ".builds", "img-abc")
    AutomationService._copy_tree(src, dst)
    with open(os.path.join(dst, "Dockerfile")) as f:
        assert f.read() == "FROM scratch\n"


def test_copy_tree_is_idempotent_reuse(tmp_path):
    """Second call on an existing content-addressed dir is a no-op reuse — it
    must not rmtree + rebuild (which is what raced with concurrent builds)."""
    src = _make_src(tmp_path, "image", {"Dockerfile": "FROM scratch\n"})
    dst = os.path.join(tmp_path, ".builds", "img-abc")
    AutomationService._copy_tree(src, dst)
    # A sentinel a "concurrent" build left behind is preserved (dir reused as-is,
    # not wiped) — proves we don't rmtree an existing content dir.
    sentinel = os.path.join(dst, ".sentinel")
    with open(sentinel, "w") as f:
        f.write("x")
    AutomationService._copy_tree(src, dst)
    assert os.path.isfile(sentinel)
    # No stray temp dirs left over.
    assert [p for p in os.listdir(os.path.join(tmp_path, ".builds"))] == ["img-abc"]


def test_copy_tree_concurrent_same_ctx_no_fileexists(tmp_path):
    """The regression: N threads materialize the SAME ctx dir at once (identical
    image/ tree, different tags → different locks). Must not raise FileExists."""
    src = _make_src(
        tmp_path, "image", {"Dockerfile": "FROM scratch\n", "go.mod": "m\n"}
    )
    dst = os.path.join(tmp_path, ".builds", "img-shared")
    errors: list[BaseException] = []
    barrier = threading.Barrier(8)

    def worker():
        try:
            barrier.wait()
            AutomationService._copy_tree(src, dst)
        except BaseException as e:  # noqa: BLE001 — capture for assertion
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"materialization raced: {errors!r}"
    assert os.path.isfile(os.path.join(dst, "Dockerfile"))
    assert os.path.isfile(os.path.join(dst, "go.mod"))
    # Published exactly one dir, no leftover temp dirs.
    assert os.listdir(os.path.join(tmp_path, ".builds")) == ["img-shared"]


def test_materialize_build_context_atomic_and_idempotent(tmp_path):
    a = _make_src(tmp_path, "a", {"main.go": "package a\n"})
    b = _make_src(tmp_path, "b", {"extra.txt": "b\n"})
    ctx = os.path.join(tmp_path, ".builds", "sha-merged")

    AutomationService._materialize_build_context(ctx, [a, b])
    assert os.path.isfile(os.path.join(ctx, "main.go"))
    assert os.path.isfile(os.path.join(ctx, "extra.txt"))
    with open(os.path.join(ctx, ".dockerignore")) as f:
        assert "Dockerfile" in f.read()

    # Idempotent reuse: existing content-addressed ctx is left untouched.
    sentinel = os.path.join(ctx, ".sentinel")
    with open(sentinel, "w") as f:
        f.write("x")
    AutomationService._materialize_build_context(ctx, [a, b])
    assert os.path.isfile(sentinel)
    assert os.listdir(os.path.join(tmp_path, ".builds")) == ["sha-merged"]
