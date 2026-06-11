import { useEffect, useRef } from 'react';
import { create as createPlayer } from 'asciinema-player';
import 'asciinema-player/dist/bundle/asciinema-player.css';

interface Props {
  castFile: string;
}

/**
 * Asciinema player for a past session's `.cast` file. Fetches the recording
 * from the dashboard server's cast-stream endpoint and mounts the player
 * into a managed container. The player is lazy-loaded by the parent (see
 * AgentsTab) so unused asciinema bundle weight doesn't land in the main chunk.
 */
export function AsciinemaPlayback({ castFile }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let cancelled = false;
    let player: { dispose?: () => void } | null = null;

    (async () => {
      try {
        const r = await fetch(
          `/api/coding-agent/sessions/${encodeURIComponent(castFile)}/content`,
          { credentials: 'include', cache: 'no-store' },
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const text = await r.text();
        if (cancelled) return;
        // The player accepts an inline data source — avoids a second fetch.
        // `solarized-light` is the bundled light theme; matches the rest of
        // the dashboard's light surfaces better than the default (dark)
        // asciinema theme.
        player = createPlayer(
          { data: text },
          host,
          {
            autoPlay: true,
            terminalFontSize: '13px',
            theme: 'solarized-light',
          },
        );
      } catch (err) {
        if (!cancelled) {
          host.textContent = `Failed to load recording: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
      }
    })();

    return () => {
      cancelled = true;
      player?.dispose?.();
      host.innerHTML = '';
    };
  }, [castFile]);

  return <div ref={hostRef} className="h-full w-full bg-zinc-50" />;
}
