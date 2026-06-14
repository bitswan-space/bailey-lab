// worktree-data.jsx — extra data for the new worktree tabs

const WT_REQUIREMENTS = {
  'hr-module:tomas': [
    { id:'REQ-040', status:'pass',   depth:0, text:'Employees can self-serve onboarding via the public portal',
      detail:'Onboarding wizard collects passport, tax, bank details. Stores encrypted at rest. Triggers welcome email.\n- All fields validated client-side\n- Required: passport, tax id, IBAN\n- Optional: emergency contact\n\nUses **employee.onboarding.create** event.' },
    { id:'REQ-041', status:'pass',   depth:1, text:'Wizard validates IBAN format before submit', parent:'REQ-040',
      detail:'Use `iban-utils` lib. Block submit on invalid format with inline error.' },
    { id:'REQ-042', status:'review', depth:0, text:'Toggl payroll sync runs hourly and reconciles by employee + project',
      detail:'Pull last 24h of time entries from Toggl. Match to internal employee + project IDs.\n\n1. Fetch via `/api/toggl/time_entries`\n2. Resolve unknown projects to *Unmapped* bucket\n3. Emit `payroll.timesheet.synced` event\n\nFailure modes — Toggl 5xx → retry w/ backoff. Mapping miss → log warning, do not fail run.' },
    { id:'REQ-043', status:'todo',   depth:0, text:'OPEX comparison item-to-category mapping',
      detail:'Map line items from invoice OCR to budget categories using fuzzy matcher (Levenshtein ≤ 2). Allow per-item override stored in `opex_overrides` table.' },
    { id:'REQ-044', status:'review', depth:0, text:'Compensation list shows probation flag and end date',
      detail:'Add `probation_end` column. Visual badge for employees in probation. Sort/filter by probation status.' },
    { id:'REQ-045', status:'todo',   depth:0, text:'Backups: download + import DB backup from Settings',
      detail:'New Settings page section.\n- **Download** — `/api/db/export` returns gzip JSON\n- **Import** — drag & drop, validates schema, runs migration in tx' },
    { id:'REQ-046', status:'fail',   depth:0, text:'Forecast lock moves dynamically with current month',
      detail:'`cellReadOnly` should lock indices `< CURRENT_MONTH_IDX` (not hardcoded `i < 3`). Label updates from "Jan–Apr" → "Jan–May" as month rolls over.' },
  ],
  'hr-module:pavel':  [
    { id:'REQ-050', status:'pass',  depth:0, text:'Compensation detail shows audit trail of changes', detail:'' },
    { id:'REQ-051', status:'review', depth:0, text:'Bulk-edit comp from selected rows on the list', detail:'' },
  ],
  'hr-module:jana':   [
    { id:'REQ-060', status:'todo',  depth:0, text:'Reporting: monthly headcount + cost per department', detail:'' },
  ],
  'invoice-automation:tomas': [
    { id:'REQ-100', status:'review', depth:0, text:'Three-way-match exception flow', detail:'' },
    { id:'REQ-101', status:'pass',   depth:0, text:'Vendor template matching for header layout', detail:'' },
  ],
};

const WT_AGENT_SESSIONS = {
  'hr-module:tomas': [
    { id:'s1', name:'OPEX comparison mapping', status:'running', kind:'agent',
      branch:'tomas/PL-2026-copy', model:'claude-haiku-4-5',
      tokens:'24.3k / 200k', elapsed:'1m 24s', lastActive:'now' },
    { id:'s-sync-1', name:'Rebase onto main', status:'running', kind:'sync',
      branch:'tomas/PL-2026-copy', model:'—',
      tokens:'—', elapsed:'12s', lastActive:'now',
      summary:'Rebasing 4 commits onto main · 12 files staged' },
    { id:'s2', name:'Settings page — DB backup', status:'idle', kind:'agent',
      branch:'tomas/PL-2026-copy', model:'claude-haiku-4-5',
      tokens:'8.1k / 200k', elapsed:'2m 18s', lastActive:'4 hours ago',
      summary:'Built Settings page · 1 commit a73c4f1' },
    { id:'s-test-1', name:'Payroll regression suite', status:'running', kind:'testing',
      branch:'tomas/PL-2026-copy', model:'pytest',
      tokens:'—', elapsed:'48s', lastActive:'now',
      summary:'14 of 22 tests passed · 3 failing · 5 pending' },
    { id:'s3', name:'Forecast lock dynamic month', status:'paused', kind:'agent',
      branch:'tomas/PL-2026-copy', model:'claude-haiku-4-5',
      tokens:'12.4k / 200k', elapsed:'1m 14s', lastActive:'yesterday',
      summary:'Refactored forecast lock · 1 commit b8853a2' },
    { id:'s-test-2', name:'Selenium smoke · onboarding flow', status:'idle', kind:'testing',
      branch:'tomas/PL-2026-copy', model:'selenium',
      tokens:'—', elapsed:'2m 04s', lastActive:'2 hours ago',
      summary:'All 8 scenarios passed' },
  ],
  'hr-module:pavel':  [
    { id:'s4', name:'Compensation audit trail', status:'idle', kind:'agent', branch:'pavel/hr',
      model:'claude-haiku-4-5', tokens:'5.2k / 200k', elapsed:'58s', lastActive:'2d ago' },
  ],
  'hr-module:jana':   [],
  'invoice-automation:tomas': [
    { id:'s5', name:'Three-way match exceptions', status:'running', kind:'agent', branch:'tomas/inv',
      model:'claude-haiku-4-5', tokens:'18.7k / 200k', elapsed:'4m 02s', lastActive:'now' },
  ],
};

// Files tree per worktree key. Tree is a recursive list.
const WT_FILES = {
  'hr-module:tomas': {
    tree: [
      { name:'apps', kind:'folder', open:true, children:[
        { name:'backend-hr', kind:'folder', open:true, children:[
          { name:'src', kind:'folder', open:true, children:[
            { name:'api', kind:'folder', children:[
              { name:'employees.py', kind:'file', changed:'M' },
              { name:'payroll.py',   kind:'file', changed:'M' },
              { name:'toggl_sync.py', kind:'file', changed:'A' },
            ]},
            { name:'models', kind:'folder', children:[
              { name:'employee.py', kind:'file' },
              { name:'compensation.py', kind:'file', changed:'M' },
            ]},
            { name:'main.py', kind:'file' },
          ]},
          { name:'tests', kind:'folder', children:[
            { name:'test_toggl_sync.py', kind:'file', changed:'A' },
          ]},
          { name:'README.md', kind:'file' },
        ]},
        { name:'frontend-public', kind:'folder', children:[
          { name:'src', kind:'folder', children:[
            { name:'pages', kind:'folder', children:[
              { name:'Onboarding.tsx', kind:'file', changed:'M' },
              { name:'Settings.tsx',   kind:'file', changed:'A' },
            ]},
          ]},
        ]},
      ]},
      { name:'docker-compose.yml', kind:'file' },
      { name:'README.md', kind:'file' },
    ],
    open: 'apps/backend-hr/src/api/toggl_sync.py',
    contents: {
      'apps/backend-hr/src/api/toggl_sync.py':
`from datetime import datetime, timedelta
from typing import Iterable

from app.models import Employee, TimeEntry
from app.events import emit
from app.toggl import TogglClient


def sync_recent(window_hours: int = 24) -> dict:
    """Pull last \`window_hours\` of Toggl time entries and reconcile."""
    since = datetime.utcnow() - timedelta(hours=window_hours)
    client = TogglClient.from_env()
    entries = client.fetch_time_entries(since=since)

    matched, unmatched = [], []
    for raw in entries:
        emp = Employee.by_toggl_id(raw["user_id"])
        if not emp:
            unmatched.append(raw)
            continue
        matched.append(TimeEntry.from_toggl(raw, employee=emp))

    TimeEntry.upsert_many(matched)
    emit("payroll.timesheet.synced", {
        "matched": len(matched),
        "unmatched": len(unmatched),
        "window_hours": window_hours,
    })

    return {"matched": len(matched), "unmatched": unmatched}
`,
    },
  },
};

// Diff data — list of changed files + a sample unified diff
const WT_DIFFS = {
  'hr-module:tomas': {
    files: [
      { path:'apps/backend-hr/src/api/toggl_sync.py', kind:'A', adds:48, dels:0  },
      { path:'apps/backend-hr/src/api/payroll.py',     kind:'M', adds:12, dels:4  },
      { path:'apps/backend-hr/src/api/employees.py',   kind:'M', adds:6,  dels:2  },
      { path:'apps/backend-hr/src/models/compensation.py', kind:'M', adds:9, dels:1 },
      { path:'apps/backend-hr/tests/test_toggl_sync.py', kind:'A', adds:84, dels:0 },
      { path:'apps/frontend-public/src/pages/Onboarding.tsx', kind:'M', adds:22, dels:8 },
      { path:'apps/frontend-public/src/pages/Settings.tsx',   kind:'A', adds:142, dels:0 },
    ],
    selected: 'apps/backend-hr/src/api/payroll.py',
    diff: `@@ -34,7 +34,11 @@ def run_payroll(period: PayrollPeriod) -> PayrollRun:
-    timesheets = TimeEntry.for_period(period)
+    # NEW: pull from Toggl-synced entries instead of legacy table
+    timesheets = TimeEntry.synced_for_period(period)
+    if not timesheets:
+        log.warning("payroll.no_entries", period=period.id)
+        return PayrollRun.empty(period)
     payouts = []
     for emp in Employee.active():
         hours = timesheets.hours_for(emp)
@@ -52,4 +56,5 @@ def run_payroll(period: PayrollPeriod) -> PayrollRun:
     run.commit()
+    emit("payroll.run.completed", {"period": period.id, "n": len(payouts)})
     return run`,
  },
};

// Per-session notes — short snippets the agent saved (or the user added)
const WT_AGENT_NOTES = {
  s1: [
    { id:'n1', who:'agent', at:'2m ago',
      text:'OPEX schema has 12 columns — Date, Vendor, Category, Subcategory, Amount, Currency, FX, Project, CostCenter, GL, Approver, Memo.' },
    { id:'n2', who:'agent', at:'1m ago',
      text:'Levenshtein ≤ 2 captures ~94% of vendor variants; remaining ~6% need manual aliasing.' },
    { id:'n3', who:'user',  at:'40s ago',
      text:'Remember: ask product before auto-creating new categories — they want a review step.' },
  ],
  s2: [
    { id:'n4', who:'agent', at:'4h ago',
      text:'Settings page uses the same TabbedCard as Compensation. Re-used <SettingsSection> for grouping.' },
  ],
  's-sync-1': [
    { id:'n5', who:'agent', at:'just now',
      text:'Conflict in apps/backend-hr/src/api/payroll.py — both branches added new fields to PayrollRun. Auto-merged.' },
  ],
  's-test-1': [
    { id:'n6', who:'agent', at:'just now',
      text:'test_payroll_run_with_negative_hours — failing because emp.hours can now be negative after the toggl sync rebase. Need product clarification.' },
  ],
  s3: [], s4: [], s5: [], 's-test-2':[],
};

// Per-session "plan" markdown (what the agent is doing / planning to do)
const WT_AGENT_PLANS = {
  s1: `# Plan: OPEX comparison mapping

Goal: map raw OPEX line items to budget categories so the variance report can group them.

## Steps
1. **Read OPEX schema** — confirm 12 columns and which ones identify a line.
2. **Build fuzzy matcher** — Levenshtein ≤ 2 on the Vendor + Memo concatenation.
3. **Persist overrides** — \`opex_overrides\` table; user can correct any auto-mapping.
4. **Tests** — golden file covering all current rows.
5. **Update REQ-043 status** when above passes.

## Risks
- Multi-currency rows need FX-normalised amounts before comparison.
- Some vendors share names across cost centers; need a tiebreaker.

## Open questions
- Should auto-mapped rows be confirmed by an auditor before being shown in the report?
`,
  s2: `# Plan: Settings page — DB backup

Add a "Backup & restore" panel in Settings that lets ops trigger an on-demand pg_dump and download it.

- [x] Backend endpoint \`POST /api/settings/backup\`
- [x] Streaming response so large dumps don't OOM
- [x] UI button + last-backup timestamp
- [ ] Schedule (daily / weekly) — punted to next iteration
`,
  's-sync-1': `# Plan: Rebase onto main

Rebase \`tomas/PL-2026-copy\` (4 commits ahead, 12 behind) onto main.

1. \`git fetch origin main\`
2. \`git rebase origin/main\`
3. Resolve conflicts in:
   - apps/backend-hr/src/api/payroll.py
   - apps/backend-hr/src/api/toggl_sync.py
4. Run the test suite locally.
5. Force-push to PR branch.
`,
  's-test-1': `# Plan: Payroll regression suite

Run pytest with the new toggl-sync code paths to make sure nothing regressed.

- 22 tests collected
- 14 passing
- 3 failing (see notes)
- 5 pending (need fixtures with rebased data)
`,
  s3:'', s4:'', s5:'', 's-test-2':'',
};

window.WD_WT_DATA = { WT_REQUIREMENTS, WT_AGENT_SESSIONS, WT_AGENT_NOTES, WT_AGENT_PLANS, WT_FILES, WT_DIFFS };
