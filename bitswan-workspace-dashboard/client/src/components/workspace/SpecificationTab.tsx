import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Save } from 'lucide-react';
import { toast } from '@/lib/notify';
import {
  ProseMirror,
  ProseMirrorDoc,
  reactKeys,
} from '@handlewithcare/react-prosemirror';
import { baseKeymap, setBlockType, toggleMark } from 'prosemirror-commands';
import { gapCursor } from 'prosemirror-gapcursor';
import 'prosemirror-gapcursor/style/gapcursor.css';
import { history, redo, undo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import {
  defaultMarkdownParser,
  defaultMarkdownSerializer,
  schema as markdownSchema,
} from 'prosemirror-markdown';
import type { Attrs, Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { splitListItem } from 'prosemirror-schema-list';
import { EditorState, Plugin, type Transaction } from 'prosemirror-state';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { useSessions } from '@/components/agents/SessionProvider';
import { FlowchartEditorModal } from '@/components/workspace/FlowchartEditorModal';
import { SpecAttachments } from '@/components/workspace/SpecAttachments';
import { SpecEditorToolbar } from '@/components/workspace/SpecEditorToolbar';
import { codeHighlightPlugin } from '@/components/workspace/spec-code-highlight';
import {
  buildMarkdownInputRules,
  dedentListItem,
  indentListItem,
  selectCodeBlockContent,
  toggleBlockquote,
  toggleCodeBlock,
  toggleHeading,
  toggleList,
} from '@/components/workspace/spec-editor-commands';
import {
  SpecEditorContext,
  specNodeViewComponents,
  type SpecEditorContextValue,
} from '@/components/workspace/spec-node-views';
import { api, type FileEtag } from '@/lib/api';
import { invalidateReadme } from '@/hooks/useReadme';
import type { BusinessProcess } from '@/types';

interface SpecificationTabProps {
  bp: BusinessProcess;
  /** Copy whose copy of the README is edited. */
  copy: string;
  /** Flips the workspace to the Coding Agent tab (Build automation). */
  onShowAgents: () => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

/**
 * Save lifecycle. Edits debounce into an autosave; the Save button and
 * Ctrl+S force an immediate save. A 409 etag conflict pauses autosave —
 * a forced save then overwrites deliberately.
 */
type SaveState =
  | { kind: 'clean' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'conflict' }
  | { kind: 'error'; message: string };

const AUTOSAVE_DELAY_MS = 1200;

const PLACEHOLDER =
  'Describe your business process — what it does, who uses it, and what success looks like…';

function docIsEmpty(doc: PMNode): boolean {
  return (
    doc.childCount === 1 &&
    !!doc.firstChild &&
    doc.firstChild.isTextblock &&
    doc.firstChild.content.size === 0
  );
}

/**
 * Keep an editable paragraph at the end of the document. Without it, a
 * trailing diagram or horizontal rule leaves nowhere to click and type —
 * the document would end in a block the cursor can't enter.
 */
const trailingParagraphPlugin = new Plugin({
  appendTransaction(_transactions, _oldState, newState) {
    const last = newState.doc.lastChild;
    if (!last || last.type !== markdownSchema.nodes.paragraph) {
      return newState.tr.insert(
        newState.doc.content.size,
        markdownSchema.nodes.paragraph.create(),
      );
    }
    return undefined;
  },
});

/**
 * Normalize every list to tight. Lists created by editing commands
 * (wrapInList, sinkListItem) default to `tight: false`, which the
 * markdown serializer renders with a blank line between items — after an
 * indent or dedent the list visually falls apart into separate lists.
 * Loose lists in loaded files are normalized too (on first edit), so the
 * editor consistently authors tight lists.
 */
const tightListsPlugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((tr) => tr.docChanged)) return undefined;
    const { bullet_list, ordered_list } = markdownSchema.nodes;
    const loose: { pos: number; attrs: Attrs }[] = [];
    newState.doc.descendants((node, pos) => {
      if (
        (node.type === bullet_list || node.type === ordered_list) &&
        node.attrs.tight !== true
      ) {
        loose.push({ pos, attrs: { ...node.attrs, tight: true } });
      }
      return true;
    });
    if (loose.length === 0) return undefined;
    const tr = newState.tr;
    for (const { pos, attrs } of loose) tr.setNodeMarkup(pos, undefined, attrs);
    return tr;
  },
});

/**
 * Build the editor state for a README. The document model is
 * prosemirror-markdown's, so content round-trips losslessly to the
 * markdown the coding agent and the read-only ReadmeCard consume —
 * including ```mermaid blocks, which render as diagram previews.
 */
function createSpecState(
  markdown: string,
  onSave: () => void,
  onOpenLink: () => void,
  onOpenImage: () => void,
  onInsertDiagram: () => void,
): EditorState {
  const doc = defaultMarkdownParser.parse(markdown);
  return EditorState.create({
    schema: markdownSchema,
    ...(doc ? { doc } : {}),
    plugins: [
      reactKeys(),
      history(),
      gapCursor(),
      trailingParagraphPlugin,
      tightListsPlugin,
      codeHighlightPlugin,
      buildMarkdownInputRules(),
      keymap({
        'Mod-z': undo,
        'Mod-y': redo,
        'Mod-Shift-z': redo,
        'Mod-a': selectCodeBlockContent,
        'Mod-b': toggleMark(markdownSchema.marks.strong),
        'Mod-i': toggleMark(markdownSchema.marks.em),
        'Mod-e': toggleMark(markdownSchema.marks.code),
        'Mod-Shift-1': toggleHeading(1),
        'Mod-Shift-2': toggleHeading(2),
        'Mod-Shift-3': toggleHeading(3),
        'Mod-Shift-4': toggleHeading(4),
        'Mod-Shift-0': setBlockType(markdownSchema.nodes.paragraph),
        'Mod-Alt-c': toggleCodeBlock,
        'Mod-Shift-7': toggleList(markdownSchema.nodes.ordered_list),
        'Mod-Shift-8': toggleList(markdownSchema.nodes.bullet_list),
        'Mod-Shift-9': toggleBlockquote,
        'Mod-k': (state) => {
          // Swallow the browser's Ctrl+K even when there's nothing to
          // link, so focus doesn't jump to the address bar mid-edit.
          if (!state.selection.empty) onOpenLink();
          return true;
        },
        'Mod-s': () => {
          onSave();
          return true;
        },
        'Mod-Alt-p': () => {
          onOpenImage();
          return true;
        },
        'Mod-Alt-f': () => {
          onInsertDiagram();
          return true;
        },
        Enter: splitListItem(markdownSchema.nodes.list_item),
        Tab: indentListItem,
        'Shift-Tab': dedentListItem,
      }),
      keymap(baseKeymap),
    ],
  });
}

function serializeDoc(state: EditorState): string {
  let content = defaultMarkdownSerializer.serialize(state.doc);
  // The trailing paragraph the editor maintains serializes as blank
  // lines — collapse them so the file ends with a single newline.
  content = content.replace(/\n*$/, '\n');
  if (content === '\n') content = '';
  return content;
}

/**
 * WYSIWYG markdown editor for a BP's specification (its `README.md`),
 * shown on the Description tab when a copy is selected. Reads and
 * writes the copy's copy through the copy-files API; attachments
 * and embedded mermaid flowcharts live in the same copy files, so
 * the coding agent sees everything the user authored.
 */
export function SpecificationTab({ bp, copy, onShowAgents }: SpecificationTabProps) {
  const { startSession, agentStatus, ensureAgent } = useSessions();
  const [editorState, setEditorState] = useState<EditorState>();
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' });
  const [save, setSave] = useState<SaveState>({ kind: 'clean' });
  const etagRef = useRef<FileEtag>();

  // Flowchart editing state. `pos` is set when editing an existing
  // diagram; absent when inserting a new one.
  const [flowchartOpen, setFlowchartOpen] = useState(false);
  const [mermaidEditing, setMermaidEditing] = useState<{ pos?: number; source: string }>();
  const [mermaidDeletePos, setMermaidDeletePos] = useState<number>();

  const readmePath = `${bp.id}/README.md`;

  const stateRef = useRef(editorState);
  stateRef.current = editorState;
  const saveStateRef = useRef(save);
  saveStateRef.current = save;

  // The keymap's Mod-S / Mod-K / Mod-Alt-P entries are baked into the
  // editor state at creation, but their handlers depend on later state —
  // bridge with refs.
  const forceSaveRef = useRef<() => void>(() => undefined);
  const onSaveKey = useCallback(() => forceSaveRef.current(), []);
  const openLinkRef = useRef<() => void>(() => undefined);
  const onLinkKey = useCallback(() => openLinkRef.current(), []);
  const openImageRef = useRef<() => void>(() => undefined);
  const onImageKey = useCallback(() => openImageRef.current(), []);

  // Opens the flowchart modal for a new diagram (toolbar button and the
  // keymap's Mod-Alt-F both land here).
  const openNewDiagram = useCallback(() => {
    setMermaidEditing({ source: '' });
    setFlowchartOpen(true);
  }, []);

  const handleEditMermaid = useCallback((pos: number, source: string) => {
    setMermaidEditing({ pos, source });
    setFlowchartOpen(true);
  }, []);
  const handleDeleteMermaid = useCallback((pos: number) => {
    setMermaidDeletePos(pos);
  }, []);

  // Per-editor data for the node view components (the component map
  // itself must stay a stable module-level reference).
  const specContext = useMemo<SpecEditorContextValue>(
    () => ({
      copy,
      bpId: bp.id,
      onEditMermaid: handleEditMermaid,
      onDeleteMermaid: handleDeleteMermaid,
    }),
    [copy, bp.id, handleEditMermaid, handleDeleteMermaid],
  );

  useEffect(() => {
    let cancelled = false;
    setLoad({ kind: 'loading' });
    setEditorState(undefined);
    setSave({ kind: 'clean' });
    etagRef.current = undefined;
    api.copyFiles
      .content(copy, readmePath)
      .then((r) => {
        if (cancelled) return;
        if ('error' in r) {
          if (r.error === 'not-found') {
            // No README yet — start an empty document; the first save
            // creates the file.
            setEditorState(
              createSpecState('', onSaveKey, onLinkKey, onImageKey, openNewDiagram),
            );
            setLoad({ kind: 'ready' });
          } else {
            setLoad({ kind: 'error', message: `Couldn't load README.md (${r.error}).` });
          }
          return;
        }
        if (r.truncated) {
          // Editing a truncated read would silently drop the tail on save.
          setLoad({ kind: 'error', message: 'README.md is too large to edit here.' });
          return;
        }
        etagRef.current = r.etag;
        setEditorState(
          createSpecState(r.content, onSaveKey, onLinkKey, onImageKey, openNewDiagram),
        );
        setLoad({ kind: 'ready' });
      })
      .catch((err: Error) => {
        if (!cancelled) setLoad({ kind: 'error', message: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [copy, readmePath, onSaveKey, onLinkKey, onImageKey, openNewDiagram]);

  const dispatchTransaction = useCallback((tr: Transaction) => {
    setEditorState((s) => s?.apply(tr));
    if (tr.docChanged) {
      // A conflict sticks until the user resolves it (forced save or
      // reload) — autosave stays paused even as they keep typing.
      setSave((s) => (s.kind === 'conflict' ? s : { kind: 'dirty' }));
    }
  }, []);

  const doSave = useCallback(
    async (force: boolean) => {
      const state = stateRef.current;
      const current = saveStateRef.current;
      if (!state || current.kind === 'saving') return;
      const eligible =
        current.kind === 'dirty' ||
        (force && (current.kind === 'conflict' || current.kind === 'error'));
      if (!eligible) return;

      const overwrite = force && current.kind === 'conflict';
      setSave({ kind: 'saving' });
      try {
        const etag = etagRef.current;
        const r = await api.copyFiles.save(copy, readmePath, {
          content: serializeDoc(state),
          // A forced save out of conflict omits the etag: the user has
          // chosen to overwrite the on-disk version with theirs.
          ...(etag && !overwrite ? { etag } : {}),
        });
        if ('ok' in r) {
          etagRef.current = r.etag;
          // If the user kept typing while the request was in flight, the
          // state is already 'dirty' again — let autosave re-fire.
          setSave((s) => (s.kind === 'dirty' ? s : { kind: 'saved' }));
          invalidateReadme(bp.id, copy);
        } else if (r.error === 'conflict') {
          setSave({ kind: 'conflict' });
          toast.error('README.md changed on disk', {
            description:
              'Someone (or an agent) edited it since you opened this view. Click Save to overwrite with your version, or reload the page to discard your edits.',
          });
        } else {
          setSave({ kind: 'error', message: r.error });
          toast.error('Save failed', { description: r.error });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSave({ kind: 'error', message });
        toast.error('Save failed', { description: message });
      }
    },
    [copy, readmePath, bp.id],
  );
  forceSaveRef.current = () => void doSave(true);

  // Autosave: idle-debounce while dirty. `editorState` in the deps resets
  // the timer on every transaction, so the save fires AUTOSAVE_DELAY_MS
  // after the user stops typing.
  useEffect(() => {
    if (save.kind !== 'dirty') return;
    const t = setTimeout(() => void doSave(false), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(t);
  }, [save.kind, editorState, doSave]);

  // "Saved" indicator decays back to nothing after a moment.
  useEffect(() => {
    if (save.kind !== 'saved') return;
    const t = setTimeout(
      () => setSave((s) => (s.kind === 'saved' ? { kind: 'clean' } : s)),
      2000,
    );
    return () => clearTimeout(t);
  }, [save.kind]);

  // Ctrl/Cmd+click opens links in a new tab (plain click keeps editing).
  const handleEditorClick = useCallback(
    (view: EditorView, pos: number, event: MouseEvent): boolean => {
      if (!event.ctrlKey && !event.metaKey) return false;
      const $pos = view.state.doc.resolve(pos);
      const link = markdownSchema.marks.link.isInSet($pos.marks());
      const href = typeof link?.attrs.href === 'string' ? link.attrs.href : '';
      if (!href) return false;
      window.open(href, '_blank', 'noopener,noreferrer');
      return true;
    },
    [],
  );

  // ---- Mermaid block editing --------------------------------------------

  const handleFlowchartSave = useCallback(
    (mermaidSource: string) => {
      const state = stateRef.current;
      if (!state) return;
      const codeBlock = markdownSchema.nodes.code_block.create(
        { params: 'mermaid' },
        mermaidSource ? markdownSchema.text(mermaidSource) : undefined,
      );
      const pos = mermaidEditing?.pos;
      let tr: Transaction;
      if (pos !== undefined) {
        const node = state.doc.nodeAt(pos);
        tr = node
          ? state.tr.replaceWith(pos, pos + node.nodeSize, codeBlock)
          : state.tr.insert(state.doc.content.size, codeBlock);
      } else {
        const { $to } = state.selection;
        const insertPos = $to.depth > 0 ? $to.after($to.depth) : state.doc.content.size;
        tr = state.tr.insert(insertPos, codeBlock);
      }
      dispatchTransaction(tr);
      setMermaidEditing(undefined);
    },
    [mermaidEditing, dispatchTransaction],
  );

  const handleConfirmDeleteMermaid = useCallback(() => {
    const state = stateRef.current;
    const pos = mermaidDeletePos;
    setMermaidDeletePos(undefined);
    if (!state || pos === undefined) return;
    const node = state.doc.nodeAt(pos);
    if (!node) return;
    dispatchTransaction(state.tr.delete(pos, pos + node.nodeSize));
  }, [mermaidDeletePos, dispatchTransaction]);

  // "Build automation" sends the description to the coding agent: flush
  // any unsaved edits first (the agent reads README.md from disk), then
  // launch an automation-kind session and flip to the Coding Agent tab.
  const onBuildAutomation = async () => {
    void doSave(false);
    if (agentStatus === 'idle' || agentStatus === 'failed') {
      try {
        await ensureAgent();
      } catch {
        // surfaces via agentStatus; the session will still attempt to spawn
      }
    }
    startSession(copy, bp.name, 'automation');
    onShowAgents();
  };

  // ---- Render -------------------------------------------------------------

  const empty = editorState ? docIsEmpty(editorState.doc) : false;
  const saveDisabled =
    load.kind !== 'ready' || save.kind === 'clean' || save.kind === 'saved' || save.kind === 'saving';

  return (
    <div className="flex h-full flex-1 flex-col overflow-hidden bg-background">
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-white px-7 py-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-foreground">
            <span className="truncate">{bp.name}</span>
            <SaveIndicator save={save} />
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Describe your business process
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doSave(true)}
          disabled={saveDisabled}
          title={
            save.kind === 'conflict'
              ? 'Overwrite the on-disk version with yours'
              : 'Save (Ctrl+S) — edits also autosave'
          }
        >
          <Save className="size-3.5" aria-hidden />
          {save.kind === 'saving' ? 'Saving…' : save.kind === 'conflict' ? 'Overwrite' : 'Save'}
        </Button>
        <Button
          size="sm"
          onClick={() => void onBuildAutomation()}
          title="Send this description to the coding agent and open the Coding Agent tab"
        >
          <Bot className="size-3.5" aria-hidden />
          Build automation
        </Button>
      </header>

      {load.kind === 'loading' && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      )}
      {load.kind === 'error' && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {load.message}
        </div>
      )}

      {load.kind === 'ready' && editorState && (
        <SpecEditorContext.Provider value={specContext}>
          <ProseMirror
            state={editorState}
            dispatchTransaction={dispatchTransaction}
            nodeViewComponents={specNodeViewComponents}
            handleClick={handleEditorClick}
          >
            <SpecEditorToolbar
              copy={copy}
              bpId={bp.id}
              linkShortcutRef={openLinkRef}
              imageShortcutRef={openImageRef}
              onInsertDiagram={openNewDiagram}
            />
            <div className="flex-1 overflow-auto">
              <div className="spec-doc relative mx-auto mb-10 mt-6 w-full max-w-[820px] rounded-md border border-border bg-white shadow-sm">
                {empty && (
                  <div className="pointer-events-none absolute left-14 right-14 top-8 text-[15px] leading-[1.7] text-muted-foreground">
                    {PLACEHOLDER}
                  </div>
                )}
                <ProseMirrorDoc />
              </div>
            </div>
          </ProseMirror>
        </SpecEditorContext.Provider>
      )}

      <SpecAttachments bpId={bp.id} copy={copy} />

      <FlowchartEditorModal
        open={flowchartOpen}
        onOpenChange={(o) => {
          setFlowchartOpen(o);
          if (!o) setMermaidEditing(undefined);
        }}
        {...(mermaidEditing?.source ? { initialMermaid: mermaidEditing.source } : {})}
        onSave={handleFlowchartSave}
      />

      <AlertDialog
        open={mermaidDeletePos !== undefined}
        onOpenChange={(o) => !o && setMermaidDeletePos(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this diagram?</AlertDialogTitle>
            <AlertDialogDescription>
              The mermaid block is removed from the specification. You can undo
              with Ctrl+Z while the editor stays open.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                handleConfirmDeleteMermaid();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SaveIndicator({ save }: { save: SaveState }) {
  switch (save.kind) {
    case 'dirty':
      return (
        <span className="shrink-0 text-[11px] font-medium text-amber-600">
          · unsaved changes
        </span>
      );
    case 'saving':
      return (
        <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
          · saving…
        </span>
      );
    case 'saved':
      return (
        <span className="shrink-0 text-[11px] font-medium text-emerald-600">· saved</span>
      );
    case 'conflict':
      return (
        <span className="shrink-0 text-[11px] font-medium text-destructive">
          · changed on disk
        </span>
      );
    case 'error':
      return (
        <span className="shrink-0 text-[11px] font-medium text-destructive">
          · save failed
        </span>
      );
    default:
      return undefined;
  }
}
