import { useMemo } from 'react';
import CodeMirror, { keymap, type Extension } from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { go } from '@codemirror/lang-go';

interface Props {
  /** Current buffer contents. Controlled by the parent. */
  value: string;
  /** Path used purely for language detection by extension. */
  path: string;
  readOnly?: boolean;
  onChange: (next: string) => void;
  /** Fired when the user presses ⌘/Ctrl+S inside the editor. */
  onSave: () => void;
}

/**
 * Resolve a language extension by filename. Returns `null` for files we
 * don't have a pack for — CodeMirror still renders the buffer with no
 * highlighting, which is the most graceful fallback for arbitrary text.
 */
function resolveLanguage(path: string): Extension | null {
  const lower = path.toLowerCase();
  // JavaScript pack covers .js / .jsx / .ts / .tsx — pick the right config
  // so JSX-aware highlighting kicks in on the React files in the workspace.
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs')
  ) {
    const isTs = lower.endsWith('.ts') || lower.endsWith('.tsx');
    const isJsx = lower.endsWith('.jsx') || lower.endsWith('.tsx');
    return javascript({ jsx: isJsx, typescript: isTs });
  }
  if (lower.endsWith('.py') || lower.endsWith('.pyi')) return python();
  if (lower.endsWith('.go')) return go();
  return null;
}

/**
 * CodeMirror 6 editor with TS/JS/Python/Go highlighting. Lazy-loaded by
 * `FileViewer` so the editor bundle (≈170 KB gzipped) only lands when a
 * user actually opens a file — keeps the initial dashboard chunk lean.
 */
export default function CodeEditor({
  value,
  path,
  readOnly = false,
  onChange,
  onSave,
}: Props) {
  const extensions = useMemo<Extension[]>(() => {
    const lang = resolveLanguage(path);
    return [
      keymap.of([
        {
          key: 'Mod-s',
          // `preventDefault` returns true so the browser's "save page" dialog
          // never fires.
          run: () => {
            onSave();
            return true;
          },
          preventDefault: true,
        },
      ]),
      ...(lang ? [lang] : []),
    ];
  }, [path, onSave]);

  return (
    // `height="100%"` is the prop CodeMirror uses to wire up its own
    // scroller against the parent's height — without it `.cm-scroller`
    // grows to fit the buffer and you can't vertically scroll inside
    // a constrained pane. We also set the wrapper to `h-full` so the
    // 100% has something to resolve against.
    <div className="h-full overflow-hidden">
      <CodeMirror
        value={value}
        onChange={onChange}
        readOnly={readOnly}
        extensions={extensions}
        // Match the rest of the dashboard's monospace + bg.
        theme="light"
        height="100%"
        basicSetup={{
          // Keep this lean — we only want the highlighting + line numbers.
          // Search, completion, lint can be added later behind explicit imports.
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightSpecialChars: true,
          history: true,
          foldGutter: true,
          drawSelection: true,
          dropCursor: true,
          allowMultipleSelections: true,
          indentOnInput: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: false,
          rectangularSelection: true,
          crosshairCursor: false,
          highlightActiveLine: true,
          highlightSelectionMatches: false,
          searchKeymap: false,
          foldKeymap: true,
          completionKeymap: false,
          lintKeymap: false,
        }}
        style={{ height: '100%', fontSize: 12, background: '#fafafa' }}
      />
    </div>
  );
}
