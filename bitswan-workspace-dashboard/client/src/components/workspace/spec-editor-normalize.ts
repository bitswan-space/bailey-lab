import type { Mark, Node as PMNode } from 'prosemirror-model';
import { Plugin, type EditorState, type Transaction } from 'prosemirror-state';
import { schema as markdownSchema } from 'prosemirror-markdown';

/**
 * Whitespace normalization for the spec editor (#205). Chrome's
 * contenteditable attaches a space typed just before a mark toggle to the
 * *following* styled span (so `New field: ` + Ctrl+E + `x` puts the space
 * inside the code mark), and inserts U+00A0 for spaces at mark boundaries.
 * The markdown serializer expels boundary whitespace from em/strong but not
 * from code, so both defects reach the saved README.
 *
 * Two entry points share one scanner:
 *  - whitespaceNormalizePlugin fixes the one thing safe to fix live:
 *    leading whitespace captured into a code run. That only moves a mark
 *    boundary — it never rewrites text.
 *  - normalizeDocForSave() additionally expels *trailing* code-run
 *    whitespace and swaps U+00A0 for plain spaces. Neither may run live:
 *    while typing `foo bar` inside inline code the just-typed space is
 *    momentarily trailing, and unmarking it would make the next keystroke
 *    continue outside the mark; and Chrome REQUIRES an nbsp for a space at
 *    the end of a line in contenteditable — swapping it live makes the
 *    browser collapse the space on the next keystroke (verified in the
 *    editor harness: live nbsp replacement silently ate every
 *    word-boundary space typed at the end of a paragraph).
 */

/** Leading/trailing space run of a code-marked text node (plain or nbsp). */
const LEADING_WS = /^[ \u00A0]+/;
const TRAILING_WS = /[ \u00A0]+$/;

interface Fixes {
  /** Ranges to strip the code mark from (whitespace expelled from a run). */
  unmarks: { from: number; to: number }[];
  /** Positions of U+00A0 characters to replace with a plain space. */
  spaces: { pos: number; marks: readonly Mark[] }[];
}

/**
 * Scan the document for whitespace defects. Code-run boundaries are detected
 * per text node against its siblings, since one styled run may be split
 * across nodes by other marks.
 */
function collectFixes(doc: PMNode, forSave: boolean): Fixes {
  const code = markdownSchema.marks.code;
  const codeBlock = markdownSchema.nodes.code_block;
  const fixes: Fixes = { unmarks: [], spaces: [] };

  doc.descendants((node, pos, parent) => {
    if (!node.isText || !node.text) return true;
    // Code blocks hold literal content — never rewrite it.
    if (parent?.type === codeBlock) return true;
    const text = node.text;

    if (code.isInSet(node.marks)) {
      const runStart = !doc.resolve(pos).nodeBefore?.marks.some(
        (m) => m.type === code,
      );
      const runEnd = !doc
        .resolve(pos + node.nodeSize)
        .nodeAfter?.marks.some((m) => m.type === code);

      let lead = 0;
      if (runStart) lead = LEADING_WS.exec(text)?.[0].length ?? 0;
      if (lead > 0) fixes.unmarks.push({ from: pos, to: pos + lead });

      if (forSave && runEnd) {
        const trail = Math.min(
          TRAILING_WS.exec(text)?.[0].length ?? 0,
          text.length - lead,
        );
        if (trail > 0) {
          fixes.unmarks.push({
            from: pos + text.length - trail,
            to: pos + text.length,
          });
        }
      }
      return true;
    }

    if (forSave) {
      for (
        let i = text.indexOf('\u00A0');
        i !== -1;
        i = text.indexOf('\u00A0', i + 1)
      ) {
        fixes.spaces.push({ pos: pos + i, marks: node.marks });
      }
    }
    return true;
  });
  return fixes;
}

/**
 * Apply collected fixes. Every fix is size-preserving (unmark, or a 1:1
 * character swap), so positions from one scan stay valid throughout.
 */
function applyFixes(tr: Transaction, fixes: Fixes): void {
  const code = markdownSchema.marks.code;
  for (const { from, to } of fixes.unmarks) tr.removeMark(from, to, code);
  for (const { pos, marks } of fixes.spaces) {
    tr.replaceWith(pos, pos + 1, markdownSchema.text(' ', marks));
  }
}

/**
 * Live half of the fix: expel leading whitespace captured into a code run as
 * it appears, so the editor styles the boundary the way it will be saved.
 * Same self-healing shape as tightListsPlugin.
 */
export const whitespaceNormalizePlugin = new Plugin({
  appendTransaction(transactions, _oldState, newState) {
    if (!transactions.some((tr) => tr.docChanged)) return undefined;
    const fixes = collectFixes(newState.doc, false);
    if (fixes.unmarks.length === 0 && fixes.spaces.length === 0) {
      return undefined;
    }
    const tr = newState.tr;
    applyFixes(tr, fixes);
    return tr;
  },
});

/**
 * Save-path half: everything the live plugin does plus trailing code-run
 * whitespace. Iterates because one pass can expose work for the next (a
 * U+00A0 expelled from a code run becomes an outside-code nbsp to swap);
 * two passes settle every real case, the bound is just a safety rail.
 */
export function normalizeDocForSave(state: EditorState): PMNode {
  const tr = state.tr;
  for (let i = 0; i < 4; i++) {
    const fixes = collectFixes(tr.doc, true);
    if (fixes.unmarks.length === 0 && fixes.spaces.length === 0) break;
    applyFixes(tr, fixes);
  }
  return tr.doc;
}
