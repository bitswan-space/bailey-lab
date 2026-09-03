from pathlib import Path

import pytest

FRONTEND_ENTRYPOINTS = (
    "examples/frontend/image/entrypoint.sh",
    "examples/business-process/frontend/image/entrypoint.sh",
)


@pytest.mark.parametrize("entrypoint", FRONTEND_ENTRYPOINTS)
def test_frontend_entrypoint_takes_its_ports_from_the_environment(entrypoint):
    body = Path(entrypoint).read_text()
    assert 'export PORT="${PORT:-8080}"' in body
    assert 'export VITE_PORT="${BITSWAN_UI_PORT:-5173}"' in body


@pytest.mark.parametrize("entrypoint", FRONTEND_ENTRYPOINTS)
def test_frontend_ui_server_binds_the_injected_port(entrypoint):
    launches = [
        line.strip()
        for line in Path(entrypoint).read_text().splitlines()
        if "serve -s" in line or '"$VITE"' in line
    ]
    assert launches
    for line in launches:
        assert '"$VITE_PORT"' in line, line
        assert "5173" not in line, line
