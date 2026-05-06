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
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
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

  return <div ref={hostRef} className="terminal-host" />;
}
