# Auditing happens in a copy

Promoting to production requires an auditor to freeze staging and sign off. The
sign-off was the whole feature: a verdict and a note recorded against the
image's content hash. An auditor had nowhere to *do* the audit — the workspace
could show them a deployment history, but not the version under review — and
the note was a summary of reasoning that lived nowhere.

The first attempt at fixing that built an environment of its own: an extracted
source tree, a diff file, a report file, a temporary container to read them
with, and a daemon API to run that container — plus a panel with its own file
tree, search, diff viewer and editor. It worked, and it was a second, worse
implementation of what a copy already is.

## The audit is a copy

Opening an audit gives the auditor a copy of the business process holding the
exact version the frozen image was built from. It is put there with `adopt`,
the primitive behind "edit this version": the audited tree lands **on top of
main**, so the copy is one ahead and none behind and deploys with no sync
first.

From there nothing is special:

| what the auditor wants | what they use |
|---|---|
| read the version under audit | the file explorer, in their copy |
| ask about it | the coding agent, in their copy |
| see what it changes | the diff, in their copy |
| write findings | `<bp>/AUDIT.md`, seeded when the audit opens |
| fix what they found | edit and Deploy, like any other copy |

One audit copy per (image, auditor): two auditors reviewing the same image work
in their own copies, and re-opening returns to the one already there.

## The report is what gets signed

Where a copy offers **Deploy**, an audit copy offers **Audit report**. The
report is `<bp>/AUDIT.md` — an ordinary file, edited with the same editor the
description uses, so the coding agent in the copy reads and writes it too. It
is seeded when the audit opens, under the four headings that are the method:
what this version changes, risk, verified, not verified.

**Approve** and **Request changes** sit on that tab, on the report itself.
Pressing one saves the document, reads it back, and records it *with* the
verdict — in `bitswan.yaml`, keyed by the image's content hash, capped at 64 KiB
so one audit cannot bloat a file every workspace operation reads. There is no
note box: what is stored is the argument, and it is still readable from the
staging gate and from the production deploy record long after the copy is gone.

## The two exits

An audit ends in one of two places, and the banner says both:

- **Sign the frozen version off.** The verdict attaches to the image's content
  hash. Nothing done in a copy can change that image — a copy is not the image.
- **Propose a new one.** An auditor who finds something can fix it, and
  deploying that starts a **new version** in Development which travels the same
  road as any other: build, checks, staging, its own freeze, its own sign-off.

So changing what you were asked to approve is never a shortcut through
approving it — it is the other answer, and it costs a full lap of the process.
The banner turns amber-to-violet with a count as soon as the copy diverges, and
names the deploy as a proposal.

## What this is made of

- `kind: "audit"` in a copy's `.copy.json`, with `bp`, `audited_sha` and
  `audited_commit`. Scoped to one business process, exactly like an experiment.
- `GET /copies/audit?bp=` — the audit as it stands for the asking auditor,
  creating nothing: frozen or not, which version, whether they have a copy of
  it, and what they have changed in it.
- `POST /copies/audit` — give them that copy, or return the one they have.
- `AuditingBanner`, an entry point in the Audits section, and the
  `AuditReportTab` that takes Deploy's place.
- `report` on a sign-off: stored by `record_audit`, surfaced on the gate's
  `signoffs` and `approved_by`, and on each deploy record's `audit` entries.

gitops owns the rules (admin/auditor, staging frozen, which commit is under
audit) and resolves the auditor from the identity the gate verified. The
dashboard carries the question across rather than re-deciding it.

## What this replaced

Deleted with the redesign: `audit_env.py`, `audit_agent.py`, `audit_agent.go`
and the daemon's `/audit-agent` API, the temporary container, the `audits`
volume subpath and its three mounts, the audit-env HTTP surface, the audit
chat, and the `AuditEnvironment` panel. Net: about 2,100 lines fewer, and an
auditor who can now fix what they find.
