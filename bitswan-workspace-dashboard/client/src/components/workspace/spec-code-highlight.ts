import { common, createLowlight } from 'lowlight';
import { createHighlightPlugin, type Parser } from 'prosemirror-highlight';
import { createParser } from 'prosemirror-highlight/lowlight';

/**
 * Shared lowlight instance (highlight.js core + the ~37 "common"
 * grammars). Also used by the code-block language dropdown for
 * auto-detection labels.
 */
export const lowlight = createLowlight(common);

/** Languages offered in the code-block dropdown (all in lowlight's common set). */
export const CODE_LANGUAGES = [
  'bash',
  'c',
  'cpp',
  'csharp',
  'css',
  'go',
  'graphql',
  'java',
  'javascript',
  'json',
  'kotlin',
  'lua',
  'makefile',
  'markdown',
  'php',
  'python',
  'ruby',
  'rust',
  'sql',
  'swift',
  'typescript',
  'xml',
  'yaml',
];

/** Best-guess language for unlabeled code (used for the "Auto" label). */
// eslint-disable-next-line no-restricted-syntax -- undefined = no confident guess
export function detectLanguage(code: string): string | undefined {
  if (!code.trim()) return undefined;
  const result = lowlight.highlightAuto(code);
  const lang = result.data?.language;
  return typeof lang === 'string' && lang ? lang : undefined;
}

const baseParser = createParser(lowlight);

const parser: Parser = (options) => {
  // Mermaid fences render as diagrams, not code — skip them. Unknown
  // languages would make lowlight throw; render those un-highlighted.
  if (options.language === 'mermaid') return [];
  if (options.language && !lowlight.registered(options.language)) return [];
  return baseParser(options);
};

/**
 * Decoration-based syntax highlighting for code blocks. The language
 * comes from the markdown fence info (`params` attr); blocks without one
 * are auto-detected by highlight.js.
 */
export const codeHighlightPlugin = createHighlightPlugin({
  parser,
  nodeTypes: ['code_block'],
  languageExtractor: (node) => {
    const params = node.attrs.params;
    return typeof params === 'string' && params.trim() ? params.trim() : undefined;
  },
});
