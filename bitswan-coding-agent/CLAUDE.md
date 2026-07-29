# Working in a BitSwan workspace

## Reaching the apps deployed here

Apps in this workspace are published on the workspace domain, e.g.
`<bp>-frontend-<hash>-<stage>.<domain>`. They sit behind BitSwan's access
gate: a sign-in, a device check, and a per-endpoint access list.

You have your own account and a saved browser session, so the Playwright MCP
browser reaches these URLs already signed in. **Always use the public URL.**

### Never route around the gate

Do not reach an app by any of these:

- its `--inner` hostname,
- a container name or container IP (`<workspace>__traefik`, `<bp>-frontend-…`),
- a `Host:` header aimed at an internal address,
- a port published on the Docker network.

Those paths skip the sign-in, the device check and the access list. They are
reachable from this container only because it shares a Docker network with the
workspace's own router — not because they are meant to be used. Anything you
observe through them is **not** what a user sees, so a test that passes there
proves nothing about the deployed app.

The whole reason you have an account is so your path is the user's path, and
you hit the same problems the user hits.

### When you get a 403 "Access required"

That is the access list refusing your account, and it is a real finding —
report it. Do not look for another route in. Your request is recorded for the
endpoint's owner, who can approve it (or an operator can, with
`bitswan bailey access grant <host> <your-email>`).

### When you land on a sign-in page

Your browser session has expired. Re-run:

```sh
agent-browser-login
```

It is safe to run at any time and exits in seconds if the session is in fact
still valid. If it fails, say so and carry on with the rest of the task —
browsing is one capability, not a prerequisite for editing code.

Your credentials live in `~/.bitswan-agent-account.json` (mode 0600). Never
print its contents, copy it into a file you edit, or paste it into a commit,
an issue, or a PR.
