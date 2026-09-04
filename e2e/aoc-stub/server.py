import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OAUTH_CLIENT = {
    "client_id": os.environ["STUB_CLIENT_ID"],
    "client_secret": os.environ["STUB_CLIENT_SECRET"],
    "issuer_url": os.environ["STUB_ISSUER_URL"],
}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        path = self.path.rstrip("/")

        if path == "/api/automation_server/keycloak/oauth-client":
            self.send(200, OAUTH_CLIENT)
            return

        # Registering the server means the daemon now believes it has an AOC, so
        # creating a workspace registers it too — and a 404 here aborts the
        # create outright rather than degrading.
        if path == "/api/automation_server/workspaces":
            try:
                name = json.loads(body or b"{}").get("name", "workspace")
            except ValueError:
                name = "workspace"
            self.send(201, {
                "id": "e2e-" + name,
                "name": name,
                "automation_server_id": "bs-e2e",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            })
            return

        self.send(404, {"error": "not implemented by the e2e AOC stub: " + self.path})

    def do_GET(self):
        self.send(404, {"error": "not implemented by the e2e AOC stub: " + self.path})

    def send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(self.command, self.path, fmt % args, flush=True)


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
