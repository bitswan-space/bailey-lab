import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { AgentSidebar } from '@/components/agents/AgentSidebar';
import { OpenCodePanel } from '@/components/agents/OpenCodePanel';
import { useAgentChoice } from '@/hooks/useAgentChoice';
import type { AgentKind } from '@/lib/agentKind';
import {
  agentScopeKey,
  dropOtherKinds,
  rememberAgentPanel,
  sameAgentScope,
  type AgentPanelEntry,
  type AgentPanelScope,
} from '@/lib/agentPanels';

/**
 * Keeps the Coding Agent panels alive across navigation.
 *
 * A panel is an iframe hosting an agent's UI — the Claude Code webview, or the
 * OpenCode web UI. Unmounting it, or moving it in the DOM, reloads that page —
 * and the Claude extension reads a reloaded page as a fresh client, closing
 * every live channel and cutting off whatever the agent was doing. Rendering
 * the panel from whichever AgentFilesTab is on screen did exactly that on
 * every BP switch.
 *
 * So the panels are rendered here instead, from a provider that sits above
 * every switch in the app, and positioned over whichever pane is currently
 * asking for one — the way the terminal sessions used to be. The container
 * never changes parent or position in the tree, so React has no reason to
 * touch an iframe: switching BPs only flips which child is `display: block`.
 *
 * Which agent a panel hosts comes from the person's choice (`useAgentChoice`),
 * not from the pane: panes ask for "the agent for this BP", and the provider
 * knows which one that is. Switching agents in Settings drops the other
 * agent's panels.
 *
 * See `@/lib/agentPanels` for which panels stay mounted, and why the order of
 * the list is load-bearing.
 */

interface PaneRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** A pane's scope: a business process inside one copy; the agent is the provider's to add. */
interface PaneScope {
  copy: string;
  bp: string;
}

/** The pane currently asking for a panel, and which BP it wants. */
interface BoundPane {
  scope: PaneScope;
  pane: HTMLElement;
}

interface AgentPanelsContextValue {
  /**
   * Show `scope`'s panel over `pane`, mounting it if this is the first time.
   * Callers re-run this whenever the scope or the element changes.
   */
  showPanel(scope: PaneScope, pane: HTMLElement): void;
  /**
   * Stop showing whatever `pane` was showing. The panel itself stays mounted
   * and connected — that is the whole point — it is just no longer visible.
   * Ignored when `pane` is not the bound one, so a late cleanup from a pane
   * that has already been replaced cannot blank the pane that replaced it.
   */
  hidePanel(pane: HTMLElement): void;
}

// eslint-disable-next-line no-restricted-syntax -- null = used outside the provider
const AgentPanelsContext = createContext<AgentPanelsContextValue | null>(null);

/**
 * Bind a pane element to the agent panel for `copy`/`bp`.
 *
 * Returns a ref callback for the element the panel should cover. While
 * `active` is false nothing is shown, and the panel — if it was ever opened —
 * keeps running in the background.
 */
export function useAgentPanelPane(
  copy: string,
  bp: string,
  active: boolean,
  // eslint-disable-next-line no-restricted-syntax -- null = React's own ref-callback signature
): (el: HTMLElement | null) => void {
  const ctx = useContext(AgentPanelsContext);
  if (!ctx) throw new Error('useAgentPanelPane must be used inside <AgentPanelProvider>');
  const { showPanel, hidePanel } = ctx;
  // State, not a ref: the effect below has to re-run when the element arrives.
  // eslint-disable-next-line no-restricted-syntax -- null = not mounted yet
  const [pane, setPane] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!active || !pane) return;
    showPanel({ copy, bp }, pane);
    return () => hidePanel(pane);
  }, [active, pane, copy, bp, showPanel, hidePanel]);

  return setPane;
}

/** Mounts the agent panels and keeps them positioned. See the file comment. */
export function AgentPanelProvider({ children }: { children: ReactNode }) {
  const choice = useAgentChoice();
  const kind: AgentKind | undefined = choice.state === 'chosen' ? choice.kind : undefined; // eslint-disable-line no-restricted-syntax -- undefined = no agent chosen yet
  const [panels, setPanels] = useState<AgentPanelEntry[]>([]);
  // eslint-disable-next-line no-restricted-syntax -- null = no pane is asking for a panel
  const [bound, setBound] = useState<BoundPane | null>(null);
  // eslint-disable-next-line no-restricted-syntax -- null = no bounds measured yet
  const [rect, setRect] = useState<PaneRect | null>(null);
  // Monotonic tick that orders panels for eviction. A counter rather than a
  // clock: two switches inside the same millisecond still have an order.
  const tick = useRef(0);
  // The agent to mount for a pane that asks now. A ref, so `showPanel` keeps a
  // stable identity and the panes' effects do not re-run on every choice.
  const kindRef = useRef(kind);
  kindRef.current = kind;

  const showPanel = useCallback((scope: PaneScope, pane: HTMLElement) => {
    setBound((prev) =>
      prev && prev.pane === pane && prev.scope.copy === scope.copy && prev.scope.bp === scope.bp
        ? prev
        : { scope, pane },
    );
    const k = kindRef.current;
    if (!k) return;
    tick.current += 1;
    const shownAt = tick.current;
    setPanels((live) => rememberAgentPanel(live, { kind: k, ...scope }, shownAt));
  }, []);

  const hidePanel = useCallback((pane: HTMLElement) => {
    setBound((prev) => (prev && prev.pane === pane ? null : prev));
  }, []);

  // The person switched agents (or chose one for the first time): the other
  // agent's panels go, and the pane that is asking gets the new agent's panel.
  useEffect(() => {
    if (!kind) return;
    setPanels((live) => dropOtherKinds(live, kind));
    if (bound) {
      tick.current += 1;
      const shownAt = tick.current;
      setPanels((live) => rememberAgentPanel(live, { kind, ...bound.scope }, shownAt));
    }
  }, [kind, bound]);

  // Track the bound pane's box so the fixed-position layer can sit exactly on
  // it. ResizeObserver catches the pane changing size (a window resize, the
  // Environment panel appearing); scroll is captured because an ancestor can
  // scroll without the window doing so.
  const pane = bound?.pane;
  useEffect(() => {
    if (!pane) {
      setRect(null);
      return;
    }
    const update = () => {
      const r = pane.getBoundingClientRect();
      setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(pane);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [pane]);

  const value = useMemo<AgentPanelsContextValue>(
    () => ({ showPanel, hidePanel }),
    [showPanel, hidePanel],
  );

  const shown: AgentPanelScope | undefined = bound && kind ? { kind, ...bound.scope } : undefined; // eslint-disable-line no-restricted-syntax -- undefined = nothing to show

  return (
    <AgentPanelsContext.Provider value={value}>
      {children}
      <AgentPanelLayer panels={panels} shown={shown} rect={rect} />
    </AgentPanelsContext.Provider>
  );
}

/**
 * Every mounted panel, in one container that never moves.
 *
 * A zero-sized pane means the pane exists but is hidden (an ancestor is on
 * another tab), so the layer hides rather than drawing a collapsed panel over
 * the corner of the app.
 */
function AgentPanelLayer({
  panels,
  shown,
  rect,
}: {
  panels: AgentPanelEntry[];
  shown?: AgentPanelScope;
  // eslint-disable-next-line no-restricted-syntax -- null = no bounds measured yet
  rect: PaneRect | null;
}) {
  const visible = !!rect && !!shown && rect.width > 0 && rect.height > 0;
  const style: CSSProperties =
    visible && rect
      ? {
          position: 'fixed',
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          overflow: 'hidden',
          // Below every overlay in the app (the lowest is InspectModal at 60):
          // this is page content that happens to be positioned, not something
          // that should ever cover a dialog.
          zIndex: 0,
          // The container passes clicks through to the pane underneath; the
          // panel being shown takes them back for itself.
          pointerEvents: 'none',
        }
      : { display: 'none' };

  return (
    <div style={style}>
      {panels.map(({ scope }) => {
        const on = visible && !!shown && sameAgentScope(scope, shown);
        return (
          <div
            key={agentScopeKey(scope)}
            className="absolute inset-0"
            style={{ display: on ? 'block' : 'none', pointerEvents: on ? 'auto' : 'none' }}
            aria-hidden={!on}
          >
            {scope.kind === 'opencode' ? (
              <OpenCodePanel copy={scope.copy} bp={scope.bp} />
            ) : (
              <AgentSidebar copy={scope.copy} bp={scope.bp} />
            )}
          </div>
        );
      })}
    </div>
  );
}
