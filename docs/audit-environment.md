# The audit environment

Promoting to production requires an auditor to freeze staging and sign off. Up
to now the sign-off was the whole feature: a verdict and a note, recorded
against the image's content hash. An auditor had nowhere to *do* the audit —
the workspace could show them a deployment history, but not the version under
review, not what promoting it would change, and nowhere to write findings.

Freezing staging now builds that environment, and takes it away on unfreeze.

## What freezing creates

    audits/<bp>/<content-sha>/
        source/            the audited commit, extracted from the BP's repo
        production.diff    production..audited
        AUDIT.md           the brief the agent is pointed at
        report.md          the report

Keyed by the **image content hash** — the same key the sign-off store uses — so
the evidence and the sign-offs it justifies always name the same image. The two
commits it compares (what staging is running, what production is running at
that moment) are recorded in `bitswan.yaml` alongside the freeze, because "the
audited version" has to survive later deploys to mean anything.

The source is extracted with `git archive`, not a worktree: it carries no git
state, no remote and no branch, so it cannot be mistaken for something
deployable. Every archive member is checked to land inside the audit directory
before extraction.

Unfreezing removes `source/` — it is a copy, and re-derivable — and keeps the
diff, the brief and the report. Those are the evidence.

When a stage's members disagree on their source commit (a half-finished
promotion) there is no single version to audit, and the state says so rather
than picking one.

## The agent

A second, temporary container per audited image:
`<ws>-<bp>-audit-<sha8>`, the workspace's own coding-agent image with a
read-only job.

- `/audit` is writable and `/audit/source` is mounted read-only **over** it, so
  the agent can write its report and cannot edit the version it is reporting on.
- It joins only the isolated `<ws>-agent` bridge, like the workspace's own
  agent: it runs the same untrusted code. No docker socket, no working copies,
  no git remote, no credentials for the workspace's git.
- The daemon owns docker, so it owns the lifecycle
  (`/audit-agent/{start,stop,draft}` on the trusted socket, called by gitops
  when an auditor freezes or unfreezes).
- Drafting runs `claude -p` in that container with the auditor's prompt
  shell-quoted, and redirects the answer into `report.md` — the same file the
  tab shows as the report. There is nowhere else for the report to be.

Verified against real Docker: the container attaches to the agent bridge only,
`/audit/source` refuses a write, and the agent's write to `/audit/report.md`
lands in the volume subpath gitops and the dashboard read.
`TestPrintAuditAgentArgv` (skipped unless `AUDIT_ARGV_PROBE` is set) prints the
exact argv so that check is repeatable.

## What the auditor sees

The Audits section of the Deployments tab, while frozen:

| panel | what it is |
|---|---|
| Agent | the hosted Claude Code panel, opened on the audit directory |
| Source | the audited version's tree, its files, and a search over them |
| Diff vs production | what promoting this image would change |
| Report | the markdown, with "Draft with the agent" and a place to correct it |

Reading is open to anyone who can open the tab. Writing the report and running
the agent are admin/auditor, resolved from the gate-verified identity — like
freezing and signing off — and attributed to that identity rather than anything
the client sends. A member sees the report read-only and no chat: an audit
conversation is part of the evidence, so only the people who can sign off hold
one.

## The seam that is left

The chat's extension host runs in the **dashboard** container (the audit
directory is mounted there), while the agent's shell runs in the **audit
container**. One process in one place would be better, and the shape for it
already exists: the extension host is a forked child speaking a small IPC
protocol (`server/src/vscode-host/worker.ts`), so the remaining work is a
transport that runs that worker inside the audit container over the gitops
`:2222` channel instead of over a pipe. The image already carries node 20 and
`claude`, which is what that needs.

Until then: the agent that *writes* the report runs in the container, and the
agent an auditor *chats* with runs in the dashboard on the same directory.
