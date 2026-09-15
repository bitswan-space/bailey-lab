GITHUB_STEPS = [
    "Create an empty repository (a README, licence or .gitignore added by GitHub is kept).",
    "Settings → Deploy keys → Add deploy key: paste the workspace's public key and tick "
    '"Allow write access".',
    "Settings → Rules → Rulesets → New branch ruleset targeting `main`: enable "
    '"Block force pushes" and "Restrict deletions". Do not require pull requests — '
    "Bailey pushes to `main` directly.",
    "Use the SSH URL, `git@github.com:<org>/<repo>.git`, as the remote.",
]

GITLAB_STEPS = [
    "Create a blank project (an initial README is kept).",
    "Settings → Repository → Deploy keys → Add new key: paste the workspace's public key "
    'and tick "Grant write permissions to this key".',
    'Settings → Repository → Protected branches → protect `main`: under "Allowed to push '
    'and merge" select the deploy key, and leave "Allowed to force push" off.',
    "Use the SSH URL, `git@gitlab.com:<group>/<project>.git`, as the remote.",
]


def _numbered(steps: list[str]) -> str:
    return "\n".join(f"{i}. {step}" for i, step in enumerate(steps, 1))


def dashboard_url(workspace: str, domain: str) -> str:
    return f"https://{workspace}-dashboard.{domain}" if domain else ""


def workspace_readme(workspace: str, domain: str = "") -> str:
    dashboard = dashboard_url(workspace, domain)
    dashboard_line = (
        f"The workspace dashboard is at <{dashboard}>."
        if dashboard
        else "Open the workspace dashboard to work on it."
    )
    return f"""# {workspace}

This repository is the git mirror of the [Bailey](https://bitswan.ai) workspace
**{workspace}**. Bailey pushes it; people and tools may read it, and may commit
to `main` as described below. {dashboard_line}

## Layout

- `main` — one folder per business process, each holding that process's
  code exactly as it stands on the process's own `main` inside the workspace.
- `gitops` — one folder per business process holding its `bitswan.yaml`, the
  deployment manifest. The dev, staging and production stages are recorded
  there (which commit each stage runs), not as branches.
- `copies/<name>` — each person's copy (and each experiment), one folder per
  business process it holds, as last published inside the workspace. These are
  **read-only mirrors**: Bailey overwrites them on every push and removes them
  when the copy is deleted, so anything committed to them here is lost. Work in
  a copy through the workspace dashboard instead.
- `deploy/<process>/<timestamp>` tags mark each deploy of a process.

## `main` is fast-forward only

Inside the workspace every process's `main` only ever moves forward: a deploy
fast-forwards it to the deployed copy, and history is never rewritten. The
mirror keeps the same rule. Bailey pushes `main` here as a fast-forward and
never force-pushes `main` or `gitops` on its own.

You may push commits **on top of** `main` here (edit a file in a process
folder, merge a pull request). Before a copy is deployed — and on a regular
schedule — Bailey pulls this branch: each changed process folder becomes a
new commit on that process's `main` inside the workspace, merged with any
work that landed there in the meantime. Copies that were based on the older
`main` are then behind it and must sync before they can deploy, exactly as if
a colleague had deployed.

If `main` here is rewritten (a force push, a reset, a deleted-and-recreated
branch) or a remote change conflicts with work inside the workspace, Bailey
stops pushing `main` and reports the branch as diverged in the workspace
settings. A workspace admin then chooses to **force push to repair** (this
repository's `main` is replaced by the workspace's) or to **pause the
remote** until it is sorted out by hand.

Protect `main` on your git host so that nobody can force-push it:

### GitHub

{_numbered(GITHUB_STEPS)}

### GitLab

{_numbered(GITLAB_STEPS)}

Other hosts: add the workspace's public key as a deploy key with write
access, and if the host can protect a branch from force pushes, protect
`main`.

## Deploy key

The workspace authenticates with its own SSH key. Its public half is shown to
admins in the workspace dashboard under Advanced → Settings. Only SSH remotes
are supported.

## Help

Bailey is made by [BitSwan](https://bitswan.ai). Questions and problems:
<support@bitswan.ai>.
"""
