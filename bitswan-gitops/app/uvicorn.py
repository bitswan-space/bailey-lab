# this is a python file that does the
# equivalent of uvicorn app.main:app --port 8079 --host 0.0.0.0
import uvicorn
import app.main
import os


def main():
    # Two INDEPENDENT, EXPLICIT switches — neither is inferred from the
    # filesystem:
    #
    #   DEBUG=true                  -> debug log level (and FastAPI(debug=True),
    #                                  see app/main.py)
    #   BITSWAN_GITOPS_DEV_SOURCE=<dir> -> hot reload, watching <dir>
    #
    # BITSWAN_GITOPS_DEV_SOURCE is set by whatever bind-mounts a live gitops
    # checkout into this container (the daemon does both in
    # internal/dockercompose/dockercompose.go; start.sh also turns on DEBUG when
    # it is present). Reload is deliberately NOT keyed off DEBUG alone: DEBUG is
    # just verbosity, and there is nothing worth watching unless a source tree
    # was actually mounted.
    #
    # Historically dev mode was auto-detected from "/src/pyproject.toml exists",
    # which the image itself satisfies — so every production container ran under
    # the reload supervisor. See the ECONNREFUSED hazard below for why that was
    # not merely wasteful.
    debug = os.environ.get("DEBUG", "false").lower() == "true"
    dev_source = os.environ.get("BITSWAN_GITOPS_DEV_SOURCE", "")
    log_level = "debug" if debug else "info"
    if dev_source:
        # reload=True requires the app as a string import path, not an object.
        # reload_dirs watches the mounted dev source so edits take effect immediately.
        # reload_excludes is critical: importing the app writes *.pyc into
        # <dev_source>/app/__pycache__, and without excluding them the StatReload
        # watcher sees those fresh files as a change and RESTARTS the server
        # seconds after boot. That restart opens a brief ECONNREFUSED window that
        # races the dashboard's first-visit copy-creation — losing it leaves the
        # user with no personal copy (and then no way to create a business
        # process). Excluding bytecode keeps the reloader quiet on boot while
        # still picking up real source edits.
        uvicorn.run(
            "app.main:app",
            host="0.0.0.0",
            port=8079,
            log_level=log_level,
            reload=True,
            reload_dirs=[dev_source],
            reload_excludes=["*.pyc", "*__pycache__*"],
        )
    else:
        uvicorn.run(
            app.main.app,
            host="0.0.0.0",
            port=8079,
            log_level=log_level,
        )
