// Minimal shim for the asciinema-player module. Upstream ships JS only; we
// only call .create() and rely on .dispose() in cleanup.
declare module 'asciinema-player' {
  interface PlayerOptions {
    autoPlay?: boolean;
    terminalFontSize?: string;
    theme?: string;
  }
  interface Player {
    dispose?: () => void;
  }
  export function create(
    src: { data: string } | { url: string } | string,
    container: HTMLElement,
    options?: PlayerOptions,
  ): Player;
}

declare module 'asciinema-player/dist/bundle/asciinema-player.css';
