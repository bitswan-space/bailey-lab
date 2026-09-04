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
        self.rfile.read(length)
        if self.path.rstrip("/") == "/api/automation_server/keycloak/oauth-client":
            self.send(200, OAUTH_CLIENT)
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
