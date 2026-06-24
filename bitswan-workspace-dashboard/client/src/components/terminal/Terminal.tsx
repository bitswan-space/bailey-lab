import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface TerminalProps {
  /**
   * WebSocket path (path + query) the terminal connects to. The component
   * derives ws/wss + host from `window.location`. Required so a single
   * Terminal component can back both the legacy local shell and per-session
   * agent terminals without a config switch in here.
   */
  wsUrl: string;
  /** Fires once when the underlying WebSocket reports close. */
  onExit?: () => void;
}

export function Terminal({ wsUrl, onExit }: TerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Pin the latest onExit in a ref so the effect doesn't tear down + rebuild
  // the xterm/WebSocket pair every time the parent passes a new closure.
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Defer the entire effect body by a macrotask so React 18 strict mode
    // (dev) can run mount → cleanup → mount without us actually constructing
    // the WebSocket on the cancelled first mount. The cleanup `clearTimeout`s
    // the scheduled work; if it fires before the timer, nothing was created
    // and the second mount's timer runs fresh. Without this, both WSes are
    // constructed and both reach `open` fast enough to send a resize before
    // the cleanup close arrives at the server — producing a phantom IDLE
    // session in the sidebar.
    let cancelled = false;
    let teardown: (() => void) | null = null;
    const startHandle = setTimeout(() => {
      if (cancelled) return;
      teardown = startTerminal(host);
    }, 0);

    return () => {
      cancelled = true;
      clearTimeout(startHandle);
      teardown?.();
    };

    function startTerminal(host: HTMLElement): () => void {
      const term = new XTerm({
      cursorBlink: true,
      // System monospace only — a webfont loads async, so xterm would measure
      // cell width against the fallback then re-render with the real font,
      // producing visual glitches and ghosted glyphs.
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        // Match the logs pane background (`bg-zinc-50` in LogsPane.tsx) so
        // the Agents tab feels visually continuous with the inspect logs
        // view instead of jumping to pure white.
        background: '#fafafa',
        foreground: '#18181b',
        cursor: '#18181b',
        cursorAccent: '#fafafa',
        selectionBackground: 'rgba(9, 61, 245, 0.18)',
        selectionForeground: '#18181b',
        black: '#000000',
        red: '#c91b00',
        green: '#00a800',
        yellow: '#a89500',
        blue: '#0e639c',
        magenta: '#a800a8',
        cyan: '#00a8a8',
        white: '#d4d4d4',
        brightBlack: '#71717a',
        brightRed: '#dc2626',
        brightGreen: '#16a34a',
        brightYellow: '#ca8a04',
        brightBlue: '#2563eb',
        brightMagenta: '#c026d3',
        brightCyan: '#0891b2',
        brightWhite: '#000000',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    // Claude's TUI enables mouse tracking, so a plain click-drag is delivered
    // to the app as mouse events rather than selecting text — hold Shift to
    // force a local selection (xterm's built-in bypass). Once selected, xterm
    // does nothing on its own to copy, so wire the standard shortcuts:
    // Cmd+C (mac) or Ctrl+Shift+C (so plain Ctrl+C still sends SIGINT to the
    // process). Returning false stops xterm from also forwarding the keys.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const isCopy =
        (e.metaKey && e.key.toLowerCase() === 'c') ||
        (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c');
      if (isCopy && term.hasSelection()) {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard?.writeText(sel);
        return false;
      }
      return true;
    });

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}${wsUrl}`);
    ws.binaryType = 'arraybuffer';
    // Track whether the connection actually reached OPEN. React 18 strict mode
    // intentionally double-invokes effects in dev (mount → cleanup → mount), so
    // the first WS is `.close()`d while still in CONNECTING. Without this flag
    // the cleanup would fire `onExit` on a session that never actually started,
    // and the parent would mark it ended before the re-mounted WS has a chance.
    let wasOpened = false;
    // eslint-disable-next-line no-restricted-syntax -- null = no nudge scheduled
    let redrawNudge: ReturnType<typeof setTimeout> | null = null;

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.addEventListener('open', () => {
      wasOpened = true;
      term.focus();
      sendResize();
      // Redraw nudge: when reconnecting to a still-running session (the agent
      // persists server-side in dtach across browser close / refresh), the
      // remote full-screen TUI — Claude is an Ink/React app — only repaints on
      // an actual dimension *change*; a plain reattach at the same size (even
      // with a same-size SIGWINCH) leaves the screen blank until the user
      // manually resizes. Once the attach has settled, briefly shrink the
      // terminal by one row then restore it — a genuine resize delta that
      // forces the remote to repaint. Harmless for fresh sessions.
      const nudge = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN || term.rows < 2) return;
        const rows = term.rows;
        const cols = term.cols;
        term.resize(cols, rows - 1);
        sendResize();
        redrawNudge = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          term.resize(cols, rows);
          sendResize();
        }, 150);
      }, 600);
      redrawNudge = nudge;
    });

    ws.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(ev.data));
        return;
      }
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'exit') {
            term.write(`\r\n\x1b[33m[process exited${
              typeof msg.exitCode === 'number' ? ` code=${msg.exitCode}` : ''
            }]\x1b[0m\r\n`);
          } else if (msg.type === 'error') {
            term.write(`\r\n\x1b[31m[error: ${msg.message}]\x1b[0m\r\n`);
          }
        } catch {
          // ignore non-JSON text frames
        }
      }
    });

    ws.addEventListener('close', () => {
      term.write('\r\n\x1b[90m[connection closed]\x1b[0m\r\n');
      if (wasOpened) onExitRef.current?.();
    });

    const encoder = new TextEncoder();
    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data));
      }
    });

    const observer = new ResizeObserver((entries) => {
      // When the host gets `display: none` (e.g. user switches dashboard
      // tabs or selects another session), the observer fires with a 0×0
      // contentRect. Running fit.fit() on that resizes xterm to 0 cols
      // and we'd push `{cols:0, rows:0}` to the server PTY — Claude would
      // then render its next reply at width 0 until the next real resize.
      // Skip both the fit and the resize message in that case; the next
      // observer tick (when display returns to block) will catch up.
      const rect = entries[0]?.contentRect;
      if (!rect || rect.width === 0 || rect.height === 0) return;
      try {
        fit.fit();
      } catch {
        // host may be detached briefly during cleanup
      }
      sendResize();
    });
    observer.observe(host);

      return () => {
        if (redrawNudge) clearTimeout(redrawNudge);
        observer.disconnect();
        dataDisposable.dispose();
        ws.close();
        term.dispose();
      };
    }
  }, [wsUrl]);

  return <div ref={hostRef} className="h-full w-full bg-zinc-50" />;
}
