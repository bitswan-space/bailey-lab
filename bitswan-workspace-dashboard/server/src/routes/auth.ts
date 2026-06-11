import type { FastifyInstance } from 'fastify';

/**
 * Tiny HTML page the OAuth login popup lands on. It postMessages the opener
 * (the iframe) and self-closes.
 */
const LOGIN_DONE_HTML = /*html*/ `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Signed in</title>
    <style>
      html, body { margin: 0; height: 100%; }
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #1e1e1e;
        color: #d4d4d4;
        display: grid;
        place-items: center;
        text-align: center;
        padding: 16px;
      }
    </style>
  </head>
  <body>
    <div>
      <p>Signed in successfully.</p>
      <p style="opacity: 0.6">You can close this window.</p>
    </div>
    <script>
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage('login-done', window.location.origin);
        }
      } catch (e) {}
      setTimeout(function () { window.close(); }, 50);
    </script>
  </body>
</html>`;

/**
 * Routes that support the iframe SSO popup flow. The dashboard SPA opens
 * `/oauth2/start?rd=/_login_done` in a popup; oauth2-proxy bounces back to
 * `/_login_done` here on success, which postMessages the iframe parent.
 */
export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/_login_done', async (_req, reply) => {
    reply.type('text/html').send(LOGIN_DONE_HTML);
  });
}
