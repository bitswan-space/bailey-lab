/**
 * Which coding-agent panels stay mounted, and in what order.
 *
 * The Coding Agent tab is an iframe hosting the Claude Code webview, and the
 * extension behind it treats a client `init` that carries no channel id as
 * "the client reloaded": it closes every live channel, aborting whatever the
 * agent was in the middle of. That is the right call in VS Code, where the
 * webview's context is retained and a channel-less init only ever follows a
 * window reload. Here the page is ours to keep, and we were throwing it away
 * on every BP switch — so coming back to a BP killed the run that had been
 * going on while you were away, leaving a conversation that reads as finished.
 *
 * So the panels live above the BP switch: each scope the user has opened the
 * chat pane for keeps its page mounted (hidden when it is not the one being
 * looked at), and switching between them only changes which one is shown.
 * This module is the bookkeeping, kept pure so it can be tested without a
 * browser (the client's test runner only covers `lib/*.test.ts`).
 */

/** One panel's scope: a business process inside one copy. */
export interface AgentPanelScope {
  copy: string;
  bp: string;
}

/**
 * A mounted panel. `shownAt` is a monotonic counter, not a clock: it only has
 * to order panels against each other for eviction.
 */
export interface AgentPanelEntry {
  scope: AgentPanelScope;
  shownAt: number;
}

/**
 * How many panels stay alive at once.
 *
 * Each one is a full Claude Code webview — a multi-megabyte bundle, a
 * websocket, and an extension host process behind it — so this is not free.
 * Four covers the BPs a person actually moves between in a sitting; the least
 * recently shown panel beyond that is dropped, and revisiting it reloads, i.e.
 * it falls back to exactly the behaviour every scope had before.
 */
export const MAX_LIVE_AGENT_PANELS = 4;

/** Whether two scopes name the same panel. */
export function sameAgentScope(a: AgentPanelScope, b: AgentPanelScope): boolean {
  return a.copy === b.copy && a.bp === b.bp;
}

/** Stable React key for a scope. */
export function agentScopeKey(scope: AgentPanelScope): string {
  return `${scope.copy} ${scope.bp}`;
}

/**
 * The live panels after showing `scope`, capped at `max`.
 *
 * Insertion order is preserved and never shuffled: React reorders children by
 * moving their DOM nodes, and moving an iframe in the DOM reloads it — which
 * is the very thing this whole mechanism exists to avoid. So a panel that is
 * already mounted keeps its place in the list and only has its `shownAt`
 * bumped; a new one is appended; and when the cap is reached the least
 * recently shown of the *others* is dropped, which leaves everyone else's
 * position untouched.
 */
export function rememberAgentPanel(
  live: AgentPanelEntry[],
  scope: AgentPanelScope,
  shownAt: number,
  max: number = MAX_LIVE_AGENT_PANELS,
): AgentPanelEntry[] {
  const cap = Math.max(1, max);
  const existing = live.find((e) => sameAgentScope(e.scope, scope));
  if (existing) {
    if (existing.shownAt === shownAt) return live;
    return live.map((e) => (e === existing ? { scope: e.scope, shownAt } : e));
  }
  const kept = live.length + 1 > cap ? dropLeastRecent(live, cap - 1) : live;
  return [...kept, { scope, shownAt }];
}

/** The `keep` most recently shown entries, in their original order. */
function dropLeastRecent(live: AgentPanelEntry[], keep: number): AgentPanelEntry[] {
  if (live.length <= keep) return live;
  const survivors = new Set(
    [...live].sort((a, b) => b.shownAt - a.shownAt).slice(0, Math.max(0, keep)),
  );
  return live.filter((e) => survivors.has(e));
}
