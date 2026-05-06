import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export function Terminal() {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      cursorBlink: true,
      // Use system monospace only. A webfont (e.g. Roboto Mono from Google
      // Fonts) loads asynchronously, so xterm would measure cell width
      // against the fallback font at init time and then re-render with the
      // real font, producing visual glitches and ghosted glyphs.
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 13,
      theme: {
        background: '#ffffff',
        foreground: '#18181b',
        cursor: '#18181b',
        cursorAccent: '#ffffff',
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

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/terminal`);
    ws.binaryType = 'arraybuffer';

    const sendResize = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    };

    ws.addEventListener('open', () => {
      term.focus();
      sendResize();
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
    });

    const encoder = new TextEncoder();
    const dataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encoder.encode(data));
      }
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // host may be detached briefly during cleanup
      }
      sendResize();
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataDisposable.dispose();
      ws.close();
      term.dispose();
    };
  }, []);

  return <div ref={hostRef} className="h-full w-full bg-white" />;
}
