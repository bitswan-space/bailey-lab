import { useEffect, useState, type MutableRefObject, type ReactNode } from 'react';
import {
  Bold,
  Code,
  FileCode,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Pilcrow,
  Redo2,
  TextQuote,
  Undo2,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import {
  useEditorEventCallback,
  useEditorState,
} from '@handlewithcare/react-prosemirror';
import { setBlockType, toggleMark } from 'prosemirror-commands';
import { redo, undo } from 'prosemirror-history';
import { schema as markdownSchema } from 'prosemirror-markdown';
import type { Command } from 'prosemirror-state';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  applyLink,
  blockActive,
  hasAncestor,
  insertHorizontalRule,
  insertImage,
  linkHrefAt,
  markActive,
  removeLink,
  toggleBlockquote,
  toggleCodeBlock,
  toggleHeading,
  toggleList,
} from './spec-editor-commands';
import { listSpecAttachments, type AttachmentRow } from './SpecAttachments';

interface SpecEditorToolbarProps {
  copy: string;
  bpId: string;
  /** Opens the visual flowchart editor for a new diagram. */
  onInsertDiagram: () => void;
  /** The editor's Mod-K keymap opens the link popover through this ref. */
  linkShortcutRef?: MutableRefObject<() => void>;
  /** The editor's Mod-Alt-P keymap opens the image popover through this ref. */
  imageShortcutRef?: MutableRefObject<() => void>;
  /**
   * Trailing controls pinned to the right of the toolbar (Save, Build
   * automation, the save-state indicator). The design folds the document
   * actions into the formatting toolbar rather than a separate header bar.
   */
  toolbarRight?: ReactNode;
}

/**
 * Formatting toolbar for the specification editor. Must render inside the
 * <ProseMirror> context (it drives the view via editor hooks).
 */
export function SpecEditorToolbar({
  copy,
  bpId,
  onInsertDiagram,
  linkShortcutRef,
  imageShortcutRef,
  toolbarRight,
}: SpecEditorToolbarProps) {
  const state = useEditorState();
  const { nodes, marks } = markdownSchema;

  // ---- Link popover ----
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const isLink = markActive(state, marks.link);
  const hasSelection = !state.selection.empty;

  const submitLink = useEditorEventCallback((view, href: string) => {
    applyLink(href.trim())(view.state, view.dispatch);
    view.focus();
  });
  const clearLink = useEditorEventCallback((view) => {
    removeLink(view.state, view.dispatch);
    view.focus();
  });

  const handleLinkOpenChange = (open: boolean) => {
    if (open && !hasSelection) return; // need text to link
    if (open) setLinkUrl(linkHrefAt(state) || 'https://');
    setLinkOpen(open);
  };

  // Let the editor's Mod-K shortcut open the popover. Re-registered every
  // render so the handler always sees the current selection state.
  useEffect(() => {
    if (!linkShortcutRef) return;
    linkShortcutRef.current = () => handleLinkOpenChange(true);
    return () => {
      linkShortcutRef.current = () => undefined;
    };
  });

  // ---- Image popover ----
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState('');
  const [attachments, setAttachments] = useState<AttachmentRow[]>([]);

  const doInsertImage = useEditorEventCallback((view, src: string) => {
    insertImage(src)(view.state, view.dispatch);
    view.focus();
  });

  const handleImageOpenChange = (open: boolean) => {
    setImageOpen(open);
    if (open) {
      setImageUrl('');
      // Lazy-load the picker list each open so fresh uploads show up.
      listSpecAttachments(copy, bpId)
        .then(setAttachments)
        .catch(() => setAttachments([]));
    }
  };

  // Same ref bridge as the link shortcut, for the Mod-Alt-P keymap entry.
  useEffect(() => {
    if (!imageShortcutRef) return;
    imageShortcutRef.current = () => handleImageOpenChange(true);
    return () => {
      imageShortcutRef.current = () => undefined;
    };
  });

  const imageAttachments = attachments.filter((f) =>
    /\.(jpg|jpeg|png|gif|webp)$/i.test(f.name),
  );

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={500}>
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-border bg-white px-7 py-2">
      <ToolbarButton
        icon={Heading1}
        label="Heading 1"
        shortcut="Mod-Shift-1"
        active={blockActive(state, nodes.heading, { level: 1 })}
        command={toggleHeading(1)}
      />
      <ToolbarButton
        icon={Heading2}
        label="Heading 2"
        shortcut="Mod-Shift-2"
        active={blockActive(state, nodes.heading, { level: 2 })}
        command={toggleHeading(2)}
      />
      <ToolbarButton
        icon={Heading3}
        label="Heading 3"
        shortcut="Mod-Shift-3"
        active={blockActive(state, nodes.heading, { level: 3 })}
        command={toggleHeading(3)}
      />
      <ToolbarButton
        icon={Heading4}
        label="Heading 4"
        shortcut="Mod-Shift-4"
        active={blockActive(state, nodes.heading, { level: 4 })}
        command={toggleHeading(4)}
      />
      <ToolbarButton
        icon={Pilcrow}
        label="Paragraph"
        shortcut="Mod-Shift-0"
        command={setBlockType(nodes.paragraph)}
      />
      <ToolbarDivider />
      <ToolbarButton
        icon={Bold}
        label="Bold"
        shortcut="Mod-B"
        active={markActive(state, marks.strong)}
        command={toggleMark(marks.strong)}
      />
      <ToolbarButton
        icon={Italic}
        label="Italic"
        shortcut="Mod-I"
        active={markActive(state, marks.em)}
        command={toggleMark(marks.em)}
      />
      <ToolbarButton
        icon={Code}
        label="Inline code"
        shortcut="Mod-E"
        active={markActive(state, marks.code)}
        command={toggleMark(marks.code)}
      />
      <ToolbarButton
        icon={FileCode}
        label="Code block"
        shortcut="Mod-Alt-C"
        active={blockActive(state, nodes.code_block)}
        command={toggleCodeBlock}
      />
      <ToolbarDivider />
      <ToolbarButton
        icon={List}
        label="Bullet list"
        shortcut="Mod-Shift-8"
        active={hasAncestor(state, nodes.bullet_list)}
        command={toggleList(nodes.bullet_list)}
      />
      <ToolbarButton
        icon={ListOrdered}
        label="Numbered list"
        shortcut="Mod-Shift-7"
        active={hasAncestor(state, nodes.ordered_list)}
        command={toggleList(nodes.ordered_list)}
      />
      <ToolbarButton
        icon={TextQuote}
        label="Quote"
        shortcut="Mod-Shift-9"
        active={hasAncestor(state, nodes.blockquote)}
        command={toggleBlockquote}
      />
      <ToolbarDivider />

      {/* Link popover */}
      <Popover open={linkOpen} onOpenChange={handleLinkOpenChange}>
        <ToolbarTip
          label={hasSelection ? 'Link' : 'Select text to link'}
          {...(hasSelection ? { shortcut: 'Mod-K' } : {})}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Link"
              // aria-disabled (not disabled) so the hint tooltip still
              // shows; handleLinkOpenChange refuses to open regardless.
              aria-disabled={!hasSelection && !isLink}
              onMouseDown={(e) => e.preventDefault()}
              className={toolbarButtonClass(isLink, !hasSelection && !isLink)}
            >
              <LinkIcon className="size-3.5" aria-hidden />
            </button>
          </PopoverTrigger>
        </ToolbarTip>
        <PopoverContent
          className="w-80"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="spec-link-url" className="text-sm font-medium">
                URL
              </label>
              <Input
                id="spec-link-url"
                type="url"
                placeholder="https://example.com"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    submitLink(linkUrl);
                    setLinkOpen(false);
                  }
                  if (e.key === 'Escape') setLinkOpen(false);
                }}
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              {isLink && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    clearLink();
                    setLinkOpen(false);
                  }}
                >
                  Remove
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  submitLink(linkUrl);
                  setLinkOpen(false);
                }}
              >
                {isLink ? 'Update link' : 'Add link'}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Image popover */}
      <Popover open={imageOpen} onOpenChange={handleImageOpenChange}>
        <ToolbarTip label="Insert image" shortcut="Mod-Alt-P">
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Insert image"
              onMouseDown={(e) => e.preventDefault()}
              className={toolbarButtonClass(false, false)}
            >
              <ImageIcon className="size-3.5" aria-hidden />
            </button>
          </PopoverTrigger>
        </ToolbarTip>
        <PopoverContent
          className="w-80"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="spec-image-url" className="text-sm font-medium">
                Image URL
              </label>
              <Input
                id="spec-image-url"
                type="url"
                placeholder="https://example.com/image.png"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && imageUrl.trim()) {
                    e.preventDefault();
                    doInsertImage(imageUrl.trim());
                    setImageOpen(false);
                  }
                  if (e.key === 'Escape') setImageOpen(false);
                }}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">Or pick an attachment</div>
              <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-border p-1.5">
                {imageAttachments.length > 0 ? (
                  imageAttachments.map((f) => (
                    <Button
                      key={f.path}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="w-full justify-start"
                      onClick={() => {
                        // Stored relative to the BP dir — what the agent sees.
                        doInsertImage(`attachments/${f.name}`);
                        setImageOpen(false);
                      }}
                    >
                      {f.name}
                    </Button>
                  ))
                ) : (
                  <p className="py-1.5 text-center text-sm text-muted-foreground">
                    No image attachments yet.
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                disabled={!imageUrl.trim()}
                onClick={() => {
                  doInsertImage(imageUrl.trim());
                  setImageOpen(false);
                }}
              >
                Insert image
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <ToolbarButton icon={Minus} label="Horizontal rule" command={insertHorizontalRule} />
      <ToolbarTip label="Insert flowchart" shortcut="Mod-Alt-F">
        <button
          type="button"
          aria-label="Insert flowchart"
          onMouseDown={(e) => e.preventDefault()}
          onClick={onInsertDiagram}
          className={toolbarButtonClass(false, false)}
        >
          <Workflow className="size-3.5" aria-hidden />
        </button>
      </ToolbarTip>
      <ToolbarDivider />
      <ToolbarButton
        icon={Undo2}
        label="Undo"
        shortcut="Mod-Z"
        disabled={!undo(state)}
        command={undo}
      />
      <ToolbarButton
        icon={Redo2}
        label="Redo"
        shortcut="Mod-Shift-Z"
        disabled={!redo(state)}
        command={redo}
      />
      {toolbarRight && (
        <div className="ml-auto flex items-center gap-2 pl-2">{toolbarRight}</div>
      )}
      </div>
    </TooltipProvider>
  );
}

function ToolbarDivider() {
  return <span className="mx-1 h-[18px] w-px bg-border" aria-hidden />;
}

const IS_MAC = /Mac|iP(hone|ad|od)/.test(
  typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent,
);

/** Per-key display labels for a `Mod-Shift-1`-style chord. */
function shortcutKeys(chord: string): string[] {
  return chord.split('-').map((key) => {
    switch (key) {
      case 'Mod':
        return IS_MAC ? '⌘' : 'Ctrl';
      case 'Shift':
        return IS_MAC ? '⇧' : 'Shift';
      case 'Alt':
        return IS_MAC ? '⌥' : 'Alt';
      default:
        return key.toUpperCase();
    }
  });
}

/**
 * Hover tooltip for a toolbar control: action label plus its keyboard
 * shortcut rendered as key caps. `shortcut` uses the prosemirror-keymap
 * chord syntax (`Mod-Shift-1`) so it can mirror the keymap entries.
 */
function ToolbarTip({
  label,
  shortcut,
  children,
}: {
  label: string;
  shortcut?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent className="flex items-center gap-2">
        <span>{label}</span>
        {shortcut && (
          <span className="flex items-center gap-[3px]" aria-hidden>
            {shortcutKeys(shortcut).map((key, i) => (
              <kbd
                key={i}
                className="rounded border border-zinc-600 bg-zinc-800 px-[5px] py-px font-sans text-[10px] font-medium leading-4 text-zinc-300"
              >
                {key}
              </kbd>
            ))}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function toolbarButtonClass(active: boolean, disabled: boolean): string {
  return cn(
    'flex h-[30px] w-[30px] items-center justify-center rounded-md border border-transparent text-zinc-700 transition-colors',
    active ? 'border-border bg-muted text-foreground' : 'hover:bg-muted/60',
    disabled && 'cursor-default opacity-40 hover:bg-transparent',
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  shortcut,
  command,
  active = false,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  command: Command;
  active?: boolean;
  disabled?: boolean;
}) {
  const onClick = useEditorEventCallback((view) => {
    command(view.state, view.dispatch, view);
    view.focus();
  });
  return (
    <ToolbarTip label={label} shortcut={shortcut}>
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        // Keep the editor selection: a mousedown on the button would
        // otherwise blur the contenteditable before the command runs.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        className={toolbarButtonClass(active, disabled)}
      >
        <Icon className="size-3.5" aria-hidden />
      </button>
    </ToolbarTip>
  );
}
