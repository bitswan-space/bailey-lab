import { useEffect, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import { api, type DataScope, type ObjectPreview } from '@/lib/api';
import { fmtBytes } from './format';

interface Props {
  scope: DataScope;
  objKey: string;
  onClose: () => void;
}

const TEXTUAL = /^text\/|[/+](json|xml|yaml|x-yaml|javascript|csv)$/;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Right-hand preview of one object: inline image / text (size-capped
 * upstream), or a "no preview" fallback — plus a Download link that streams
 * the full object through the dashboard (cookie-authed href).
 */
export function ObjectPreviewPane({ scope, objKey, onClose }: Props) {
  // eslint-disable-next-line no-restricted-syntax -- null = loading
  const [preview, setPreview] = useState<ObjectPreview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError('');
    api.data
      .objectPreview(scope, objKey)
      .then((p) => {
        if (!alive) return;
        if (!p) setError('Object not found.');
        else setPreview(p);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope fields are primitives
  }, [scope.bp, scope.stage, scope.copy, objKey]);

  const name = objKey.split('/').pop() || objKey;

  return (
    <div className="flex min-h-0 w-[45%] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate font-mono text-xs font-semibold text-foreground" title={objKey}>
            {name}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {preview ? `${preview.content_type} · ${fmtBytes(preview.size)}` : '…'}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <a
            href={api.data.objectDownloadUrl(scope, objKey)}
            download={name}
            className="flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
          >
            <Download className="size-3" aria-hidden />
            Download
          </a>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4 text-xs text-red-600">{error}</div>
        ) : !preview ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
        ) : preview.truncated ? (
          <div className="m-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            Too large to preview inline — download the object to view it.
          </div>
        ) : (
          <PreviewBody preview={preview} />
        )}
      </div>
    </div>
  );
}

function PreviewBody({ preview }: { preview: ObjectPreview }) {
  const b64 = preview.content_base64 ?? '';
  if (preview.content_type.startsWith('image/')) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <img
          src={`data:${preview.content_type};base64,${b64}`}
          alt={preview.key}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  if (TEXTUAL.test(preview.content_type)) {
    let text = '';
    try {
      text = new TextDecoder().decode(decodeBase64(b64));
    } catch {
      text = '';
    }
    if (text) {
      return (
        <pre className="whitespace-pre-wrap break-words p-4 font-mono text-xs text-foreground">
          {text}
        </pre>
      );
    }
  }
  return (
    <div className="p-4 text-xs text-muted-foreground">
      No inline preview for this file type — use Download.
    </div>
  );
}
