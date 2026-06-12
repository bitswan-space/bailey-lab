import { lift, setBlockType, wrapIn } from 'prosemirror-commands';
import {
  InputRule,
  inputRules,
  textblockTypeInputRule,
  wrappingInputRule,
} from 'prosemirror-inputrules';
import { schema as markdownSchema } from 'prosemirror-markdown';
import type { Attrs, MarkType, NodeType } from 'prosemirror-model';
import { liftListItem, sinkListItem, wrapInList } from 'prosemirror-schema-list';
import { TextSelection, type Command, type EditorState } from 'prosemirror-state';

// Selection/state inspection helpers shared by the toolbar and editor.

/** True when the mark is active at the cursor or across the selection. */
export function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks ?? $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

/** True when the selection's parent block matches the node type (+ attrs). */
export function blockActive(state: EditorState, type: NodeType, attrs?: Attrs): boolean {
  const { $from, to } = state.selection;
  return to <= $from.end() && $from.parent.hasMarkup(type, attrs);
}

/** True when any ancestor of the selection start is of the node type. */
export function hasAncestor(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === type) return true;
  }
  return false;
}

/** Current link URL at the selection (or cursor), if any. */
export function linkHrefAt(state: EditorState): string {
  const { link } = markdownSchema.marks;
  const { $from, from, to, empty } = state.selection;
  if (empty) {
    const mark = link.isInSet(state.storedMarks ?? $from.marks());
    return typeof mark?.attrs.href === 'string' ? mark.attrs.href : '';
  }
  let href = '';
  state.doc.nodesBetween(from, to, (node) => {
    if (href) return false;
    const mark = link.isInSet(node.marks);
    if (mark && typeof mark.attrs.href === 'string') href = mark.attrs.href;
    return !href;
  });
  return href;
}

// Toolbar commands.

/** Heading button toggles: active heading level reverts to paragraph. */
export function toggleHeading(level: number): Command {
  return (state, dispatch, view) =>
    blockActive(state, markdownSchema.nodes.heading, { level })
      ? setBlockType(markdownSchema.nodes.paragraph)(state, dispatch, view)
      : setBlockType(markdownSchema.nodes.heading, { level })(state, dispatch, view);
}

/** Code-block button toggles back to paragraph when already active. */
export const toggleCodeBlock: Command = (state, dispatch, view) =>
  blockActive(state, markdownSchema.nodes.code_block)
    ? setBlockType(markdownSchema.nodes.paragraph)(state, dispatch, view)
    : setBlockType(markdownSchema.nodes.code_block)(state, dispatch, view);

/** List button toggles: wrap when outside, lift out when already in that list. */
export function toggleList(listType: NodeType): Command {
  return (state, dispatch, view) =>
    hasAncestor(state, listType)
      ? liftListItem(markdownSchema.nodes.list_item)(state, dispatch, view)
      : wrapInList(listType)(state, dispatch, view);
}

/** Number of list_item ancestors at the selection start (0 = not in a list). */
function listItemDepth(state: EditorState): number {
  const { $from } = state.selection;
  let count = 0;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type === markdownSchema.nodes.list_item) count++;
  }
  return count;
}

/**
 * Tab in a list indents the item one level. When it can't sink further
 * (first item, or already at max depth) the key is still consumed, so
 * Tab never falls through to the browser and moves focus out of the
 * editor mid-edit.
 */
export const indentListItem: Command = (state, dispatch, view) => {
  if (listItemDepth(state) === 0) return false;
  sinkListItem(markdownSchema.nodes.list_item)(state, dispatch, view);
  return true;
};

/**
 * Shift-Tab dedents a nested list item. Top-level items stay put — bare
 * liftListItem would lift them out of the list, splitting it in two
 * around a loose paragraph. Consumes the key whenever in a list (see
 * {@link indentListItem}).
 */
export const dedentListItem: Command = (state, dispatch, view) => {
  const depth = listItemDepth(state);
  if (depth === 0) return false;
  if (depth > 1) liftListItem(markdownSchema.nodes.list_item)(state, dispatch, view);
  return true;
};

export const toggleBlockquote: Command = (state, dispatch, view) =>
  hasAncestor(state, markdownSchema.nodes.blockquote)
    ? lift(state, dispatch, view)
    : wrapIn(markdownSchema.nodes.blockquote)(state, dispatch, view);

export const insertHorizontalRule: Command = (state, dispatch) => {
  if (dispatch) {
    dispatch(
      state.tr
        .replaceSelectionWith(markdownSchema.nodes.horizontal_rule.create())
        .scrollIntoView(),
    );
  }
  return true;
};

/** Set (or update) the link mark across the selection; empty URL removes it. */
export function applyLink(href: string): Command {
  return (state, dispatch) => {
    const { link } = markdownSchema.marks;
    const { from, to, empty } = state.selection;
    if (empty) return false;
    if (dispatch) {
      const tr = href
        ? state.tr.addMark(from, to, link.create({ href }))
        : state.tr.removeMark(from, to, link);
      dispatch(tr);
    }
    return true;
  };
}

export const removeLink: Command = (state, dispatch) => {
  const { link } = markdownSchema.marks;
  const { from, to } = state.selection;
  if (dispatch) dispatch(state.tr.removeMark(from, to, link));
  return true;
};

/** Insert an inline image node at the selection. */
export function insertImage(src: string): Command {
  return (state, dispatch) => {
    if (!src) return false;
    if (dispatch) {
      const image = markdownSchema.nodes.image.create({ src });
      dispatch(state.tr.replaceSelectionWith(image, false).scrollIntoView());
    }
    return true;
  };
}

/**
 * Mod-A inside a code block selects just the block's content. Pressing it
 * again (content already fully selected) falls through to the default
 * select-all, so the escalation is: block → whole document.
 */
export const selectCodeBlockContent: Command = (state, dispatch) => {
  const { $from, $to, from, to } = state.selection;
  if ($from.parent.type !== markdownSchema.nodes.code_block) return false;
  if (!$from.sameParent($to)) return false;
  const start = $from.start();
  const end = $from.end();
  if (from === start && to === end) return false;
  if (dispatch) {
    dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)));
  }
  return true;
};

/**
 * Markdown typing shortcuts: `# `…`#### ` headings, `> ` quote, `- `/`* `
 * bullets, `1. ` ordered lists, ` ``` ` code block, `---`/`***` rule.
 */
export function buildMarkdownInputRules() {
  const { nodes } = markdownSchema;
  return inputRules({
    rules: [
      new InputRule(/^(---|\*\*\*|___)\s$/, (state, _match, start, end) =>
        state.tr.replaceWith(start, end, nodes.horizontal_rule.create()),
      ),
      textblockTypeInputRule(/^#\s$/, nodes.heading, { level: 1 }),
      textblockTypeInputRule(/^##\s$/, nodes.heading, { level: 2 }),
      textblockTypeInputRule(/^###\s$/, nodes.heading, { level: 3 }),
      textblockTypeInputRule(/^####\s$/, nodes.heading, { level: 4 }),
      wrappingInputRule(/^>\s$/, nodes.blockquote),
      wrappingInputRule(/^-\s$/, nodes.bullet_list),
      wrappingInputRule(/^\*\s$/, nodes.bullet_list),
      wrappingInputRule(/^\d+\.\s$/, nodes.ordered_list),
      textblockTypeInputRule(/^```$/, nodes.code_block),
    ],
  });
}
