# this is a python file that does the
# equivalent of uvicorn app.main:app --port 8079 --host 0.0.0.0
import uvicorn
import app.main
import os


def main():
    debug = os.environ.get("DEBUG", "false").lower() == "true"
    log_level = "debug" if debug else "info"
    if debug:
        # reload=True requires the app as a string import path, not an object.
        # reload_dirs watches the mounted dev source so edits take effect immediately.
        # reload_excludes is critical: importing the app writes *.pyc into
        # /src/app/__pycache__, and without excluding them the StatReload watcher
        # sees those fresh files as a change and RESTARTS the server seconds after
        # boot. That restart opens a brief ECONNREFUSED window that races the
        # dashboard's first-visit copy-creation — losing it leaves the user with
        # no personal copy (and then no way to create a business process). Excluding
        # bytecode keeps the reloader quiet on boot while still picking up real
        # source edits.
        uvicorn.run(
            "app.main:app",
            host="0.0.0.0",
            port=8079,
            log_level=log_level,
            reload=True,
            reload_dirs=["/src"],
            reload_excludes=["*.pyc", "*__pycache__*"],
        )
    else:
        uvicorn.run(
            app.main.app,
            host="0.0.0.0",
            port=8079,
            log_level=log_level,
        )
