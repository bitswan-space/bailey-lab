import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

interface AgentSidebarProps {
  copy: string;
  bp: string;
}

/**
 * The Claude Code VS Code sidebar, hosted by the dashboard's own partial
 * `vscode` API (server/src/vscode-host). The extension's webview HTML is
 * extension-authored and runs with scripts enabled, so it is confined to a
 * sandboxed frame WITHOUT `allow-same-origin`: it gets an opaque origin and
 * cannot reach the dashboard's DOM, cookies or storage. Its only channel out is
 * the websocket bridge to the extension host, which is exactly the channel VS
 * Code gives a webview.
 */
export function AgentSidebar({ copy, bp }: AgentSidebarProps) {
  const [available, setAvailable] = useState<boolean>();

  useEffect(() => {
    let alive = true;
    void fetch('/api/coding-agent/sidebar/status', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { available: false }))
      .then((j: { available?: boolean }) => {
        if (alive) setAvailable(Boolean(j.available));
      })
      .catch(() => {
        if (alive) setAvailable(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (available === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
        Starting the agent…
      </div>
    );
  }

  if (!available) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        The agent sidebar isn&apos;t available on this workspace.
      </div>
    );
  }

  const src = `/api/coding-agent/sidebar/view?copy=${encodeURIComponent(copy)}&bp=${encodeURIComponent(bp)}`;
  return (
    <iframe
      key={src}
      title="Claude Code"
      src={src}
      sandbox="allow-scripts allow-forms allow-popups"
      className="h-full w-full border-0 bg-white"
    />
  );
}
