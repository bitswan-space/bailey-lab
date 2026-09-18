// Mounts the REAL RequirementsTable (not a replica) so Playwright drives the
// component we shipped. Verification harness for bailey-lab#268.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RequirementsTable } from '@/components/requirements/RequirementsTable';
import type { Requirement } from '@/lib/api';

/**
 * REQ-1            (has children)
 *   REQ-1.1        (has children)
 *     REQ-1.1.1
 *   REQ-1.2
 * REQ-2
 * REQ-3
 */
const SEED: Requirement[] = [
  { id: 'REQ-1', description: 'Auth works', status: 'pass', parent: '', hasTest: true },
  { id: 'REQ-1.1', description: 'Login form validates', status: 'pass', parent: 'REQ-1', hasTest: true },
  { id: 'REQ-1.1.1', description: 'Password min length', status: 'fail', parent: 'REQ-1.1', hasTest: true },
  { id: 'REQ-1.2', description: 'Session expires', status: 'pending', parent: 'REQ-1' },
  { id: 'REQ-2', description: 'Billing', status: 'proposed', parent: '' },
  { id: 'REQ-3', description: 'Audit log', status: 'pass', parent: '', hasTest: true },
];

function Harness() {
  const [reqs, setReqs] = useState<Requirement[]>(SEED);
  const [pendingEditId, setPendingEditId] = useState<string | null>(null);
  // Mirrors RequirementsTab: a new requirement is appended and opens in edit
  // mode. Stubbing this out would make the add-row's Enter untestable.
  const addRoot = () => {
    const id = `REQ-NEW-${reqs.length}`;
    setReqs((prev) => [...prev, { id, description: '', status: 'pending', parent: '' }]);
    setPendingEditId(id);
  };
  return (
    <TooltipProvider>
      {/* A control before and after the grid, to prove Tab enters and leaves. */}
      <button id="before">before</button>
      <RequirementsTable
        requirements={reqs}
        pendingEditId={pendingEditId}
        onEditDone={() => setPendingEditId(null)}
        onAcceptProposal={() => {}}
        onSendBack={() => {}}
        onUndoSendBack={() => {}}
        sentBack={new Set()}
        onUpdateDescription={(req, text) =>
          setReqs((prev) => prev.map((r) => (r.id === req.id ? { ...r, description: text } : r)))
        }
        onAddChild={() => {}}
        onAddRoot={addRoot}
        onDelete={() => {}}
        onRunTest={() => {}}
        runningIds={new Set()}
      />
      <button id="after">after</button>
    </TooltipProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
