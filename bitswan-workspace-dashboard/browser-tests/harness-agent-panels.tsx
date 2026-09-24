// Mounts the REAL AgentPanelProvider / useAgentPanelPane so Playwright drives
// the code we shipped. Verification harness for the Coding Agent panel losing
// its live stream on a BP switch.
//
// What stands in for the app is only the shape around the panel: a pane that
// binds itself to whichever business process is on screen (AgentFilesTab's
// one job here) and a couple of buttons to move between them. The panel
// inside, the provider that mounts it and the layer that positions it are the
// shipped components.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentPanelProvider, useAgentPanelPane } from '@/components/agents/AgentPanels';

const COPY = 'mine';
const BPS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];

/** AgentFilesTab's chat pane, reduced to the contract the provider needs. */
function ChatPane({ bp, active }: { bp: string; active: boolean }) {
  const paneRef = useAgentPanelPane(COPY, bp, active);
  return <main ref={paneRef} data-testid="pane" style={{ position: 'absolute', inset: 0 }} />;
}

function Harness() {
  const [bp, setBp] = useState(BPS[0] ?? 'alpha');
  // Standing in for "the Coding Agent tab is the one you are looking at":
  // false both hides the pane and tells the provider to stop showing a panel,
  // exactly as WorkspaceView's hidden tab and AgentFilesTab's `tabVisible` do.
  const [onAgentTab, setOnAgentTab] = useState(true);

  return (
    <AgentPanelProvider>
      <div id="controls">
        {BPS.map((name) => (
          <button key={name} id={`bp-${name}`} type="button" onClick={() => setBp(name)}>
            {name}
          </button>
        ))}
        <button id="toggle-tab" type="button" onClick={() => setOnAgentTab((v) => !v)}>
          toggle tab
        </button>
        <span id="current">{bp}</span>
      </div>
      <div id="tab" style={{ position: 'relative', height: '400px' }} hidden={!onAgentTab}>
        <ChatPane bp={bp} active={onAgentTab} />
      </div>
    </AgentPanelProvider>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');
createRoot(root).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
